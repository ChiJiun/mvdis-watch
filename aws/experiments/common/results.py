"""實驗結果的落地：aws/experiments/results/<實驗>/<runId>.json（results/ 不進 git）。"""
from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, Optional

RESULTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "results")


def results_dir() -> str:
    """結果根目錄；EXPERIMENTS_RESULTS_DIR 可覆寫（測試時寫到暫存目錄，不弄髒 results/）。"""
    return os.environ.get("EXPERIMENTS_RESULTS_DIR") or RESULTS_DIR


def write_result(experiment: str, name: str, data: Dict[str, Any], out_dir: Optional[str] = None) -> str:
    out_dir = out_dir or results_dir()
    d = os.path.join(out_dir, experiment)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{name}.json")
    payload = {"experiment": experiment, "writtenAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **data}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, default=str)
    print(f"結果已寫入 {path}")
    return path
