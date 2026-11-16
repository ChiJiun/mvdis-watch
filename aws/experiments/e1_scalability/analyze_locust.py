"""E1：把 Locust 的 stats history CSV（＋API ASG 監看 CSV）整理成每一階的 p95、RPS、失敗率、台數。

    python e1_scalability/analyze_locust.py --history results/e1/locust_stats_history.csv \
        --asg results/e1/api-asg.csv --name e1-api-20261120

Locust 的 history 每秒一列，Aggregated 列的百分位數是最近約 10 秒的滾動值。
每一階只取「後半段」的列，避開剛加壓、ASG 還沒擴容的暫態；階梯邊界由 User Count 變化判斷。
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from common.analysis import percentile  # noqa: E402
from common.results import write_result  # noqa: E402


def _f(x: str) -> Optional[float]:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def load_history(path: str) -> List[Dict[str, Any]]:
    with open(path, encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if r.get("Name") == "Aggregated"]
    out = []
    for r in rows:
        out.append(
            {
                "t": _f(r["Timestamp"]),
                "users": int(_f(r["User Count"]) or 0),
                "rps": _f(r["Requests/s"]) or 0.0,
                "fps": _f(r["Failures/s"]) or 0.0,
                "p50": _f(r.get("50%", "")),
                "p95": _f(r.get("95%", "")),
                "p99": _f(r.get("99%", "")),
            }
        )
    return out


def load_asg(path: Optional[str]) -> List[Dict[str, float]]:
    if not path or not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [{"t": float(r["t"]), "desired": float(r["desired"]), "inService": float(r["inService"])} for r in csv.DictReader(f)]


def steps_from_history(hist: List[Dict[str, Any]], asg: List[Dict[str, float]]) -> List[Dict[str, Any]]:
    """依 User Count 切階：加壓中的人數是連續爬升的，停留 10 秒以上的人數才算一階，再取該階後半段。"""
    steps: List[Dict[str, Any]] = []
    counts: Dict[int, List[Dict[str, Any]]] = {}
    for r in hist:
        counts.setdefault(r["users"], []).append(r)
    plateau = sorted(u for u, rs in counts.items() if u > 0 and len(rs) >= 10)
    for u in plateau:
        rs = counts[u]
        rs = rs[len(rs) // 2 :]
        p95s = [r["p95"] for r in rs if r["p95"] is not None]
        t0, t1 = rs[0]["t"], rs[-1]["t"]
        in_step = [a for a in asg if t0 - 30 <= a["t"] <= t1]
        rps = sum(r["rps"] for r in rs) / len(rs)
        fps = sum(r["fps"] for r in rs) / len(rs)
        steps.append(
            {
                "users": u,
                "samples": len(rs),
                "p95Ms": percentile(p95s, 50),  # 後半段滾動 p95 的中位數
                "p95MaxMs": max(p95s) if p95s else None,
                "rps": rps,
                "failureRate": (fps / rps) if rps else 0.0,
                "apiInService": max((a["inService"] for a in in_step), default=None),
            }
        )
    return steps


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--history", required=True, help="Locust --csv 產生的 *_stats_history.csv")
    p.add_argument("--asg", help="monitor_asg.py 的輸出")
    p.add_argument("--name", default="e1-api")
    p.add_argument("--dry-run", action="store_true", help="結果標記為乾跑（例如用 stub_api 跑出來的 CSV）")
    a = p.parse_args(argv)
    hist = load_history(a.history)
    asg = load_asg(a.asg)
    steps = steps_from_history(hist, asg)
    for s in steps:
        print(f"  {s['users']:>5} 人  p95={s['p95Ms']}ms  rps={s['rps']:.1f}  失敗率={s['failureRate']:.2%}  API 台數={s['apiInService']}")
    timeline = [{"t": r["t"], "users": r["users"], "p95": r["p95"], "rps": r["rps"]} for r in hist]
    write_result("e1", a.name, {"dryRun": a.dry_run, "steps": steps, "timeline": timeline, "asgTimeline": asg})
    return 0


if __name__ == "__main__":
    sys.exit(main())
