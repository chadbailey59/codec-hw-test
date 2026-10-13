"""Static file server plus a small results collector for the codec hardware test.

POST /api/results  stores one JSON submission (max 1 MB) in data/results.jsonl.
GET  /api/results  returns every stored submission as a JSON array.
Everything else is served from site/.
"""

import json
import os
import threading
import time
import uuid
from collections import defaultdict, deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE_DIR = os.path.join(ROOT, "site")
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(ROOT, "data"))
RESULTS_FILE = os.path.join(DATA_DIR, "results.jsonl")
PORT = int(os.environ.get("PORT", "8080"))
MAX_BODY = 1_000_000
# Per-client submission limit, to keep a stuck or abusive client from filling the disk.
RATE_LIMIT = 20
RATE_WINDOW_S = 3600

write_lock = threading.Lock()
recent = defaultdict(deque)


def client_ip(handler):
    return handler.headers.get("CF-Connecting-IP") or handler.client_address[0]


def rate_limited(ip):
    now = time.time()
    q = recent[ip]
    while q and now - q[0] > RATE_WINDOW_S:
        q.popleft()
    if len(q) >= RATE_LIMIT:
        return True
    q.append(now)
    return False


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE_DIR, **kwargs)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/results":
            rows = []
            if os.path.exists(RESULTS_FILE):
                with open(RESULTS_FILE) as f:
                    rows = [json.loads(line) for line in f if line.strip()]
            return self.send_json(200, rows)
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/results":
            return self.send_json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self.send_json(413, {"error": "body must be 1 byte to 1 MB"})
        if rate_limited(client_ip(self)):
            return self.send_json(429, {"error": "too many submissions, try again later"})
        try:
            submission = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            return self.send_json(400, {"error": "invalid JSON"})
        if not isinstance(submission, dict) or "results" not in submission:
            return self.send_json(400, {"error": "missing results"})
        record = {"id": uuid.uuid4().hex[:12], "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **submission}
        os.makedirs(DATA_DIR, exist_ok=True)
        with write_lock, open(RESULTS_FILE, "a") as f:
            f.write(json.dumps(record) + "\n")
        return self.send_json(200, {"id": record["id"]})

    def log_message(self, fmt, *args):
        print(f"{client_ip(self)} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"serving {SITE_DIR} on :{PORT}, results in {RESULTS_FILE}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
