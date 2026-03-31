#!/usr/bin/env python3
"""房天下 - 对比多个小区"""

import argparse
import json
import re
import sys
import time

from fang_community import fetch_community_detail


def compare_communities(city_code: str, names: list[str]) -> list[dict]:
    """逐个获取小区详情并汇总对比"""
    results = []
    for name in names:
        print(f"[INFO] 正在获取: {name}...", file=sys.stderr)
        detail = fetch_community_detail(city_code, name)
        results.append(detail)
        if len(names) > 1:
            time.sleep(3)  # 避免请求过快
    return results


def to_markdown_table(results: list[dict]) -> str:
    """输出横向对比 Markdown 表格"""
    # 收集所有基本信息键
    all_keys = []
    for r in results:
        for k in r.get("basic_info", {}):
            if k not in all_keys:
                all_keys.append(k)

    # 构建 Markdown 表格
    name_row = "| 维度 | " + " | ".join(r.get("name", "未知") for r in results) + " |"
    sep_row = "|------|" + "|".join(["------"] * len(results)) + " |"

    rows = [name_row, sep_row]

    # 均价行
    price_row = "| 均价 | " + " | ".join(
        r.get("avg_price", "暂无") for r in results
    ) + " |"
    rows.append(price_row)

    # 基本信息
    for key in all_keys:
        row = f"| {key} | " + " | ".join(
            r.get("basic_info", {}).get(key, "—") for r in results
        ) + " |"
        rows.append(row)

    # 在售数量
    listings_row = "| 在售房源数 | " + " | ".join(
        str(len(r.get("listings", []))) for r in results
    ) + " |"
    rows.append(listings_row)

    return "\n".join(rows)


def main():
    parser = argparse.ArgumentParser(description="房天下 - 小区对比")
    parser.add_argument("--city", required=True, help="城市代码")
    parser.add_argument("--names", required=True, help="小区名，逗号分隔")
    parser.add_argument("--output", choices=["json", "markdown"], default="markdown")
    args = parser.parse_args()

    names = [n.strip() for n in args.names.split(",")]
    results = compare_communities(args.city, names)

    if args.output == "json":
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        print(to_markdown_table(results))

    print(f"\n# 共对比 {len(results)} 个小区", file=sys.stderr)


if __name__ == "__main__":
    main()
