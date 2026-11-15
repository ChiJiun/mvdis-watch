"""讀 RDS 的 scan_task_log／slot_event（psycopg 3，延遲 import）。

連線優先序和 worker 相同（契約第 3 節）：DATABASE_URL > DB_HOST + DB_SECRET_ARN。
RDS 在 private subnet，這些函式要在 bastion（或 VPC 內其他主機）上執行。
"""
from __future__ import annotations

import json
import os
import time
from typing import Any, Callable, Dict, List, Optional

RUN_ROWS_SQL = """
SELECT task_id::text, run_id, license_type, dmv_no, tier, target,
       enqueued_at, started_at, finished_at, outcome, error, worker_id, az, receive_count
FROM scan_task_log WHERE run_id = %s
"""

RELEASED_SQL = """
SELECT license_type, dmv_no, exam_date::text, sec_key, at
FROM slot_event WHERE run_id = %s AND kind = 'released'
"""


def connect(settings: Dict[str, Optional[str]]) -> Any:
    import psycopg  # noqa: WPS433

    url = os.environ.get("DATABASE_URL")
    if url:
        return psycopg.connect(url, connect_timeout=3, autocommit=True)
    host = settings.get("db_host")
    secret_arn = settings.get("db_secret_arn")
    if not host or not secret_arn:
        raise SystemExit("缺少資料庫設定：DATABASE_URL，或 DB_HOST＋DB_SECRET_ARN（terraform output rds_endpoint / db_secret_arn）")
    from common.awsclients import client

    secret = json.loads(client("secretsmanager").get_secret_value(SecretId=secret_arn)["SecretString"])
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
            cur.execute("SELECT count(*) FROM scan_task_log WHERE run_id = %s AND finished_at IS NOT NULL", (run_id,))
            done = cur.fetchone()[0]
        if done != last:
            log(f"  {run_id}: 已完成 {done}/{expected_tasks}")
            last = done
        if done >= expected_tasks:
            return True
        time.sleep(poll_s)
    return False
