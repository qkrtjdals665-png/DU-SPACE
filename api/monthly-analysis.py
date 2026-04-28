import os
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from datetime import datetime


TABLES = [
    "ad_costs",
    "bank_accounts",
    "cash_transactions",
    "categorization_rules",
    "orders",
    "product_ad_costs",
    "product_costs",
    "transactions",
]


def json_response(handler, status_code, data):
    handler.send_response(status_code)
    handler.send_header("Content-type", "application/json; charset=utf-8")
    handler.end_headers()
    handler.wfile.write(json.dumps(data, ensure_ascii=False, default=str).encode("utf-8"))


def fetch_supabase_table(table_name, limit=5):
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

    if not supabase_url or not service_key:
        return {
            "ok": False,
            "error": "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
        }

    query = urlencode({
        "select": "*",
        "limit": str(limit)
    })

    url = f"{supabase_url}/rest/v1/{table_name}?{query}"

    req = Request(url)
    req.add_header("apikey", service_key)
    req.add_header("Authorization", f"Bearer {service_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urlopen(req, timeout=10) as res:
            raw = res.read().decode("utf-8")
            rows = json.loads(raw) if raw else []

            columns = []
            if rows and isinstance(rows, list) and isinstance(rows[0], dict):
                columns = list(rows[0].keys())

            return {
                "ok": True,
                "table": table_name,
                "sample_count": len(rows),
                "columns": columns,
                "sample_rows": rows,
            }

    except HTTPError as e:
        error_body = e.read().decode("utf-8")
        return {
            "ok": False,
            "table": table_name,
            "status": e.code,
            "error": error_body,
        }

    except URLError as e:
        return {
            "ok": False,
            "table": table_name,
            "error": str(e),
        }

    except Exception as e:
        return {
            "ok": False,
            "table": table_name,
            "error": str(e),
        }


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed_url = urlparse(self.path)
        query = parse_qs(parsed_url.query)

        token = query.get("token", [""])[0]
        secret_token = os.environ.get("AI_ANALYSIS_TOKEN")

        if not secret_token or token != secret_token:
            return json_response(self, 401, {
                "ok": False,
                "message": "Unauthorized"
            })

        table_results = {}

        for table in TABLES:
            table_results[table] = fetch_supabase_table(table, limit=5)

        return json_response(self, 200, {
            "ok": True,
            "message": "Supabase 연결 및 테이블 샘플 조회 완료",
            "date": datetime.now().isoformat(),
            "tables": table_results,
            "next_step": "이 응답을 ChatGPT에 보내면 실제 4월 매출/입출금 분석용 코드로 업그레이드 가능"
        })
