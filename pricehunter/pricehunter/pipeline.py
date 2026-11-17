"""采集结果分析流水线：清洗 → 异常过滤 → 去重 → 打分 → 排序。"""

from __future__ import annotations

import math
import time
from collections import Counter
from datetime import datetime
from statistics import mean, median

from .adapters import get_adapter
from .models import Product
from .normalize import canonical_key, clean_title, parse_price, parse_rating, parse_sales
from .scoring import build_reasons, compute_value_scores

DISCLAIMER = "演示数据由内置模拟适配器确定性生成，不代表真实商品、价格或库存。"


def run_search(
    keyword: str,
    source: str = "demo",
    limit: int = 28,
    endpoint: str | None = None,
) -> dict:
    """采集并分析，返回可直接序列化为 JSON 的完整结果。"""
    keyword = (keyword or "").strip()
    if not keyword:
        raise ValueError("关键词不能为空")
    if not 1 <= int(limit) <= 60:
        raise ValueError("limit 需在 1–60 之间")

    adapter = get_adapter(source, endpoint)
    started = time.perf_counter()
    raw_items = adapter.search(keyword, int(limit))
    collect_ms = max(1, int((time.perf_counter() - started) * 1000))
    return analyze(raw_items, keyword, source_name=adapter.name, collect_ms=collect_ms)


def quantile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    position = (len(ordered) - 1) * q
    low, high = math.floor(position), math.ceil(position)
    if low == high:
        return float(ordered[low])
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def _nice_step(raw: float) -> float:
    if raw <= 0:
        return 1.0
    exponent = math.floor(math.log10(raw))
    base = raw / (10**exponent)
    for candidate in (1, 2, 2.5, 5, 10):
        if base <= candidate:
            return candidate * (10**exponent)
    return 10 ** (exponent + 1)


def build_bands(prices: list[float]) -> list[dict]:
    """生成适配当前价格分布的区间直方图。"""
    if not prices:
        return []
    low, high = min(prices), max(prices)
    if math.isclose(low, high):
        return [{"label": f"¥{low:.0f}", "from": round(low, 2), "to": round(high, 2), "count": len(prices)}]

    step = _nice_step((high - low) / 5)
    start = math.floor(low / step) * step
    edges = [start]
    while edges[-1] < high:
        edges.append(round(edges[-1] + step, 6))

    bands = []
    for index in range(len(edges) - 1):
        lower, upper = edges[index], edges[index + 1]
        if index == len(edges) - 2:
            count = sum(1 for price in prices if lower <= price <= upper + 1e-9)
        else:
            count = sum(1 for price in prices if lower <= price < upper)
        bands.append(
            {
                "label": f"¥{lower:.0f}–{upper:.0f}",
                "from": round(lower, 2),
                "to": round(upper, 2),
                "count": count,
            }
        )
    return bands


def _history_from(raw_history: object) -> list[float]:
    if not isinstance(raw_history, list):
        return []
    history: list[float] = []
    for value in raw_history:
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            history.append(round(float(value), 2))
    return history


def _raw_sample(item: dict) -> dict:
    return {
        "source": item.get("source"),
        "title": item.get("title"),
        "price": item.get("price"),
        "original_price": item.get("original_price"),
        "sales": item.get("sales"),
        "rating": item.get("rating"),
        "shop": item.get("shop"),
        "url": item.get("url"),
        "price_history_days": len(item.get("history") or []),
    }


