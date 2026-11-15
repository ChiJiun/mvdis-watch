"""E2 高可用：掃描進行中終止 AZ-a 的所有 worker／API instance，並觸發 RDS reboot with failover。

    # 乾跑：不連 AWS，只印出步驟與會影響的資源
    python e2_ha/fault_inject.py --dry-run

    # 實跑（在 bastion 上；會真的終止 instance、切換 RDS，所以必須加 --confirm）
    python e2_ha/fault_inject.py --tf-outputs outputs.json --az us-east-1a --confirm

流程：
  1. 前置檢查：RDS 必須是 Multi-AZ 且 available；列出兩個 ASG 在故障 AZ 的 instance
  2. 把 Replay 站回應延遲調高（預設 5 秒），讓一輪 360 組要跑好幾分鐘，故障才會落在「掃描進行中」
  3. 灌 360 個 target=replay 任務（同一 runId），同時啟動探針：
       - API 探針：每秒 GET <API_BASE_URL>/healthz（帶隨機參數繞過 CloudFront 快取）
       - DB 探針：每秒新開連線跑 SELECT 1（DNS 切換要新連線才看得到）
  4. --fault-after 秒後：EC2 TerminateInstances 終止故障 AZ 內兩個 ASG 的所有 instance
     （可選 --block-az：暫時把故障 AZ 的 subnet 從 ASG 移除，模擬「整個 AZ 不能用」，結束後還原）
  5. 同時（或 --rds-after 秒後）RebootDBInstance(ForceFailover=True)，每 2 秒輪詢 RDS 狀態並讀 RDS 事件
  6. 等這個 runId 全部完成，從 scan_task_log 算漏掃組數（目標 0）、重送數、各 AZ 分工、管線最長停擺
  7. 還原 Replay 延遲與 ASG subnet，寫 results/e2/<runId>.json

被終止的 instance 手上的訊息會在 SQS 可見性逾時（60 秒）後重新出現，由其他 AZ 的 worker 接手，
所以這一輪的完成時間至少會被拉長 60 秒，這是預期行為。
"""
from __future__ import annotations

import argparse
import os
import sys
import threading
import time
import urllib.request
import uuid
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from common import settings  # noqa: E402
from common.analysis import max_gap, outage_from_probe, summarize_run  # noqa: E402
from common.results import write_result  # noqa: E402
from common.tasks import build_tasks, load_combos, new_run_id, send_tasks  # noqa: E402


class Probe(threading.Thread):
    """每 interval 秒呼叫一次 check()，記錄 (epoch 秒, 成功與否, 錯誤訊息)。"""

    def __init__(self, name: str, check, interval: float = 1.0):
        super().__init__(daemon=True, name=name)
        self.check = check
        self.interval = interval
        self.samples: List[Tuple[float, bool]] = []
        self.errors: List[Tuple[float, str]] = []
        # 不能叫 _stop：會蓋掉 threading.Thread 內部的 _stop() 方法
        self._halt = threading.Event()

    def run(self) -> None:
        while not self._halt.is_set():
            t = time.time()
            try:
                self.check()
                self.samples.append((t, True))
            except Exception as e:  # noqa: BLE001（任何失敗都算中斷）
                self.samples.append((t, False))
                self.errors.append((t, f"{type(e).__name__}: {e}"[:200]))
            self._halt.wait(max(0.0, self.interval - (time.time() - t)))

    def stop(self) -> None:
        self._halt.set()


def api_check(api_url: str):
    def check() -> None:
        url = f"{api_url.rstrip('/')}/healthz?_cb={uuid.uuid4().hex[:10]}"
        with urllib.request.urlopen(url, timeout=3) as r:  # noqa: S310
            if r.status != 200:
                raise RuntimeError(f"HTTP {r.status}")

    return check


def db_check(cfg: Dict[str, Optional[str]]):
    from common.db import connect

    def check() -> None:
        conn = connect(cfg)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
        finally:
            conn.close()

    return check


def instances_in_az(asg_client: Any, names: List[str], az: str) -> Dict[str, List[str]]:
    from common.asg import asg_snapshot

    out = {}
    for n in names:
        s = asg_snapshot(asg_client, n)
        out[n] = [i["id"] for i in s["instances"] if i["az"] == az and i["state"] in ("InService", "Pending")]
    return out


def block_az(asg_client: Any, ec2: Any, names: List[str], az: str) -> Dict[str, str]:
    """把故障 AZ 的 subnet 從 ASG 移除，回傳原本的 VPCZoneIdentifier 供還原。"""
    original = {}
    for n in names:
        g = asg_client.describe_auto_scaling_groups(AutoScalingGroupNames=[n])["AutoScalingGroups"][0]
        subnets = [s for s in g["VPCZoneIdentifier"].split(",") if s]
        info = ec2.describe_subnets(SubnetIds=subnets)["Subnets"]
        keep = [s["SubnetId"] for s in info if s["AvailabilityZone"] != az]
        if not keep:
            raise SystemExit(f"{n} 只有 {az} 的 subnet，不能 --block-az")
        original[n] = g["VPCZoneIdentifier"]
        asg_client.update_auto_scaling_group(AutoScalingGroupName=n, VPCZoneIdentifier=",".join(keep))
        print(f"  {n}: 暫時移除 {az} 的 subnet，保留 {keep}")
    return original


