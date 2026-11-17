"""本地演示服务：静态页面 + /api/search。"""

from __future__ import annotations

import json
import mimetypes
import platform
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__
from .adapters import AdapterError
from .pipeline import run_search

WEB_ROOT = Path(__file__).resolve().parent.parent / "web"


class Handler(BaseHTTPRequestHandler):
    server_version = f"PriceHunter/{__version__}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        return

    def _send(self, status: int, body: bytes, content_type: str, cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _search(self, params: dict) -> None:
        keyword = str(params.get("keyword") or params.get("q") or "").strip()
        source = str(params.get("source") or "demo")
        endpoint = params.get("endpoint") or None
        try:
            limit = int(params.get("limit") or 28)
        except (TypeError, ValueError):
            self._json(400, {"error": "limit 必须是整数"})
            return
        if not keyword:
            self._json(400, {"error": "缺少 keyword 参数"})
            return
        try:
            result = run_search(keyword, source=source, limit=limit, endpoint=endpoint)
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
            return
        except AdapterError as exc:
            self._json(502, {"error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001 - 服务端兜底
            self._json(500, {"error": f"服务端异常：{exc}"})
            return
        self._json(200, result)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/api/health":
            self._json(
                200,
                {
                    "ok": True,
                    "engine": "python",
                    "version": __version__,
                    "python": platform.python_version(),
                    "adapters": ["demo", "api"],
                },
            )
            return

        if path == "/api/search":
            query = parse_qs(parsed.query)
            self._search({key: values[0] for key, values in query.items()})
            return

        self._serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path != "/api/search":
            self._send(405, b"Method Not Allowed", "text/plain; charset=utf-8")
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(400, {"error": "请求体必须是 JSON"})
            return
        if not isinstance(payload, dict):
            self._json(400, {"error": "请求体必须是 JSON 对象"})
            return

        params = {key: values[0] for key, values in parse_qs(parsed.query).items()}
        params.update(payload)
        self._search(params)

    def _serve_static(self, path: str) -> None:
        relative = path.lstrip("/") or "index.html"
        root = WEB_ROOT.resolve()
        target = (root / relative).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            self._send(403, b"Forbidden", "text/plain; charset=utf-8")
            return

        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            self._send(404, "404 Not Found".encode("utf-8"), "text/plain; charset=utf-8")
            return

        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {
            "application/javascript",
            "application/json",
            "image/svg+xml",
        }:
            content_type += "; charset=utf-8"
        self._send(200, target.read_bytes(), content_type)


def serve(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = False) -> None:
    if not (WEB_ROOT / "index.html").is_file():
        raise RuntimeError(f"找不到演示页面：{WEB_ROOT / 'index.html'}")

    httpd = None
    actual_port = port
    for candidate in range(port, port + 20):
        try:
            httpd = ThreadingHTTPServer((host, candidate), Handler)
            actual_port = candidate
            break
        except OSError:
            continue
    if httpd is None:
        raise RuntimeError(f"端口 {port}–{port + 19} 均不可用")

    display_host = "localhost" if host in ("127.0.0.1", "0.0.0.0") else host
    url = f"http://{display_host}:{actual_port}/"
    print(f"PriceHunter 演示服务已启动")
    print(f"  页面  {url}")
    print(f"  API   {url}api/search?keyword=%E5%8C%85%E5%8C%85&limit=28")
    print("  Ctrl+C 停止")
    sys.stdout.flush()

    if open_browser:
        webbrowser.open(url)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()
