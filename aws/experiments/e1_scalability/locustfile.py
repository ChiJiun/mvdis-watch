"""E1 擴展性：對公開 API 從 50 階梯加壓到 2,000 併發使用者。

    locust -f e1_scalability/locustfile.py --headless --host "$API_BASE_URL" \
        --csv results/e1/locust --csv-full-history --processes -1

環境變數：
    E1_STEPS            階梯的使用者數，預設 50,100,250,500,1000,1500,2000
    E1_STEP_SECONDS     每階停留秒數，預設 180（ASG 擴容約需 3–5 分鐘，太短看不到擴容效果）
    E1_SPAWN_RATE       每秒新增使用者數，預設 50
    E1_CACHE_BUST_RATIO 帶隨機查詢參數繞過 CloudFront 快取的比例，預設 1.0
                        （CloudFront cache policy 會把 query string 放進快取鍵；設 0 可量「有快取」的情境）
    E1_WAIT_MIN/MAX     每個使用者兩次請求之間的等待秒數，預設 1–3

使用者行為依原型儀表板的實際呼叫比例設計：首頁載入 meta＋available＋overview，
其餘是查單站、單一組合與事件流。
"""
from __future__ import annotations

import json
import os
import random
import uuid

from locust import FastHttpUser, LoadTestShape, between, task

COMBOS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "common", "combos.json")
with open(COMBOS_FILE, encoding="utf-8") as _f:
    _CAT = json.load(_f)
STATIONS = [s["no"] for s in _CAT["stations"]]
LICENSES = [t["code"] for t in _CAT["licenseTypes"]]
HOT_LICENSES = [t["code"] for t in _CAT["licenseTypes"] if t["hot"]]

STEPS = [int(x) for x in os.environ.get("E1_STEPS", "50,100,250,500,1000,1500,2000").split(",") if x.strip()]
STEP_SECONDS = int(os.environ.get("E1_STEP_SECONDS", "180"))
SPAWN_RATE = float(os.environ.get("E1_SPAWN_RATE", "50"))
CACHE_BUST = float(os.environ.get("E1_CACHE_BUST_RATIO", "1.0"))
WAIT_MIN = float(os.environ.get("E1_WAIT_MIN", "1"))
WAIT_MAX = float(os.environ.get("E1_WAIT_MAX", "3"))


def _bust(params: dict) -> dict:
    if random.random() < CACHE_BUST:
        params = dict(params, _cb=uuid.uuid4().hex[:12])
    return params


class DashboardUser(FastHttpUser):
    wait_time = between(WAIT_MIN, WAIT_MAX)

    def _get(self, path: str, name: str, **params: str) -> None:
        with self.client.get(path, params=_bust(params), name=name, catch_response=True) as r:
            if r.status_code != 200:
                r.failure(f"HTTP {r.status_code}")

    @task(3)
    def home(self) -> None:
        self._get("/api/meta", "/api/meta")
        self._get("/api/available", "/api/available", licenseType=random.choice(HOT_LICENSES))
        self._get("/api/overview", "/api/overview")

    @task(3)
    def station(self) -> None:
        self._get("/api/station", "/api/station", dmvNo=random.choice(STATIONS))

    @task(2)
    def slots(self) -> None:
        self._get("/api/slots", "/api/slots", licenseType=random.choice(LICENSES), dmvNo=random.choice(STATIONS))

    @task(1)
    def events(self) -> None:
        self._get("/api/events", "/api/events", kind="released", limit="80")


class StepShape(LoadTestShape):
    """依 E1_STEPS 階梯加壓，最後一階結束後停止。"""

    def tick(self):
        t = self.get_run_time()
        idx = int(t // STEP_SECONDS)
        if idx >= len(STEPS):
            return None
        return STEPS[idx], SPAWN_RATE
