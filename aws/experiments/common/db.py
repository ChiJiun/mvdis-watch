"""讀 RDS 的 scan_task_log 與 replay schema（psycopg 3，延遲 import）。

連線優先序和 worker 相同（契約第 3 節）：DATABASE_URL > DB_HOST + DB_SECRET_ARN。
RDS 在 private subnet：執行這些函式的主機必須連得到 `rds_endpoint:5432`。
預定的實驗主機是 bastion，但 main 目前的 infra 只讓 API-SG、Worker-SG 連 RDS（`rds_from_app`），
要等 infra 後續 PR 新增 `rds_from_bastion`（以及 Replay 用的 `replay_from_bastion`）規則才行；詳見 aws/experiments/README.md「執行環境」。

資料隔離（契約 §7.3）：replay 任務的 slot／slot_event／scan_log 在 `replay` schema；
實驗只讀寫 `replay.*`，任務量測讀 `public.scan_task_log WHERE target = 'replay'`。
這個模組裡沒有任何 SQL 會碰 public 的 slot／slot_event／scan_log（測試會檢查）。
"""
from __future__ import annotations

import json
import os
import time
from typing import Any, Callable, Dict, List, Optional

RUN_ROWS_SQL = """
SELECT task_id::text, run_id, license_type, dmv_no, tier, target,
       enqueued_at, started_at, committed_at, finished_at, outcome, error, worker_id, az, receive_count
FROM public.scan_task_log WHERE run_id = %s AND target = 'replay'
"""

RELEASED_SQL = """
SELECT license_type, dmv_no, exam_date::text, sec_key, at
FROM replay.slot_event WHERE run_id = %s AND kind = 'released'
"""

FINISHED_COUNT_SQL = """
SELECT count(*) FROM public.scan_task_log WHERE run_id = %s AND target = 'replay' AND finished_at IS NOT NULL
"""

# 實驗前清空 replay schema 的三張表（契約 §7.3，擁有者為 replay 線）。只動 replay schema，絕不碰 public。
REPLAY_TABLES = ("replay.slot", "replay.slot_event", "replay.scan_log")
TRUNCATE_REPLAY_SQL = f"TRUNCATE {', '.join(REPLAY_TABLES)} RESTART IDENTITY"

LOCK_TIMEOUT_SQL = "SET lock_timeout = '30s'"

ALL_SQL = (RUN_ROWS_SQL, RELEASED_SQL, FINISHED_COUNT_SQL, TRUNCATE_REPLAY_SQL)

_SECRET_CACHE: Dict[str, Dict[str, Any]] = {}


def _db_secret(secret_arn: str) -> Dict[str, Any]:
    """帳密只向 Secrets Manager 取一次（E2 的 DB 探針每秒重連，不該每次都打 Secrets Manager）。"""
    if secret_arn not in _SECRET_CACHE:
        from common.awsclients import client

        _SECRET_CACHE[secret_arn] = json.loads(client("secretsmanager").get_secret_value(SecretId=secret_arn)["SecretString"])
    return _SECRET_CACHE[secret_arn]


def connect(settings: Dict[str, Optional[str]]) -> Any:
    import psycopg  # noqa: WPS433

    url = os.environ.get("DATABASE_URL")
    if url:
        return psycopg.connect(url, connect_timeout=3, autocommit=True)
    host = settings.get("db_host")
    secret_arn = settings.get("db_secret_arn")
    if not host or not secret_arn:
        raise SystemExit("缺少資料庫設定：DATABASE_URL，或 DB_HOST＋DB_SECRET_ARN（terraform output rds_endpoint / db_secret_arn）")
    secret = _db_secret(secret_arn)
    return psycopg.connect(
        host=host.split(":")[0],
        port=int(settings.get("db_port") or 5432),
        dbname=settings.get("db_name") or "mvdis",
        user=secret["username"],
        password=secret["password"],
        connect_timeout=3,
        autocommit=True,
    )


def _rows(conn: Any, sql: str, params: tuple) -> List[Dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def fetch_run_rows(conn: Any, run_id: str) -> List[Dict[str, Any]]:
    return _rows(conn, RUN_ROWS_SQL, (run_id,))


def fetch_released(conn: Any, run_id: str) -> List[Dict[str, Any]]:
    return _rows(conn, RELEASED_SQL, (run_id,))


def truncate_replay_tables(conn: Any) -> None:
    """清空 replay.slot／replay.slot_event／replay.scan_log（只有 replay schema）。

    TRUNCATE 要拿 ACCESS EXCLUSIVE 鎖；worker 若還有交易握著 replay 表，設 lock_timeout 讓它報錯而不是無限等待。
    """
    with conn.cursor() as cur:
        cur.execute(LOCK_TIMEOUT_SQL)
        try:
            cur.execute(TRUNCATE_REPLAY_SQL)
        finally:
            cur.execute("RESET lock_timeout")


def reset_replay_db(cfg: Dict[str, Optional[str]], *, dry_run: bool, skip: bool = False, log: Callable[[str], None] = print) -> bool:
    """實驗前清空 replay schema；dry-run 只印出 SQL。回傳是否真的清空。"""
    if skip:
        log("略過清空 replay schema（--keep-replay-db）")
        return False
    if dry_run:
        log(f"[dry-run] 會執行：{TRUNCATE_REPLAY_SQL}")
        return False
    conn = connect(cfg)
    try:
        truncate_replay_tables(conn)
    finally:
        conn.close()
    log(f"已清空 {', '.join(REPLAY_TABLES)}")
    return True


def wait_run_finished(
    conn: Any,
    run_id: str,
    expected_tasks: int,
    *,
    timeout_s: float,
    poll_s: float = 5.0,
    log: Callable[[str], None] = print,
) -> bool:
    """輪詢直到這個 runId 有 expected_tasks 列 finished_at 不為空，或逾時。"""
    deadline = time.time() + timeout_s
    last = -1
    while time.time() < deadline:
        with conn.cursor() as cur:
            cur.execute(FINISHED_COUNT_SQL, (run_id,))
            done = cur.fetchone()[0]
        if done != last:
            log(f"  {run_id}: 已完成 {done}/{expected_tasks}")
            last = done
        if done >= expected_tasks:
            return True
        time.sleep(poll_s)
    return False
