from http.server import BaseHTTPRequestHandler
import json, io, base64

try:
    import msoffcrypto
except ImportError:
    msoffcrypto = None

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            req = json.loads(body)

            file_b64 = req.get('file', '')
            password = req.get('password', '900520')

            if not file_b64:
                return self._json(400, {'error': 'no file'})

            if not msoffcrypto:
                return self._json(500, {'error': 'msoffcrypto not installed'})

            file_bytes = base64.b64decode(file_b64)

            try:
                f = io.BytesIO(file_bytes)
                ms = msoffcrypto.OfficeFile(f)
                ms.load_key(password=password)
                decrypted = io.BytesIO()
                ms.decrypt(decrypted)
                decrypted_b64 = base64.b64encode(decrypted.getvalue()).decode('ascii')
                return self._json(200, {'decrypted': decrypted_b64})
            except Exception as e:
                return self._json(400, {'error': str(e)})

        except Exception as e:
            return self._json(500, {'error': str(e)})

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def _json(self, status, data):
        self.send_response(status)
        self._cors_headers()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def _cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
