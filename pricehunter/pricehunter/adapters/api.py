"""通用 JSON API 数据源。

用于对接已授权的数据服务、内部采集中台或官方开放平台代理服务。
接口约定：``GET {endpoint}?q=<keyword>&limit=<n>`` 返回 ``{"items": [...]}``
（也接受直接返回数组），字段与 DemoAdapter 的原始字段一致即可。
"""

from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .base import Adapter, AdapterError

REQUIRED_KEYS = ("title", "price")


class ApiAdapter(Adapter):
    name = "api"
    label = "JSON API"

    def __init__(self, endpoint: str, timeout: float = 10.0) -> None:
        endpoint = (endpoint or "").strip()
        if not endpoint:
            raise AdapterError("使用 api 数据源时必须提供 endpoint")
        self.endpoint = endpoint
        self.timeout = timeout

    def search(self, keyword: str, limit: int = 28) -> list[dict]:
        separator = "&" if "?" in self.endpoint else "?"
        url = f"{self.endpoint}{separator}{urlencode({'q': keyword, 'limit': limit})}"
        request = Request(
            url,
            headers={"Accept": "application/json", "User-Agent": "PriceHunter/1.0"},
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise AdapterError(f"API 数据源请求失败：{exc}") from exc

        items = payload.get("items") if isinstance(payload, dict) else payload
        if not isinstance(items, list):
            raise AdapterError("API 响应格式错误：期望 {items: [...]} 或数组")

        cleaned: list[dict] = []
        for item in items:
            if isinstance(item, dict) and all(key in item for key in REQUIRED_KEYS):
                cleaned.append(item)
        if not cleaned:
            raise AdapterError("API 响应中没有包含 title/price 的有效商品")
        return cleaned[:limit]