def watch_rds(rds: Any, db_id: str, t_fault: float, timeout_s: float = 900) -> Dict[str, Any]:
    """輪詢 RDS 狀態直到回到 available 且主節點 AZ 已改變（或逾時），再讀 RDS 事件。"""
    first = rds.describe_db_instances(DBInstanceIdentifier=db_id)["DBInstances"][0]
    az_before = first.get("AvailabilityZone")
    timeline = []
    seen_not_available = False
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        d = rds.describe_db_instances(DBInstanceIdentifier=db_id)["DBInstances"][0]
        status, az = d["DBInstanceStatus"], d.get("AvailabilityZone")
        if not timeline or timeline[-1]["status"] != status or timeline[-1]["az"] != az:
            timeline.append({"t": time.time(), "status": status, "az": az})
            print(f"  RDS {status} @ {az}")
        seen_not_available = seen_not_available or status != "available"
        if seen_not_available and status == "available":
            break
        time.sleep(2)
    events = rds.describe_events(
        SourceIdentifier=db_id, SourceType="db-instance", StartTime=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t_fault - 60))
    ).get("Events", [])
    ev = [{"t": e["Date"].timestamp(), "message": e["Message"]} for e in events]
    started = next((e["t"] for e in ev if "failover started" in e["message"].lower()), None)
    completed = next((e["t"] for e in ev if "failover completed" in e["message"].lower()), None)
    return {
        "azBefore": az_before,
        "azAfter": timeline[-1]["az"] if timeline else None,
        "statusTimeline": timeline,
        "events": ev,
        "failoverSecondsFromEvents": (completed - started) if started and completed else None,
        "secondsUntilAvailable": (timeline[-1]["t"] - t_fault) if timeline else None,
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    names = ("queue_url", "worker_asg", "api_asg", "rds_id", "api_url", "replay_url", "db_host", "db_port", "db_name", "db_secret_arn")
    settings.add_arguments(p, *names)
    p.add_argument("--az", default=os.environ.get("FAULT_AZ", "us-east-1a"), help="故障 AZ，預設 us-east-1a")
    p.add_argument("--fault-after", type=float, default=30, help="灌完任務幾秒後終止 instance")
    p.add_argument("--rds-after", type=float, default=0, help="終止 instance 之後再過幾秒觸發 RDS failover（0 = 同時）")
    p.add_argument("--no-rds", action="store_true", help="只做 instance 故障，不切換 RDS")
    p.add_argument("--block-az", action="store_true", help="實驗期間把故障 AZ 的 subnet 從 ASG 移除（結束後還原）")
    p.add_argument("--replay-delay-ms", type=int, default=5000, help="實驗期間 Replay 站的回應延遲")
    p.add_argument("--post-seconds", type=float, default=60, help="全部完成後探針再跑幾秒")
    p.add_argument("--timeout", type=float, default=1200, help="等這一輪完成的上限秒數")
    p.add_argument("--run-id")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--confirm", action="store_true", help="實跑必須加：確認要終止 instance 並切換 RDS")
    a = p.parse_args(argv)

    cfg = settings.resolve(a, *names)
    run_id = a.run_id or new_run_id("e2-ha")
    combos = load_combos()
    tasks = build_tasks(run_id, len(combos), combos)

    plan = [
        f"前置檢查 RDS {cfg['rds_id'] or '<RDS_IDENTIFIER>'} 為 Multi-AZ／available",
        f"Replay {cfg['replay_url'] or '<REPLAY_BASE_URL>'} 回應延遲設為 {a.replay_delay_ms} ms",
        f"灌 {len(tasks)} 則 target=replay 任務（runId={run_id}），啟動 API／DB 探針（每秒一次）",
        f"{a.fault_after:.0f} 秒後終止 {a.az} 內 ASG {cfg['worker_asg'] or '<WORKER_ASG_NAME>'}、{cfg['api_asg'] or '<API_ASG_NAME>'} 的所有 instance"
        + ("（並暫時移除該 AZ 的 subnet）" if a.block_az else ""),
        "不切換 RDS" if a.no_rds else f"再 {a.rds_after:.0f} 秒後 RebootDBInstance(ForceFailover=True)",
        f"等 runId 完成（上限 {a.timeout:.0f}s），從 scan_task_log 算漏掃組數，探針再跑 {a.post_seconds:.0f}s",
        "還原 Replay 延遲" + ("與 ASG subnet" if a.block_az else ""),
    ]
    print("E2 步驟：")
    for i, s in enumerate(plan, 1):
        print(f"  {i}. {s}")

    if a.dry_run:
        send_tasks(cfg["queue_url"] or "", tasks, dry_run=True)
        write_result("e2", f"dry-run-{run_id}", {"dryRun": True, "runId": run_id, "az": a.az, "plan": plan})
        return 0
    if not a.confirm:
        raise SystemExit("這會真的終止 instance 並切換 RDS；確認後加 --confirm 再執行（或先用 --dry-run 看步驟）")
    settings.require(cfg, "queue_url", "worker_asg", "api_asg", "api_url", "replay_url")
    if not a.no_rds:
        settings.require(cfg, "rds_id")

    from common import replay_admin
    from common.awsclients import client
    from common.db import connect, fetch_run_rows, wait_run_finished

    asg, ec2, rds, sqs = client("autoscaling"), client("ec2"), client("rds"), client("sqs")
    if not a.no_rds:
        d = rds.describe_db_instances(DBInstanceIdentifier=cfg["rds_id"])["DBInstances"][0]
        if not d.get("MultiAZ") or d["DBInstanceStatus"] != "available":
            raise SystemExit(f"RDS 必須是 Multi-AZ 且 available（目前 MultiAZ={d.get('MultiAZ')} status={d['DBInstanceStatus']}）")

    targets = instances_in_az(asg, [cfg["worker_asg"], cfg["api_asg"]], a.az)
    print(f"故障 AZ {a.az} 內的 instance：{targets}")
    if not any(targets.values()):
        raise SystemExit(f"{a.az} 內沒有任何 ASG instance，這樣測不到 AZ 故障")

    replay_before = replay_admin.stats(cfg["replay_url"])
    replay_admin.reset(cfg["replay_url"], delayMs=a.replay_delay_ms)
    original_subnets: Dict[str, str] = {}
    api_probe = Probe("api", api_check(cfg["api_url"]))
    db_probe = Probe("db", db_check(cfg))
    result: Dict[str, Any] = {"dryRun": False, "runId": run_id, "az": a.az, "targets": targets, "plan": plan}
    try:
        api_probe.start()
        db_probe.start()
        t_enqueue = time.time()
        result["send"] = send_tasks(cfg["queue_url"], tasks, dry_run=False, sqs_client=sqs)
        time.sleep(max(0.0, t_enqueue + a.fault_after - time.time()))

        if a.block_az:
            original_subnets = block_az(asg, ec2, [cfg["worker_asg"], cfg["api_asg"]], a.az)
        ids = [i for v in targets.values() for i in v]
        t_fault = time.time()
        ec2.terminate_instances(InstanceIds=ids)
        print(f"已終止 {len(ids)} 台 instance @ {t_fault:.0f}")
        result["faultAt"] = t_fault

        if not a.no_rds:
            time.sleep(a.rds_after)
            t_rds = time.time()
            rds.reboot_db_instance(DBInstanceIdentifier=cfg["rds_id"], ForceFailover=True)
            print(f"已觸發 RDS failover @ {t_rds:.0f}")
            result["rdsFailoverAt"] = t_rds
            result["rds"] = watch_rds(rds, cfg["rds_id"], t_rds)

        # RDS 切換中舊連線會斷，這裡每次重連
        deadline = time.time() + a.timeout
        finished = False
        rows: List[Dict[str, Any]] = []
        while time.time() < deadline and not finished:
            try:
                conn = connect(cfg)
                finished = wait_run_finished(conn, run_id, len(tasks), timeout_s=max(1.0, deadline - time.time()))
                rows = fetch_run_rows(conn, run_id)
                conn.close()
            except Exception as e:  # noqa: BLE001
                print(f"  讀 scan_task_log 失敗（{e}），5 秒後重試")
                time.sleep(5)
        result["runFinished"] = finished
        time.sleep(a.post_seconds)
    finally:
        api_probe.stop()
        db_probe.stop()
        for n, v in original_subnets.items():
            asg.update_auto_scaling_group(AutoScalingGroupName=n, VPCZoneIdentifier=v)
            print(f"  {n}: 已還原 subnet")
        try:
            replay_admin.reset(cfg["replay_url"], delayMs=replay_before.get("delayMs", 500))
        except Exception as e:  # noqa: BLE001
            print(f"  還原 Replay 延遲失敗：{e}")

    summary = summarize_run(rows, combos, len(tasks))
    gap_ms, gap_at = max_gap([r["finished_at"] for r in rows if r.get("finished_at")], start=t_fault * 1000, end=summary["lastFinishedAt"])
    result.update(
        {
            "scanTaskLog": summary,
            "pipelineMaxGapSeconds": gap_ms / 1000.0,
            "pipelineMaxGapStartsAt": gap_at,
            "apiOutage": outage_from_probe(api_probe.samples, api_probe.interval),
            "dbOutage": outage_from_probe(db_probe.samples, db_probe.interval),
            "apiProbeErrors": api_probe.errors[:50],
            "dbProbeErrors": db_probe.errors[:50],
            "apiProbe": api_probe.samples,
            "dbProbe": db_probe.samples,
        }
    )
    print(
        f"漏掃組數 {summary['missingCombos']}，重送 {summary['redelivered']}，"
        f"API 最長中斷 {result['apiOutage']['longestDownS']:.0f}s，DB 最長中斷 {result['dbOutage']['longestDownS']:.0f}s，"
        f"管線最長停擺 {result['pipelineMaxGapSeconds']:.0f}s"
    )
    write_result("e2", run_id, result)
    return 0 if summary["missingCombos"] == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
