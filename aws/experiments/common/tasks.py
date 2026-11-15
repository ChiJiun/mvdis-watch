"""ScanTask 的建立、守門與送進 SQS（契約第 4 節、aws/shared/contracts.ts）。

守門規則（不能用參數關掉）：
- target 必須是 "replay"。對官網的請求率由 dispatcher 控制在每分鐘 14 次，實驗腳本絕不送 live 任務。
- runId 必須是非空字串，量測與漏掃檢查都靠它。
"""
from __future__ import annotations

import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, Iterable, List, Optional

CONTRACT_VERSION = 1
# 和 aws/shared/contracts.ts 的 ScanTask 欄位一一對應；tests/test_tasks.py 會比對 TS 原始碼
SCAN_TASK_KEYS = ("v", "taskId", "licenseType", "lv1", "dmvNo", "tier", "target", "runId", "enqueuedAt")

_HERE = os.path.dirname(os.path.abspath(__file__))
COMBOS_FILE = os.path.join(_HERE, "combos.json")

SQS_BATCH_MAX = 10


class TargetGuardError(ValueError):
    """任務不是 target=replay（或缺 runId）時丟出，呼叫端不得送出任何訊息。"""


def load_catalogue() -> Dict[str, Any]:
    with open(COMBOS_FILE, encoding="utf-8") as f:
        return json.load(f)


def load_combos() -> List[Dict[str, Any]]:
    """360 個「照類 × 監理站」組合，每筆含 licenseType、lv1、dmvNo、hot。"""
    return load_catalogue()["combos"]


def new_run_id(prefix: str) -> str:
    """例如 e3-n4-20261116T013000Z-1a2b；只用 [a-z0-9-]，方便當檔名。"""
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    return f"{prefix}-{ts}-{uuid.uuid4().hex[:4]}"


def assert_replay(task: Dict[str, Any]) -> None:
    if task.get("target") != "replay":
        raise TargetGuardError(f"實驗腳本只能送 target=replay 的任務，收到 target={task.get('target')!r}")
    run_id = task.get("runId")
    if not isinstance(run_id, str) or not run_id.strip():
        raise TargetGuardError("實驗任務必須帶非空的 runId")
    if task.get("v") != CONTRACT_VERSION:
        raise TargetGuardError(f"契約版本必須是 {CONTRACT_VERSION}")
    if set(task.keys()) != set(SCAN_TASK_KEYS):
        raise TargetGuardError(f"欄位和 ScanTask 不符：{sorted(task.keys())}")


def make_task(combo: Dict[str, Any], run_id: str, enqueued_at: Optional[int] = None) -> Dict[str, Any]:
    """建立一則 replay 任務。刻意不提供 target 參數。"""
    task = {
        "v": CONTRACT_VERSION,
        "taskId": str(uuid.uuid4()),
        "licenseType": combo["licenseType"],
        "lv1": combo["lv1"],
        "dmvNo": combo["dmvNo"],
        "tier": "hot" if combo.get("hot") else "cold",
        "target": "replay",
        "runId": run_id,
        "enqueuedAt": int(enqueued_at if enqueued_at is not None else time.time() * 1000),
    }
    assert_replay(task)
    return task


def build_tasks(run_id: str, count: int, combos: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    """依序輪流 360 組產生 count 則任務（3,600 = 每組 10 次），taskId 各自唯一、runId 相同。"""
    combos = combos if combos is not None else load_combos()
    if count < 1:
        raise ValueError("count 必須 >= 1")
    return [make_task(combos[i % len(combos)], run_id) for i in range(count)]


def chunked(items: List[Any], size: int) -> Iterable[List[Any]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def send_tasks(
    queue_url: str,
    tasks: List[Dict[str, Any]],
    *,
    dry_run: bool,
    concurrency: int = 16,
    sqs_client: Any = None,
    log: Callable[[str], None] = print,
) -> Dict[str, Any]:
    """用 SendMessageBatch（每批 10 則）平行送出；送出前逐則守門，enqueuedAt 改成實際送出的時間。"""
    for t in tasks:
        assert_replay(t)
    batches = list(chunked(tasks, SQS_BATCH_MAX))
    t0 = time.time()
    if dry_run:
        log(f"[dry-run] 會送 {len(tasks)} 則 target=replay 任務（{len(batches)} 批）到 {queue_url or '<未設定 SCAN_QUEUE_URL>'}")
        log(f"[dry-run] 範例訊息：{json.dumps(tasks[0], ensure_ascii=False)}")
        return {"sent": 0, "failed": 0, "planned": len(tasks), "batches": len(batches), "seconds": 0.0, "dryRun": True}

    if not queue_url:
        raise ValueError("缺少 SCAN_QUEUE_URL（--queue-url 或 terraform output scan_queue_url）")
    if sqs_client is None:
        from common.awsclients import client

        sqs_client = client("sqs")

    def send_batch(batch: List[Dict[str, Any]]) -> int:
        pending = {str(i): t for i, t in enumerate(batch)}
        for attempt in range(4):
            now = int(time.time() * 1000)
            entries = []
            for i, t in pending.items():
                t["enqueuedAt"] = now
                assert_replay(t)
                entries.append({"Id": i, "MessageBody": json.dumps(t, separators=(",", ":"))})
            resp = sqs_client.send_message_batch(QueueUrl=queue_url, Entries=entries)
            failed = {f["Id"] for f in resp.get("Failed", [])}
            pending = {i: t for i, t in pending.items() if i in failed}
            if not pending:
                return 0
            time.sleep(0.2 * (2**attempt))
        return len(pending)

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        failed = sum(pool.map(send_batch, batches))
    secs = time.time() - t0
    log(f"已送出 {len(tasks) - failed} 則（失敗 {failed}），耗時 {secs:.1f}s")
    return {"sent": len(tasks) - failed, "failed": failed, "planned": len(tasks), "batches": len(batches), "seconds": secs, "dryRun": False}