def analyze(
    raw_items: list[dict],
    keyword: str,
    source_name: str = "demo",
    engine: str = "python",
    collect_ms: int = 1,
    collected_at: str | None = None,
) -> dict:
    started = time.perf_counter()
    steps: list[dict] = []
    last_mark = started

    def mark(key: str, label: str, count: int, detail: str, fixed_ms: int | None = None) -> None:
        nonlocal last_mark
        now = time.perf_counter()
        steps.append(
            {
                "key": key,
                "label": label,
                "count": count,
                "detail": detail,
                "ms": fixed_ms if fixed_ms is not None else max(1, int((now - last_mark) * 1000)),
            }
        )
        last_mark = now

    collected_at = collected_at or datetime.now().astimezone().isoformat(timespec="seconds")
    mark("collect", "采集", len(raw_items), f"Adapter 返回 {len(raw_items)} 条原始记录", fixed_ms=collect_ms)

    # 1. 字段清洗
    products: list[Product] = []
    invalid = 0
    for index, item in enumerate(raw_items):
        if not isinstance(item, dict):
            invalid += 1
            continue
        title = clean_title(item.get("title"))
        price = parse_price(item.get("price"))
        if not title or price is None:
            invalid += 1
            continue
        original_price = parse_price(item.get("original_price"))
        if original_price is not None and original_price <= price * 1.02:
            original_price = None
        products.append(
            Product(
                id=f"raw{index:03d}",
                title=title,
                price=price,
                sales=parse_sales(item.get("sales")),
                rating=parse_rating(item.get("rating")),
                shop=str(item.get("shop") or "未知店铺").strip(),
                source=str(item.get("source") or source_name).strip(),
                source_key=str(item.get("source_key") or item.get("source") or source_name).strip(),
                url=str(item.get("url") or "").strip(),
                keyword=keyword,
                original_price=original_price,
                collected_at=collected_at,
                history=_history_from(item.get("history")),
            )
        )

    # 2. IQR 异常价格过滤
    kept = products
    outliers = 0
    if len(products) >= 5:
        prices = [product.price for product in products]
        q1, q3 = quantile(prices, 0.25), quantile(prices, 0.75)
        iqr = q3 - q1
        low, high = q1 - 3 * iqr, q3 + 3 * iqr
        kept = [product for product in products if low <= product.price <= high]
        outliers = len(products) - len(kept)
    mark("clean", "清洗", len(kept), f"剔除 {invalid} 条无效 · {outliers} 条异常价格")

    # 3. 去重：同一标题指纹保留最低价报价
    groups: dict[str, list[Product]] = {}
    for product in kept:
        groups.setdefault(canonical_key(product.title) or product.title, []).append(product)

    items: list[Product] = []
    merged = 0
    for group in groups.values():
        group.sort(key=lambda product: (product.price, -product.rating))
        best = group[0]
        merged += len(group) - 1
        best.offers = [
            {
                "source": offer.source,
                "source_key": offer.source_key,
                "shop": offer.shop,
                "price": offer.price,
                "url": offer.url,
            }
            for offer in group
        ]
        best.sales = max(offer.sales for offer in group)
        if len(group) > 1:
            best.tags.append("多平台同款")
        items.append(best)
    mark("dedupe", "去重", len(items), f"合并 {merged} 条跨平台同款")

    # 4. 性价比评分 + 趋势标记
    compute_value_scores(items)
    for product in items:
        if product.history:
            previous = product.history[:-1] or product.history
            product.is_low30d = product.price <= min(previous) * 1.005
            first = product.history[0]
            product.change_pct = round((product.price - first) / first * 100, 1) if first else 0.0
    mark("score", "评分", len(items), "价格 46% · 销量 29% · 评分 25%")

    # 5. 价格升序，生成排名与展示标签
    items.sort(key=lambda product: (product.price, -product.value_score))
    lowest = items[0].price if items else 0.0
    for rank, product in enumerate(items, start=1):
        product.rank = rank
        product.id = f"p{rank:03d}"
        product.tags = [tag for tag in product.tags if tag != "全场最低"]
        if items and product.price <= lowest + 1e-9:
            product.tags.insert(0, "全场最低")
        if product.is_low30d and "近30天低价" not in product.tags:
            product.tags.append("近30天低价")
        product.tags = product.tags[:3]
    mark("sort", "排序", len(items), "价格从低到高")

    prices = [product.price for product in items]
    median_price = round(median(prices), 2) if prices else 0.0
    for product in items:
        product.reasons = build_reasons(product, median_price)

    recommendations = []
    for product in sorted(items, key=lambda item: (-item.value_score, item.price))[:3]:
        payload = product.to_dict()
        payload["reasons"] = product.reasons or ["综合性价比指数进入前三"]
        recommendations.append(payload)

    platform_counts = Counter(product.source for product in items)
    platform_order: list[str] = []
    for product in items:
        if product.source not in platform_order:
            platform_order.append(product.source)
    platforms = [{"name": name, "count": platform_counts[name]} for name in platform_order]

    stats = {
        "raw_count": len(raw_items),
        "cleaned_count": len(products),
        "valid_count": len(kept),
        "final_count": len(items),
        "invalid_count": invalid,
        "outlier_count": outliers,
        "merged_count": merged,
        "removed_count": len(raw_items) - len(kept),
        "min_price": round(min(prices), 2) if prices else 0.0,
        "max_price": round(max(prices), 2) if prices else 0.0,
        "median_price": median_price,
        "avg_price": round(mean(prices), 2) if prices else 0.0,
        "saving": round(max(prices) - min(prices), 2) if prices else 0.0,
        "saving_pct": round((max(prices) - min(prices)) / min(prices) * 100, 1) if prices and min(prices) > 0 else 0.0,
        "low30d_count": sum(1 for product in items if product.is_low30d),
        "best_value_id": recommendations[0]["id"] if recommendations else None,
        "platforms": platforms,
    }

    return {
        "meta": {
            "keyword": keyword,
            "source": source_name,
            "engine": engine,
            "collected_at": collected_at,
            "disclaimer": DISCLAIMER,
        },
        "steps": steps,
        "stats": stats,
        "bands": build_bands(prices),
        "items": [product.to_dict() for product in items],
        "recommendations": recommendations,
        "raw_sample": [_raw_sample(item) for item in raw_items[:3] if isinstance(item, dict)],
    }
