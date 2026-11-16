"""E1 擴展性（API 端）：Locust 加壓期間，每 15 秒記錄 API ASG 的 desired／InService 台數到 CSV。

    python e1_scalability/monitor_asg.py --tf-outputs outputs.json --out results/e1/api-asg.csv
    （另開一個終端機跑 Locust；Ctrl-C 結束）

    python e1_scalability/monitor_asg.py --dry-run   不連 AWS，印出會監看哪個 ASG
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from common import settings  # noqa: E402


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    settings.add_arguments(p, "api_asg")
    p.add_argument("--out", default=os.path.join("results", "e1", "api-asg.csv"))
    p.add_argument("--interval", type=float, default=15)
    p.add_argument("--max-seconds", type=float, default=4 * 3600)
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    cfg = settings.resolve(a, "api_asg")

    if a.dry_run:
        print(f"[dry-run] 會每 {a.interval}s 記錄 ASG {cfg['api_asg'] or '<未設定 API_ASG_NAME>'} 到 {a.out}")
        return 0
    settings.require(cfg, "api_asg")
    from common.asg import asg_snapshot
    from common.awsclients import client

    asg = client("autoscaling")
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    t0 = time.time()
    with open(a.out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["t", "desired", "inService", "instances"])
        try:
            while time.time() - t0 < a.max_seconds:
                s = asg_snapshot(asg, cfg["api_asg"])
                w.writerow([f"{time.time():.1f}", s["desired"], s["inService"], len(s["instances"])])
                f.flush()
                print(f"  desired={s['desired']} inService={s['inService']}")
                time.sleep(a.interval)
        except KeyboardInterrupt:
            pass
    print(f"已寫入 {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
