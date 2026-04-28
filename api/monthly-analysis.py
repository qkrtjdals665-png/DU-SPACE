import os
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from datetime import datetime, date


def json_response(handler, status_code, data):
    handler.send_response(status_code)
    handler.send_header("Content-type", "application/json; charset=utf-8")
    handler.end_headers()
    handler.wfile.write(json.dumps(data, ensure_ascii=False, default=str).encode("utf-8"))


def supabase_get(table_name, params):
    supabase_url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

    if not supabase_url or not service_key:
        raise Exception("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")

    query = urlencode(params, doseq=True)
    url = f"{supabase_url}/rest/v1/{table_name}?{query}"

    req = Request(url)
    req.add_header("apikey", service_key)
    req.add_header("Authorization", f"Bearer {service_key}")
    req.add_header("Content-Type", "application/json")

    with urlopen(req, timeout=20) as res:
        raw = res.read().decode("utf-8")
        return json.loads(raw) if raw else []


def get_month_range(month):
    year, month_num = map(int, month.split("-"))
    start = date(year, month_num, 1)

    if month_num == 12:
        end = date(year, 12, 31)
    else:
        next_month = date(year, month_num + 1, 1)
        end = date.fromordinal(next_month.toordinal() - 1)

    return start.isoformat(), end.isoformat()


def parse_range(query):
    month = query.get("month", [""])[0]
    from_date = query.get("from", [""])[0]
    to_date = query.get("to", [""])[0]

    if month:
        return get_month_range(month)

    if from_date and to_date:
        return from_date, to_date

    today = date.today()
    return today.replace(day=1).isoformat(), today.isoformat()


def num(value):
    try:
        return float(value or 0)
    except:
        return 0


def sum_values(rows, key):
    return sum(num(row.get(key)) for row in rows)


def group_sum(rows, key, amount_func):
    result = {}

    for row in rows:
        name = row.get(key) or "미분류"
        result[name] = result.get(name, 0) + amount_func(row)

    return sorted(
        [{"name": k, "amount": round(v)} for k, v in result.items()],
        key=lambda x: x["amount"],
        reverse=True
    )


def days_between(start_str, end_str):
    start = datetime.strptime(start_str, "%Y-%m-%d").date()
    end = datetime.strptime(end_str, "%Y-%m-%d").date()
    return (end - start).days + 1


def allocate_product_ad_costs(rows, from_date, to_date):
    range_start = datetime.strptime(from_date, "%Y-%m-%d").date()
    range_end = datetime.strptime(to_date, "%Y-%m-%d").date()

    allocated = []

    for row in rows:
        start_str = row.get("start_date")
        end_str = row.get("end_date")
        total_cost = num(row.get("total_cost"))

        if not start_str or not end_str:
            row["allocated_cost"] = total_cost
            allocated.append(row)
            continue

        start = datetime.strptime(start_str, "%Y-%m-%d").date()
        end = datetime.strptime(end_str, "%Y-%m-%d").date()

        overlap_start = max(start, range_start)
        overlap_end = min(end, range_end)

        if overlap_start > overlap_end:
            allocated_cost = 0
            overlap_days = 0
        else:
            total_days = (end - start).days + 1
            overlap_days = (overlap_end - overlap_start).days + 1
            allocated_cost = round(total_cost * overlap_days / total_days) if total_days > 0 else 0

        safe_row = dict(row)
        safe_row["allocated_cost"] = allocated_cost
        safe_row["allocation_days"] = overlap_days
        allocated.append(safe_row)

    return allocated


def safe_orders(rows):
    safe = []

    for row in rows:
        safe.append({
            "id": row.get("id"),
            "platform": row.get("platform"),
            "order_date": row.get("order_date"),
            "product": row.get("product"),
            "option": row.get("option"),
            "quantity": row.get("quantity"),
            "price": row.get("price"),
            "delivery_fee": row.get("delivery_fee"),
            "created_at": row.get("created_at"),
        })

    return safe


