"""Auto Scaling／SQS 的監看與調整（E1、E3 共用）。"""
from __future__ import annotations

import time
from typing import Any, Callable, Dict, List, Optional


def asg_snapshot(asg_client: Any, name: str) -> Dict[str, Any]:
    g = asg_client.describe_auto_scaling_groups(AutoScalingGroupNames=[name])["AutoScalingGroups"]
    if not g:
        raise SystemExit(f"找不到 ASG {name}")
    g = g[0]
    inst = g.get("Instances", [])
    return {
        "name": name,
        "min": g["MinSize"],
        "max": g["MaxSize"],
        "desired": g["DesiredCapacity"],
        "inService": sum(1 for i in inst if i["LifecycleState"] == "InService"),
        "instances": [{"id": i["InstanceId"], "az": i["AvailabilityZone"], "state": i["LifecycleState"], "health": i["HealthStatus"]} for i in inst],
    }


def queue_depth(sqs_client: Any, queue_url: str) -> Dict[str, int]:
    attrs = sqs_client.get_queue_attributes(
        QueueUrl=queue_url,
        AttributeNames=["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"],
    )["Attributes"]
    return {
        "visible": int(attrs.get("ApproximateNumberOfMessages", 0)),
        "inFlight": int(attrs.get("ApproximateNumberOfMessagesNotVisible", 0)),
        "delayed": int(attrs.get("ApproximateNumberOfMessagesDelayed", 0)),
    }


def set_fixed_capacity(asg_client: Any, name: str, n: int) -> None:
    """E3：把 ASG 釘在 n 台（min=max=desired），避免 target tracking 在量測中途擴縮。"""
    asg_client.update_auto_scaling_group(AutoScalingGroupName=name, MinSize=n, MaxSize=n, DesiredCapacity=n)


def restore_capacity(asg_client: Any, snap: Dict[str, Any]) -> None:
    asg_client.update_auto_scaling_group(
        AutoScalingGroupName=snap["name"], MinSize=snap["min"], MaxSize=snap["max"], DesiredCapacity=snap["desired"]
    )


def wait_in_service(
    asg_client: Any,
    name: str,
    n: int,
    *,
    timeout_s: float = 900,
    poll_s: float = 10,
    log: Callable[[str], None] = print,
) -> bool:
    """等到 InService 剛好 n 台且沒有其他狀態的 instance（縮容時要等多的那幾台真的離開）。"""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        s = asg_snapshot(asg_client, name)
        others = [i for i in s["instances"] if i["state"] != "InService"]
        log(f"  {name}: InService {s['inService']}/{n}，其他狀態 {len(others)}")
        if s["inService"] == n and not others:
            return True
        time.sleep(poll_s)
    return False


def monitor_loop(
    sample: Callable[[], Dict[str, Any]],
    *,
    interval_s: float,
    stop: Callable[[Dict[str, Any], List[Dict[str, Any]]], bool],
    max_s: Optional[float] = None,
    log: Callable[[str], None] = print,
) -> List[Dict[str, Any]]:
    """每 interval_s 取樣一次，直到 stop(最新樣本, 全部樣本) 為真或超過 max_s。"""
    rows: List[Dict[str, Any]] = []
    t0 = time.time()
    while True:
        s = sample()
        s["t"] = time.time()
        rows.append(s)
        log("  " + ", ".join(f"{k}={v}" for k, v in s.items() if k != "t"))
        if stop(s, rows) or (max_s is not None and time.time() - t0 > max_s):
            return rows
        time.sleep(interval_s)
