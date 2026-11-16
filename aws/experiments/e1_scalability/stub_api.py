"""本機乾跑用的假 API：只回 200 與小段 JSON，讓 locustfile 不連 AWS 也能跑一次。

    python e1_scalability/stub_api.py --port 8099
"""
from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PATHS = {"/api/meta", "/api/available", "/api/overview", "/api/station", "/api/slots", "/api/events", "/healthz"}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        status = 200 if path in PATHS else 404
        body = json.dumps({"ok": status == 200, "path": path}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, max-age=30")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args) -> None:  # noqa: A002（覆寫標準庫簽名）
        del format, args


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8099)
    a = p.parse_args()
    print(f"stub API on http://127.0.0.1:{a.port}")
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
