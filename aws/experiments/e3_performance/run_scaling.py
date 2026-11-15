"""E3 效能：依序把 worker ASG 釘在 1/2/4/8 台，各掃一輪 360 組 replay 任務，算耗時、speedup 與偵測延遲。

    # 乾跑：不連 AWS，只印出每一階會做什麼
    python e3_performance/run_scaling.py --dry-run

    # 實跑（在 bastion 上）
    python e3_performance/run_scaling.py --tf-outputs outputs.json --workers 1,2,4,8

每一階 n：
  1. worker ASG 設為 min=max=desired=n，等 InService 剛好 n 台，再等 --settle 秒讓 worker 程式起來
  2. Replay 重設（同一個 seed、不擾動），灌一輪「暖身」360 組，讓資料庫的 slot 和 Replay 初始狀態一致
  3. Replay 再重設成同一個 seed（狀態和暖身時相同），開啟 clock 擾動：每 --tick-ms 隨機釋位 --flips-per-tick 個場次
  4. 灌量測輪 360 組（runId = <prefix>-n<n>），等 scan_task_log 全部完成
  5. 耗時 = 最後 finished_at − 最早 enqueued_at；偵測延遲 = Replay 釋位時間 → worker 寫入 slot_event(released) 的時間
結束後把 ASG 還原成原本的 min/max/desired。

注意：量測期間請暫停 dispatcher 的 EventBridge 規則（README 有指令），否則每分鐘 14 則排程任務會和量測任務搶 worker。
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Any, Dict, List

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from common import settings  # noqa: E402
from common.analysis import detection_latency, speedup_table, summarize_run  # noqa: E402
from common.results import write_result  # noqa: E402
from common.tasks import build_tasks, load_combos, new_run_id, send_tasks  # noqa: E402


def parse_workers(s: str) -> List[int]:
    ns = [int(x) for x in s.split(",") if x.strip()]
    if not ns or any(n < 1 for n in ns):
        raise argparse.ArgumentTypeError("--workers 必須是正整數清單，例如 1,2,4,8")
    return ns


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    names = ("queue_url", "worker_asg", "replay_url", "db_host", "db_port", "db_name", "db_secret_arn")
    settings.add_arguments(p, *names)
    p.add_argument("--workers", type=parse_workers, default=[1, 2, 4, 8])
    p.add_argument("--seed", type=int, default=20261116)
    p.add_argument("--replay-delay-ms", type=int, default=500, help="Replay 回應延遲（模擬官網）")
    p.add_argument("--replay-jitter-ms", type=int, default=250)
    p.add_argument("--tick-ms", type=int, default=1000, help="量測輪的 clock 擾動間隔；0 = 不量偵測延遲")
    p.add_argument("--flips-per-tick", type=int, default=2)
    p.add_argument("--no-warmup", action="store_true", help="跳過暖身輪（偵測延遲會失真，只量耗時時可用）")
    p.add_argument("--settle", type=float, default=60, help="InService 之後再等幾秒讓 worker 程式起來")
    p.add_argument("--round-timeout", type=float, default=3600)
    p.add_argument("--prefix", help="runId 前綴，預設 e3-<時間>")
    p.add_argument("--force", action="store_true", help="佇列不是空的也照跑")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)

    cfg = settings.resolve(a, *names)
    combos = load_combos()
    prefix = a.prefix or new_run_id("e3")

    print(f"E3 前綴 {prefix}，台數 {a.workers}")
    for n in a.workers:
        print(f"  n={n}: ASG {cfg['worker_asg'] or '<WORKER_ASG_NAME>'} → {n} 台；"
              f"{'暖身 360 組；' if not a.no_warmup else ''}量測 360 組（runId={prefix}-n{n}），"
              f"Replay 延遲 {a.replay_delay_ms}±{a.replay_jitter_ms} ms，clock 擾動 {a.flips_per_tick}/{a.tick_ms}ms")
    if a.dry_run:
        send_tasks(cfg["queue_url"] or "", build_tasks(f"{prefix}-n{a.workers[0]}", len(combos), combos), dry_run=True)
        write_result("e3", f"dry-run-{prefix}", {"dryRun": True, "prefix": prefix, "workers": a.workers})
        return 0

    settings.require(cfg, "queue_url", "worker_asg", "replay_url")
    from common import replay_admin
    from common.asg import asg_snapshot, queue_depth, restore_capacity, set_fixed_capacity, wait_in_service
    from common.awsclients import client
    from common.db import connect, fetch_released, fetch_run_rows, wait_run_finished

    asg, sqs = client("autoscaling"), client("sqs")
    q = queue_depth(sqs, cfg["queue_url"])
    if (q["visible"] or q["inFlight"]) and not a.force:
        raise SystemExit(f"佇列不是空的（{q}），量測會失真；清空後再跑，或加 --force")
    original = asg_snapshot(asg, cfg["worker_asg"])
    conn = connect(cfg)
    rounds: List[Dict[str, Any]] = []
    base_cfg = {"seed": a.seed, "flipProb": 0, "delayMs": a.replay_delay_ms, "jitterMs": a.replay_jitter_ms}

    try:
        for n in a.workers:
            print(f"\n== n={n} ==")
            set_fixed_capacity(asg, cfg["worker_asg"], n)
            if not wait_in_service(asg, cfg["worker_asg"], n):
                raise SystemExit(f"ASG 沒有在時限內到達 {n} 台")
            time.sleep(a.settle)

            if not a.no_warmup:
                replay_admin.reset(cfg["replay_url"], **base_cfg, tickMs=0)
                warm = f"{prefix}-n{n}-warm"
                send_tasks(cfg["queue_url"], build_tasks(warm, len(combos), combos), dry_run=False, sqs_client=sqs)
                if not wait_run_finished(conn, warm, len(combos), timeout_s=a.round_timeout):
                    raise SystemExit(f"暖身輪 {warm} 逾時")

            replay_admin.reset(cfg["replay_url"], **base_cfg, tickMs=a.tick_ms, flipsPerTick=a.flips_per_tick)
            run_id = f"{prefix}-n{n}"
            send = send_tasks(cfg["queue_url"], build_tasks(run_id, len(combos), combos), dry_run=False, sqs_client=sqs)
            ok = wait_run_finished(conn, run_id, len(combos), timeout_s=a.round_timeout)
            summary = summarize_run(fetch_run_rows(conn, run_id), combos, len(combos))
            rnd: Dict[str, Any] = {"workers": n, "runId": run_id, "finished": ok, "send": send, "scanTaskLog": summary}
            if a.tick_ms > 0 and not a.no_warmup:
                flips = [f for f in replay_admin.events(cfg["replay_url"], kind="released") if f["cause"] == "clock"]
                rnd["detection"] = detection_latency(flips, fetch_released(conn, run_id), window_end_ms=summary["lastFinishedAt"])
            d = summary["durationMs"]
            rnd["estimatedDetectionLatencyMs"] = {"worst": d, "mean": d / 2 if d else None}
            print(f"  n={n}: 耗時 {d} ms，漏掃 {summary['missingCombos']}，偵測 {rnd.get('detection')}")
            rounds.append(rnd)
    finally:
        restore_capacity(asg, original)
        print(f"已還原 ASG {original['name']}：min={original['min']} max={original['max']} desired={original['desired']}")
        try:
            replay_admin.reset(cfg["replay_url"], **base_cfg, tickMs=0)
        except Exception as e:  # noqa: BLE001
            print(f"還原 Replay 失敗：{e}")

    table = speedup_table({r["workers"]: r["scanTaskLog"]["durationMs"] for r in rounds if r["scanTaskLog"]["durationMs"]})
    for row in table:
        print(f"  {row['workers']} 台：{row['durationMs'] / 1000:.1f}s，speedup {row['speedup']:.2f}（理想 {row['idealSpeedup']:.0f}），效率 {row['efficiency']:.0%}")
    write_result("e3", prefix, {"dryRun": False, "prefix": prefix, "config": {k: v for k, v in vars(a).items()}, "rounds": rounds, "speedup": table})
    return 0


if __name__ == "__main__":
    sys.exit(main())
