"""核心数据模型。"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Product:
    """清洗、去重、打分后的统一商品记录。"""

    id: str
    title: str
    price: float
    sales: int
    rating: float
    shop: str
    source: str
    source_key: str
    url: str
    keyword: str = ""
    original_price: float | None = None
    collected_at: str = ""
    history: list[float] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    value_score: float = 0.0
    value_label: str = ""
    value_tone: str = "mid"
    rank: int = 0
    is_low30d: bool = False
    change_pct: float = 0.0
    offers: list[dict[str, Any]] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
