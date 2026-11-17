"""适配器注册与工厂。"""

from __future__ import annotations

from .api import ApiAdapter
from .base import Adapter, AdapterError
from .demo import DemoAdapter

__all__ = ["Adapter", "AdapterError", "ApiAdapter", "DemoAdapter", "get_adapter"]


def get_adapter(source: str = "demo", endpoint: str | None = None) -> Adapter:
    if source == "demo":
        return DemoAdapter()
    if source == "api":
        return ApiAdapter(endpoint or "")
    raise AdapterError(f"未知数据源：{source}（可选 demo / api）")
