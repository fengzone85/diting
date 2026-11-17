"""内置确定性模拟数据源。

不访问任何真实电商站点，使用关键词作为随机种子生成稳定、可复现的商品样本，
用于演示采集 → 清洗 → 去重 → 打分 → 排序的完整链路。
"""

from __future__ import annotations

import math
import random

from ..normalize import format_sales
from .base import Adapter

BRANDS = ["声澜", "墨羽", "云听", "星野", "极昼", "拾光", "青柚", "白鹭", "南风"]
SUFFIXES = [
    "Pro 版",
    "青春版",
    "标准版",
    "降噪款",
    "旗舰款",
    "轻享版",
    "双机装",
    "礼盒装",
    "升级款",
    "经典款",
]
PLATFORMS = [
    {"key": "jd", "name": "京东", "shop": "京东自营旗舰店", "factor": 1.00},
    {"key": "tmall", "name": "天猫", "shop": "官方旗舰店", "factor": 1.05},
    {"key": "pdd", "name": "拼多多", "shop": "百亿补贴", "factor": 0.93},
]
MULTIPLIERS = [0.76, 0.83, 0.91, 1.00, 1.09, 1.21, 1.36, 1.52]

CATEGORY_BASE = [
    (("耳机", "蓝牙", "音箱", "耳麦"), 219.0),
    (("手机", "iphone", "华为", "小米", "荣耀"), 3999.0),
    (("键盘", "鼠标", "显示器", "路由", "硬盘"), 329.0),
    (("扫地", "机器人", "吸尘", "净化器"), 1599.0),
    (("咖啡", "茶叶", "豆"), 99.0),
    (("面霜", "精华", "护肤", "口红", "面膜"), 239.0),
    (("洗衣", "纸巾", "日用", "清洁"), 59.0),
    (("零食", "坚果", "牛奶"), 69.0),
]


def _base_price(keyword: str) -> float:
    lowered = keyword.lower()
    for words, price in CATEGORY_BASE:
        if any(word in lowered for word in words):
            return price
    return 219.0


def _make_history(seed: str, final_price: float, days: int = 30) -> list[float]:
    """生成围绕当前价波动的 30 天价格序列，末位等于本次采集价。"""
    rnd = random.Random(seed)
    phase = rnd.uniform(0, math.tau)
    amplitude = rnd.uniform(0.025, 0.085)
    value = final_price * rnd.uniform(1.02, 1.10)
    series: list[float] = []
    for day in range(days - 1):
        progress = day / (days - 1)
        target = final_price * (
            1 + amplitude * math.sin(progress * math.tau * 1.15 + phase) + 0.035 * (1 - progress)
        )
        value += (target - value) * 0.42 + value * rnd.uniform(-0.009, 0.009)
        value = max(value, final_price * 0.72)
        series.append(round(value, 2))
    series.append(round(final_price, 2))
    return series


class DemoAdapter(Adapter):
    name = "demo"
    label = "内置模拟数据"

    def search(self, keyword: str, limit: int = 28) -> list[dict]:
        limit = max(1, min(60, int(limit)))
        rnd = random.Random(f"pricehunter|{keyword}|{limit}")
        base = _base_price(keyword) * rnd.uniform(0.90, 1.10)

        model_count = max(4, math.ceil(limit / 1.35))
        models: list[dict] = []
        for index in range(model_count):
            brand = BRANDS[index % len(BRANDS)]
            suffix = SUFFIXES[(index // len(BRANDS)) % len(SUFFIXES)]
            models.append(
                {
                    "title": f"{brand} {keyword} {suffix}",
                    "brand": brand,
                    "base": base * MULTIPLIERS[index % len(MULTIPLIERS)] * rnd.uniform(0.97, 1.03),
                }
            )

        items: list[dict] = []
        cursor = 0
        while len(items) < limit:
            model = models[cursor % model_count]
            occurrence = cursor // model_count
            platform = PLATFORMS[(cursor + occurrence) % len(PLATFORMS)]

            price = round(model["base"] * platform["factor"] * rnd.uniform(0.97, 1.03), 2)
            price = max(price, 9.9)
            original_price = round(price * rnd.uniform(1.08, 1.38), 2)
            sales = int(10 ** rnd.uniform(2.0, 4.6))

            if platform["key"] == "jd":
                rating = round(rnd.uniform(4.70, 4.95), 1)
            elif platform["key"] == "tmall":
                rating = round(rnd.uniform(4.55, 4.90), 1)
            else:
                rating = round(rnd.uniform(4.35, 4.80), 1)

            items.append(
                {
                    "source": platform["name"],
                    "source_key": platform["key"],
                    "title": model["title"],
                    "price": price,
                    "original_price": original_price,
                    "sales": format_sales(sales),
                    "rating": rating,
                    "shop": f"{model['brand']}{platform['shop']}",
                    "url": f"https://item.example.com/{platform['key']}/{10000000 + len(items) * 137}",
                    "history": _make_history(f"{model['title']}|{platform['key']}", price),
                }
            )
            cursor += 1

        return items
