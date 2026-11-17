"""命令行入口。"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import unicodedata
from pathlib import Path

from . import __version__
from .adapters import AdapterError
from .pipeline import run_search

_USE_COLOR = False


def _paint(code: str, text: str) -> str:
    if not _USE_COLOR:
        return text
    return f"\x1b[{code}m{text}\x1b[0m"


def bold(text: str) -> str:
    return _paint("1", text)


def dim(text: str) -> str:
    return _paint("2", text)


def red(text: str) -> str:
    return _paint("31", text)


def green(text: str) -> str:
    return _paint("32", text)


def yellow(text: str) -> str:
    return _paint("33", text)


def cyan(text: str) -> str:
    return _paint("36", text)


def display_width(text: str) -> int:
    width = 0
    for char in text:
        width += 2 if unicodedata.east_asian_width(char) in "WF" else 1
    return width


def truncate(text: str, width: int) -> str:
    text = str(text)
    if display_width(text) <= width:
        return text
    out, used = "", 0
    for char in text:
        char_width = 2 if unicodedata.east_asian_width(char) in "WF" else 1
        if used + char_width > width - 1:
            return out + "…"
        out += char
        used += char_width
    return out


def pad(text: str, width: int, align: str = "left") -> str:
    text = truncate(text, width)
    space = max(0, width - display_width(text))
    return text + " " * space if align == "left" else " " * space + text


def money(value: float) -> str:
    return f"¥{value:,.2f}"


def sales_text(value: int) -> str:
    return f"{value / 10000:.1f}万+" if value >= 10000 else f"{value}+"


def sort_items(items: list[dict], key: str) -> list[dict]:
    if key == "value":
        return sorted(items, key=lambda item: (-item["value_score"], item["price"]))
    if key == "sales":
        return sorted(items, key=lambda item: (-item["sales"], item["price"]))
    if key == "rating":
        return sorted(items, key=lambda item: (-item["rating"], item["price"]))
    return sorted(items, key=lambda item: item["price"])


def print_table(result: dict, sort_key: str = "price") -> None:
    meta, stats = result["meta"], result["stats"]
    items = sort_items(result["items"], sort_key)
    for index, item in enumerate(items, start=1):
        item["rank"] = index

    print()
    print(f"{bold('比价猎手 PriceHunter')}  {dim('v' + __version__)}  {dim('· adapter: ' + meta['source'])}")
    print(
        f"{dim('关键词')} {bold(meta['keyword'])}    "
        f"{dim('采集时间')} {meta['collected_at'].replace('T', ' ')}"
    )
    print(
        f"{dim('采集')} {stats['raw_count']}  {dim('→ 清洗')} {stats['valid_count']}  "
        f"{dim('→ 去重')} {bold(str(stats['final_count']))}  {dim('条唯一商品')}"
        f"    {dim('剔除')} {stats['invalid_count'] + stats['outlier_count']} 条  "
        f"{dim('合并')} {stats['merged_count']} 条"
    )
    if not items:
        print(yellow("\n未采集到有效商品，请检查关键词或数据源。"))
        return

    print(
        f"{dim('价格区间')} {money(stats['min_price'])} – {money(stats['max_price'])}    "
        f"{dim('中位价')} {money(stats['median_price'])}    "
        f"{dim('比价空间')} {bold(money(stats['saving']))} ({stats['saving_pct']}%)    "
        f"{dim('近30天低价')} {stats['low30d_count']} 款"
    )
    print()

    widths = [
        ("#", 4, "right"),
        ("商品", 36, "left"),
        ("平台", 8, "left"),
        ("价格", 10, "right"),
        ("销量", 8, "right"),
        ("评分", 5, "right"),
        ("性价比", 7, "right"),
        ("标签", 24, "left"),
    ]
    header = "  ".join(pad(name, width, align) for name, width, align in widths)
    print(dim(header))
    print(dim("─" * min(display_width(header), 120)))

    for item in items:
        is_low = item["price"] <= stats["min_price"] + 1e-9
        price_cell = money(item["price"])
        price_cell = green(price_cell) if is_low else price_cell
        tags = " / ".join(item["tags"]) or "—"
        score_cell = f"{item['value_score']:.1f}"
        if item["value_tone"] == "high":
            score_cell = green(score_cell)
        elif item["value_tone"] == "low":
            score_cell = dim(score_cell)
        row = "  ".join(
            [
                pad(str(item["rank"]), 4, "right"),
                pad(item["title"], 40),
                pad(item["source"], 8),
                pad(price_cell, 11, "right"),
                pad(sales_text(item["sales"]), 9, "right"),
                pad(f"{item['rating']:.1f}", 6, "right"),
                pad(score_cell, 8, "right"),
                pad(tags, 16),
            ]
        )
        print(row)

    print()
    print(bold("推荐"))
    for index, item in enumerate(result["recommendations"], start=1):
        reasons = "；".join(item["reasons"]) or "综合指数领先"
        score_text = f"{item['value_score']:.1f}"
        print(
            f"  {cyan(str(index))}. [{green(score_text)} {item['value_label']}] "
            f"{truncate(item['title'], 32)}  "
            f"{bold(money(item['price']))} · {item['source']}  {dim(reasons)}"
        )
    print()
    print(dim(f"提示：{meta['disclaimer']}"))


def write_json(path: str, result: dict) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(dim(f"JSON 已写入 {target}"))


def write_csv(path: str, result: dict) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "rank",
        "title",
        "source",
        "price",
        "original_price",
        "sales",
        "rating",
        "shop",
        "value_score",
        "value_label",
        "is_low30d",
        "tags",
        "offers",
        "url",
    ]
    with target.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for item in result["items"]:
            writer.writerow(
                {
                    "rank": item["rank"],
                    "title": item["title"],
                    "source": item["source"],
                    "price": item["price"],
                    "original_price": item["original_price"] or "",
                    "sales": item["sales"],
                    "rating": item["rating"],
                    "shop": item["shop"],
                    "value_score": item["value_score"],
                    "value_label": item["value_label"],
                    "is_low30d": "Y" if item["is_low30d"] else "N",
                    "tags": " / ".join(item["tags"]),
                    "offers": " | ".join(
                        f"{offer['source']}:{offer['price']}" for offer in item["offers"]
                    ),
                    "url": item["url"],
                }
            )
    print(dim(f"CSV 已写入 {target}"))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pricehunter",
        description="电商商品价格采集、清洗、对比与性价比标注工具。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例:\n"
            '  python -m pricehunter search "无线蓝牙耳机"\n'
            '  python -m pricehunter search "机械键盘" --limit 40 --json out.json --csv out.csv\n'
            '  python -m pricehunter search "咖啡豆" --sort value\n'
            "  python -m pricehunter serve --port 8765\n"
        ),
    )
    parser.add_argument("--version", action="version", version=f"PriceHunter {__version__}")
    subparsers = parser.add_subparsers(dest="command")

    search = subparsers.add_parser("search", help="按关键词采集并输出对比结果")
    search.add_argument("keyword", help="商品关键词，例如：无线蓝牙耳机")
    search.add_argument("--source", choices=["demo", "api"], default="demo", help="数据源（默认 demo）")
    search.add_argument("--endpoint", help="api 数据源的 JSON 接口地址")
    search.add_argument("--limit", type=int, default=28, help="采集条数上限 1–60（默认 28）")
    search.add_argument(
        "--sort",
        choices=["price", "value", "sales", "rating"],
        default="price",
        help="排序方式（默认价格升序）",
    )
    search.add_argument("--format", choices=["table", "json"], default="table", help="标准输出格式")
    search.add_argument("--json", dest="json_path", help="把完整结果写入 JSON 文件")
    search.add_argument("--csv", dest="csv_path", help="把对比表写入 CSV 文件")
    search.add_argument("--no-color", action="store_true", help="关闭 ANSI 颜色")

    serve = subparsers.add_parser("serve", help="启动本地演示页面与 JSON API")
    serve.add_argument("--host", default="127.0.0.1", help="监听地址（默认 127.0.0.1）")
    serve.add_argument("--port", type=int, default=8765, help="监听端口（默认 8765）")
    serve.add_argument("--open", action="store_true", help="启动后自动打开浏览器")

    return parser


def main(argv: list[str] | None = None) -> int:
    global _USE_COLOR
    args = build_parser().parse_args(argv)

    if args.command is None:
        build_parser().print_help()
        return 0

    if args.command == "serve":
        from .server import serve

        try:
            serve(host=args.host, port=args.port, open_browser=args.open)
        except RuntimeError as exc:
            print(red(f"启动失败：{exc}"), file=sys.stderr)
            return 2
        return 0

    if args.command == "search":
        _USE_COLOR = (
            not args.no_color
            and not os.environ.get("NO_COLOR")
            and hasattr(sys.stdout, "isatty")
            and sys.stdout.isatty()
        )
        try:
            result = run_search(
                args.keyword,
                source=args.source,
                limit=args.limit,
                endpoint=args.endpoint,
            )
        except (ValueError, AdapterError) as exc:
            print(red(f"错误：{exc}"), file=sys.stderr)
            return 2

        if args.sort != "price":
            result["items"] = sort_items(result["items"], args.sort)
            for index, item in enumerate(result["items"], start=1):
                item["rank"] = index

        if args.format == "json":
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print_table(result, sort_key=args.sort)

        if args.json_path:
            write_json(args.json_path, result)
        if args.csv_path:
            write_csv(args.csv_path, result)
        return 0

    build_parser().print_help()
    return 0
