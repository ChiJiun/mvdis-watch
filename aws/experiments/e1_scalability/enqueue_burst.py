"""E1 擴展性（佇列端）：一次灌 3,600 個 target=replay 的 ScanTask（同一 runId）到 SQS，
並監看佇列深度與 worker ASG 台數，直到佇列清空、scan_task_log 全部完成。

    # 乾跑：不連 AWS，只印出會送什麼
    python e1_scalability/enqueue_burst.py --dry-run

    # 實跑（在 bastion 上）
    python e1_scalability/enqueue_burst.py --tf-outputs outputs.json --count 3600 --watch

量測：
    - 佇列清空時間：第一則送出 → visible＋inFlight 都歸零
    - 每 15 秒一筆：visible、inFlight、worker ASG desired／InService
    - scan_task_log：全部完成的耗時、漏掃組數、各 worker／AZ 分工
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from common import settings  # noqa: E402
from common.analysis import summarize_run  # noqa: E402
from common.db import reset_replay_db  # noqa: E402（psycopg 在 connect 內才 import）
from common.results import results_dir, write_result  # noqa: E402
from common.tasks import build_tasks, load_combos, new_run_id, send_tasks  # noqa: E402


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    settings.add_arguments(p, "queue_url", "worker_asg", "db_host", "db_port", "db_name", "db_secret_arn")
    p.add_argument("--count", type=int, default=3600, help="任務數，預設 3600（360 組 × 10）")
    p.add_argument("--run-id", help="預設自動產生 e1-burst-<時間>")
    p.add_argument("--concurrency", type=int, default=16, help="平行送出的 SendMessageBatch 數")
    p.add_argument("--watch", action="store_true", help="送完後監看到佇列清空並讀 scan_task_log")
    p.add_argument("--interval", type=float, default=15)
    p.add_argument("--timeout", type=float, default=3600, help="監看上限秒數")
    p.add_argument(
        "--truncate-replay-db",
        action="store_true",
        help="送任務前清空 replay schema（E1 不讀 replay 表，預設不清，避免清掉同時在跑的 E3 資料）",
    )
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)

    cfg = settings.resolve(a, "queue_url", "worker_asg", "db_host", "db_port", "db_name", "db_secret_arn")
    run_id = a.run_id or new_run_id("e1-burst")
    combos = load_combos()
    tasks = build_tasks(run_id, a.count, combos)
    print(f"runId = {run_id}，{len(tasks)} 則任務，涵蓋 {len({(t['licenseType'], t['dmvNo']) for t in tasks})} 組")

    has_db = bool(cfg["db_host"] or os.environ.get("DATABASE_URL"))
    if a.dry_run:
        if a.truncate_replay_db:
            reset_replay_db(cfg, dry_run=True)
        send = send_tasks(cfg["queue_url"] or "", tasks, dry_run=True)
        write_result("e1", f"dry-run-{run_id}", {"dryRun": True, "runId": run_id, "send": send})
        return 0

    settings.require(cfg, "queue_url")
    from common.asg import asg_snapshot, monitor_loop, queue_depth
    from common.awsclients import client

    sqs = client("sqs")
    asg = client("autoscaling") if cfg["worker_asg"] else None
    before = queue_depth(sqs, cfg["queue_url"])
    if before["visible"] or before["inFlight"]:
        print(f"注意：佇列裡原本就有 {before} 則訊息，清空時間會被拉長")

    # E1 只讀 scan_task_log，不讀 replay 表，所以預設不清；明確要求時才清
    if a.truncate_replay_db:
        if not has_db:
            raise SystemExit("--truncate-replay-db 需要資料庫設定（DATABASE_URL，或 DB_HOST＋DB_SECRET_ARN）")
        print("注意：即將清空 replay schema，若同時有 E2／E3 在跑，它們的 replay 資料會被清掉")
        reset_replay_db(cfg, dry_run=False)

    t0 = time.time()
    send = send_tasks(cfg["queue_url"], tasks, dry_run=False, concurrency=a.concurrency, sqs_client=sqs)
    result = {"dryRun": False, "runId": run_id, "count": a.count, "queueBefore": before, "send": send, "startedAt": t0}

    if a.watch:
        def sample():
            q = queue_depth(sqs, cfg["queue_url"])
            row = {**q}
            if asg:
                s = asg_snapshot(asg, cfg["worker_asg"])
                row.update({"desired": s["desired"], "inService": s["inService"]})
            return row

        rows = monitor_loop(
            sample,
            interval_s=a.interval,
            stop=lambda s, _rows: s["visible"] == 0 and s["inFlight"] == 0 and s["delayed"] == 0,
            max_s=a.timeout,
        )
        drained = rows[-1]["visible"] == 0 and rows[-1]["inFlight"] == 0
        result["queueDrainSeconds"] = (rows[-1]["t"] - t0) if drained else None
        result["peakInService"] = max((r.get("inService", 0) for r in rows), default=None)
        result["timeline"] = rows
        csv_path = os.path.join(results_dir(), "e1", f"{run_id}-queue.csv")
        os.makedirs(os.path.dirname(csv_path), exist_ok=True)
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=sorted({k for r in rows for k in r}))
            w.writeheader()
            w.writerows(rows)

        if has_db:
            from common.db import connect, fetch_run_rows, wait_run_finished

            conn = connect(cfg)
            wait_run_finished(conn, run_id, a.count, timeout_s=300)
            result["scanTaskLog"] = summarize_run(fetch_run_rows(conn, run_id), combos, a.count)

    write_result("e1", run_id, result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
