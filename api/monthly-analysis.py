import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
from datetime import datetime

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed_url = urlparse(self.path)
        query = parse_qs(parsed_url.query)

        token = query.get("token", [""])[0]
        secret_token = os.environ.get("AI_ANALYSIS_TOKEN")

        if not secret_token or token != secret_token:
            self.send_response(401)
            self.send_header("Content-type", "application/json; charset=utf-8")
            self.end_headers()
            response = {
                "ok": False,
                "message": "Unauthorized"
            }
            self.wfile.write(json.dumps(response, ensure_ascii=False).encode("utf-8"))
            return

        self.send_response(200)
        self.send_header("Content-type", "application/json; charset=utf-8")
        self.end_headers()

        response = {
            "ok": True,
            "message": "디유스페이스 AI 분석 API 연결 성공",
            "date": datetime.now().isoformat()
        }

        self.wfile.write(json.dumps(response, ensure_ascii=False).encode("utf-8"))
