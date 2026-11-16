"""Replay 站管理端點的用戶端（只用標準庫）：/admin/reset、/admin/stats、/admin/events。"""
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

OFFICIAL_HOSTS = ("mvdis.gov.tw",)


def assert_not_official(base_url: str) -> None:
    host = (urllib.parse.urlparse(base_url).hostname or "").lower()
    if any(host == h or host.endswith("." + h) for h in OFFICIAL_HOSTS):
        raise ValueError(f"REPLAY_BASE_URL 指向官網（{host}），拒絕執行")


def _req(base_url: str, path: str, method: str = "GET", body: Optional[Dict[str, Any]] = None, timeout: float = 10) -> Any:
    assert_not_official(base_url)
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("REPLAY_ADMIN_TOKEN")
    if token:
        headers["x-admin-token"] = token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base_url.rstrip("/") + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310（內網位址，由使用者設定）
        return json.loads(resp.read().decode("utf-8"))


def reset(base_url: str, **config: Any) -> Dict[str, Any]:
    return _req(base_url, "/admin/reset", "POST", config)


def stats(base_url: str) -> Dict[str, Any]:
    return _req(base_url, "/admin/stats")


def events(base_url: str, kind: Optional[str] = "released", after: int = 0, page: int = 50_000) -> List[Dict[str, Any]]:
    """把 after 之後的事件全部分頁取回。"""
    out: List[Dict[str, Any]] = []
    while True:
        q: Dict[str, Any] = {"after": after, "limit": page}
        if kind:
            q["kind"] = kind
        data = _req(base_url, "/admin/events?" + urllib.parse.urlencode(q))
        batch = data["events"]
        out.extend(batch)
        if len(batch) < page:
            return out
        after = batch[-1]["seq"]
