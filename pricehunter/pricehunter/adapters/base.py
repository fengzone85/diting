"""数据源适配器基类。"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class AdapterError(RuntimeError):
    """数据源不可用或返回格式错误。"""


class Adapter(ABC):
    """所有采集器实现同一契约：``search(keyword, limit) -> list[dict]``。

    返回的原始字段允许使用平台原始写法（如 ``"1.2万+"``、``"¥199.00"``），
    后续由 pipeline 统一归一化。
    """

    name = "adapter"
    label = "数据源"

    @abstractmethod
    def search(self, keyword: str, limit: int = 28) -> list[dict[str, Any]]:
        raise NotImplementedError
