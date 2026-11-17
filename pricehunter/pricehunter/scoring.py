"""性价比评分、标签与推荐理由。"""

from __future__ import annotations

import math
from statistics import mean

from .models import Product


def _normalize(value: float, low: float, high: float) -> float:
    if high <= low:
        return 0.5
    return min(1.0, max(0.0, (value - low) / (high - low)))


def value_label(score: float) -> tuple[str, str]:
    """返回（文案，色调）。"""
    if score >= 78:
        return "性价比首选", "high"
    if score >= 65:
        return "值得入手", "good"
    if score >= 52:
        return "中规中矩", "mid"
    return "谨慎比价", "low"


def compute_value_scores(products: list[Product]) -> None:
    """46% 价格优势 + 29% 销量热度 + 25% 店铺评分，归一化到 0–100。"""
    if not products:
        return
    prices = [p.price for p in products]
    price_min, price_max = min(prices), max(prices)
    max_log_sales = math.log1p(max(p.sales for p in products)) or 1.0
    known_ratings = [p.rating for p in products if p.rating > 0]
    fallback_rating = mean(known_ratings) if known_ratings else 4.5

    for product in products:
        price_ratio = _normalize(product.price, price_min, price_max)
        sales_ratio = math.log1p(product.sales) / max_log_sales
        rating_ratio = _normalize(product.rating or fallback_rating, 3.8, 5.0)
        score = 100 * (0.46 * (1 - price_ratio) + 0.29 * sales_ratio + 0.25 * rating_ratio)
        product.value_score = round(score, 1)
        product.value_label, product.value_tone = value_label(product.value_score)


def build_reasons(product: Product, median_price: float) -> list[str]:
    """生成最多 3 条可解释的推荐理由。"""
    reasons: list[str] = []
    if median_price > 0:
        diff = (product.price - median_price) / median_price * 100
        if diff <= -10:
            reasons.append(f"低于同组中位价 {abs(diff):.0f}%")
        elif diff <= 5:
            reasons.append("价格处于同组中位")
    if product.is_low30d:
        reasons.append("处于近 30 天价格低位")
    if product.sales >= 10000:
        reasons.append(f"销量 {product.sales / 10000:.1f} 万+")
    elif product.sales >= 3000:
        reasons.append(f"销量 {product.sales}+")
    if product.rating >= 4.7:
        reasons.append(f"店铺评分 {product.rating:.1f}")
    if product.original_price and product.original_price > product.price * 1.08:
        saved = (product.original_price - product.price) / product.original_price * 100
        reasons.append(f"较划线价省 {saved:.0f}%")
    if len(product.offers) > 1:
        reasons.append(f"{len(product.offers)} 个平台可购")
    return reasons[:3]
