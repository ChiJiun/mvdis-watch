"""實驗需要的 AWS 輸出值：CLI 參數 > 環境變數 > `terraform output -json` 檔。

用法：在 aws/infra 執行 `terraform output -json > ../experiments/outputs.json`，
各腳本加 `--tf-outputs outputs.json` 就能自動帶入下表的值。
"""
from __future__ import annotations

import argparse
import json
import os
from typing import Any, Dict, Optional

# 設定名稱 → (環境變數, terraform output 名稱, 說明)
FIELDS: Dict[str, tuple] = {
    "queue_url": ("SCAN_QUEUE_URL", "scan_queue_url", "SQS mvdis-scan 佇列 URL"),
    "dlq_url": ("SCAN_DLQ_URL", "scan_dlq_url", "SQS mvdis-scan-dlq URL"),
    "worker_asg": ("WORKER_ASG_NAME", "worker_asg_name", "worker ASG 名稱"),
    "api_asg": ("API_ASG_NAME", "api_asg_name", "API ASG 名稱"),
    "rds_id": ("RDS_IDENTIFIER", "rds_identifier", "RDS DB instance identifier（E2 強制切換）"),
    "api_url": ("API_BASE_URL", "cloudfront_url", "公開 API 入口（CloudFront；ALB 只收帶 X-Origin-Verify 的請求）"),
    "replay_url": ("REPLAY_BASE_URL", "replay_base_url", "Replay 站內網位址，例如 http://10.0.10.200:8080"),
    "db_host": ("DB_HOST", "rds_endpoint", "RDS 端點"),
    "db_port": ("DB_PORT", "rds_port", "RDS port"),
    "db_name": ("DB_NAME", "db_name", "資料庫名稱"),
    "db_secret_arn": ("DB_SECRET_ARN", "db_secret_arn", "Secrets Manager 的 DB 帳密"),
}


def add_arguments(p: argparse.ArgumentParser, *names: str) -> None:
    p.add_argument("--tf-outputs", help="terraform output -json 的輸出檔")
    for n in names:
        env, tf, desc = FIELDS[n]
        p.add_argument(f"--{n.replace('_', '-')}", dest=n, help=f"{desc}（環境變數 {env}／terraform output {tf}）")


def _tf_value(outputs: Dict[str, Any], key: str) -> Optional[str]:
    v = outputs.get(key)
    if isinstance(v, dict) and "value" in v:  # terraform output -json 的格式
        v = v["value"]
    return None if v is None else str(v)


def resolve(args: argparse.Namespace, *names: str) -> Dict[str, Optional[str]]:
    outputs: Dict[str, Any] = {}
    if getattr(args, "tf_outputs", None):
        with open(args.tf_outputs, encoding="utf-8") as f:
            outputs = json.load(f)
    out: Dict[str, Optional[str]] = {}
    for n in names:
        env, tf, _ = FIELDS[n]
        out[n] = getattr(args, n, None) or os.environ.get(env) or _tf_value(outputs, tf)
    return out


def require(values: Dict[str, Optional[str]], *names: str) -> None:
    missing = [n for n in names if not values.get(n)]
    if missing:
        hints = ", ".join(f"{n}（{FIELDS[n][0]} / {FIELDS[n][1]}）" for n in missing)
        raise SystemExit(f"缺少設定：{hints}")