def safe_cash_transactions(rows):
    safe = []

    for row in rows:
        safe.append({
            "id": row.get("id"),
            "account_id": row.get("account_id"),
            "tx_date": row.get("tx_date"),
            "tx_time": row.get("tx_time"),
            "deposit": row.get("deposit"),
            "withdraw": row.get("withdraw"),
            "balance_after": row.get("balance_after"),
            "memo": row.get("memo"),
            "counterparty": row.get("counterparty"),
            "bank_tx_type": row.get("bank_tx_type"),
            "category": row.get("category"),
            "sub_category": row.get("sub_category"),
            "is_auto_categorized": row.get("is_auto_categorized"),
            "is_confirmed": row.get("is_confirmed"),
            "rule_id": row.get("rule_id"),
        })

    return safe


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            parsed_url = urlparse(self.path)
            query = parse_qs(parsed_url.query)

            token = query.get("token", [""])[0]
            secret_token = os.environ.get("AI_ANALYSIS_TOKEN")

            if not secret_token or token != secret_token:
                return json_response(self, 401, {
                    "ok": False,
                    "message": "Unauthorized"
                })

            from_date, to_date = parse_range(query)

            orders = supabase_get("orders", [
                ("select", "*"),
                ("order_date", f"gte.{from_date}"),
                ("order_date", f"lte.{to_date}"),
                ("order", "order_date.asc")
            ])

            cash_transactions = supabase_get("cash_transactions", [
                ("select", "*"),
                ("tx_date", f"gte.{from_date}"),
                ("tx_date", f"lte.{to_date}"),
                ("order", "tx_date.asc")
            ])

            ad_costs = supabase_get("ad_costs", [
                ("select", "*"),
                ("ad_date", f"gte.{from_date}"),
                ("ad_date", f"lte.{to_date}"),
                ("order", "ad_date.asc")
            ])

            product_ad_costs_raw = supabase_get("product_ad_costs", [
                ("select", "*"),
                ("start_date", f"lte.{to_date}"),
                ("end_date", f"gte.{from_date}"),
                ("order", "start_date.asc")
            ])

            product_costs = supabase_get("product_costs", [
                ("select", "*")
            ])

            categorization_rules = supabase_get("categorization_rules", [
                ("select", "*")
            ])

            product_ad_costs = allocate_product_ad_costs(product_ad_costs_raw, from_date, to_date)

            total_order_sales = sum(num(row.get("price")) * num(row.get("quantity") or 1) for row in orders)
            total_delivery_fee = sum_values(orders, "delivery_fee")
            order_count = len(orders)
            total_quantity = sum(num(row.get("quantity")) for row in orders)
            average_order_value = round(total_order_sales / order_count) if order_count else 0

            total_deposit = sum_values(cash_transactions, "deposit")
            total_withdraw = sum_values(cash_transactions, "withdraw")
            net_cashflow = total_deposit - total_withdraw

            daily_ad_cost_total = sum_values(ad_costs, "cost")
            product_ad_cost_total = sum(num(row.get("allocated_cost")) for row in product_ad_costs)
            total_ad_cost = daily_ad_cost_total + product_ad_cost_total
            roas = round(total_order_sales / total_ad_cost, 2) if total_ad_cost else None

            sales_by_product = group_sum(
                orders,
                "product",
                lambda row: num(row.get("price")) * num(row.get("quantity") or 1)
            )

            sales_by_date = group_sum(
                orders,
                "order_date",
                lambda row: num(row.get("price")) * num(row.get("quantity") or 1)
            )

            expense_by_category = group_sum(
                cash_transactions,
                "category",
                lambda row: num(row.get("withdraw"))
            )

            expense_by_sub_category = group_sum(
                cash_transactions,
                "sub_category",
                lambda row: num(row.get("withdraw"))
            )

            income_by_counterparty = group_sum(
                [row for row in cash_transactions if num(row.get("deposit")) > 0],
                "counterparty",
                lambda row: num(row.get("deposit"))
            )

            expense_by_counterparty = group_sum(
                [row for row in cash_transactions if num(row.get("withdraw")) > 0],
                "counterparty",
                lambda row: num(row.get("withdraw"))
            )

            return json_response(self, 200, {
                "ok": True,
                "message": "디유스페이스 월간 분석 데이터 조회 성공",
                "range": {
                    "from": from_date,
                    "to": to_date
                },
                "summary": {
                    "sales": {
                        "total_order_sales": round(total_order_sales),
                        "total_delivery_fee": round(total_delivery_fee),
                        "order_count": order_count,
                        "total_quantity": round(total_quantity),
                        "average_order_value": average_order_value,
                        "daily_ad_cost_total": round(daily_ad_cost_total),
                        "product_ad_cost_total": round(product_ad_cost_total),
                        "total_ad_cost": round(total_ad_cost),
                        "roas": roas
                    },
                    "cashflow": {
                        "total_deposit": round(total_deposit),
                        "total_withdraw": round(total_withdraw),
                        "net_cashflow": round(net_cashflow)
                    },
                    "life_goal_base": {
                        "debt_name": "새출발기금",
                        "debt_balance_estimate": 17000000,
                        "kb_savings_fixed_cost_account_estimate": 14000000,
                        "nh_shipping_account_estimate": 2600000,
                        "securities_etf_estimate": 2000000,
                        "securities_monthly_investment": 500000,
                        "hana_main_account_estimate": 1000000
                    }
                },
                "breakdowns": {
                    "sales_by_product": sales_by_product,
                    "sales_by_date": sales_by_date,
                    "expense_by_category": expense_by_category,
                    "expense_by_sub_category": expense_by_sub_category,
                    "income_by_counterparty_top20": income_by_counterparty[:20],
                    "expense_by_counterparty_top30": expense_by_counterparty[:30]
                },
                "data": {
                    "orders": safe_orders(orders),
                    "cash_transactions": safe_cash_transactions(cash_transactions),
                    "ad_costs": ad_costs,
                    "product_ad_costs": product_ad_costs,
                    "product_costs": product_costs,
                    "categorization_rules": categorization_rules
                },
                "analysis_instruction": {
                    "required_sections": [
                        "📊 재무: 입금/출금/순현금흐름/소비패턴",
                        "🎯 사업: 매출/상품별 매출/광고비/ROAS/택배비/상품 전략",
                        "🌱 인생 목표: 새출발기금, ETF 적립, 독립 준비, 내집 타임라인 영향",
                        "✅ 다음 액션 3개"
                    ],
                    "cautions": [
                        "네이버파이낸셜은 개인/사업 지출이 섞일 수 있으므로 메모와 카테고리 기준으로 보수적으로 판단",
                        "product_ad_costs는 allocated_cost 기준으로 반영",
                        "주소, 전화번호, 수령인 등 개인정보는 분석에 사용하지 않음"
                    ]
                }
            })

        except HTTPError as e:
            error_body = e.read().decode("utf-8")
            return json_response(self, 500, {
                "ok": False,
                "message": "Supabase HTTPError",
                "status": e.code,
                "error": error_body
            })

        except URLError as e:
            return json_response(self, 500, {
                "ok": False,
                "message": "Supabase URLError",
                "error": str(e)
            })

        except Exception as e:
            return json_response(self, 500, {
                "ok": False,
                "message": "Server Error",
                "error": str(e)
            })
