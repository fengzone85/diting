"""字段归一化：金额、销量、评分、标题与去重指纹。"""

from __future__ import annotations

import math
import re
import unicodedata

_PRICE_RE = re.compile(r"(\d+(?:\.\d+)?)")
_SALES_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(万|w|千|k)?", re.IGNORECASE)
_BRACKET_PROMO_RE = re.compile(r"[【\[（(]\s*(?:官方|正品|包邮|秒杀|限时|新品|热卖)\s*[】\]）)]")

_PROMO_TOKENS = (
    "官方旗舰店",
    "京东自营",
    "百亿补贴",
    "官方",
    "旗舰店",
    "正品",
    "包邮",
    "限时",
    "秒杀",
    "新品",
    "热卖",
)


def parse_price(value: object) -> float | None:
    """把 ``¥1,299.00`` / ``1299元`` / 数字统一成 float。"""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        price = float(value)
    else:
        text = str(value).replace("¥", "").replace("￥", "").replace(",", "").replace("元", "")
        match = _PRICE_RE.search(text)
        if not match:
            return None
        price = float(match.group(1))
        if "万" in text:
            price *= 10000
    if not math.isfinite(price) or price <= 0:
        return None
    return round(price, 2)


def parse_sales(value: object) -> int:
    """解析 ``1.2万+`` / ``3千`` / ``1000+`` 等销量写法。"""
    if value is None or value == "":
        return 0
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return max(0, int(value))
    text = str(value).replace(",", "").replace("¥", "").replace("￥", "").strip()
    match = _SALES_RE.search(text)
    if not match:
        return 0
    number = float(match.group(1))
    unit = (match.group(2) or "").lower()
    multiplier = {"万": 10000, "w": 10000, "千": 1000, "k": 1000}.get(unit, 1)
    return max(0, int(round(number * multiplier)))


def parse_rating(value: object) -> float:
    """评分统一到 0–5；兼容 98 分制。"""
    if value is None or value == "":
        return 0.0
    try:
        rating = float(str(value).replace("分", "").strip())
    except ValueError:
        return 0.0
    if not math.isfinite(rating) or rating <= 0:
        return 0.0
    if rating > 5:
        rating = rating / 20 if rating <= 100 else 5.0
    return round(min(rating, 5.0), 2)


def clean_title(title: object) -> str:
    """统一全角/半角、压缩空白，并去掉常见的促销括注。"""
    text = unicodedata.normalize("NFKC", str(title or ""))
    text = _BRACKET_PROMO_RE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def canonical_key(title: str) -> str:
    """去重指纹：忽略大小写、标点、空格与促销词。"""
    text = unicodedata.normalize("NFKC", title).lower()
    for token in _PROMO_TOKENS:
        text = text.replace(token.lower(), "")
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", text)


def format_sales(value: int) -> str:
    """用于模拟/展示的销量写法。"""
    if value >= 10000:
        return f"{value / 10000:.1f}万+"
    return f"{value}+"
