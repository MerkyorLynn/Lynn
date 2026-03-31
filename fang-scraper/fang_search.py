#!/usr/bin/env python3
"""房天下 - 按区域搜索小区列表"""

import argparse
import json
import re
import sys
import time

import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

CITY_MAP = {
    "bj": "北京", "sh": "上海", "sz": "深圳", "gz": "广州",
    "hz": "杭州", "cd": "成都", "nj": "南京", "wh": "武汉",
    "tj": "天津", "cq": "重庆", "xa": "西安", "cs": "长沙",
    "zz": "郑州", "suzhou": "苏州", "hf": "合肥",
}


def fetch_community_list(city_code: str, district: str, page: int = 1) -> list[dict]:
    """从房天下搜索小区列表"""
    # 房天下板块搜索 URL
    url = f"https://{city_code}.esf.fang.com/housing/{__district_pinyin(city_code, district)}/"
    if page > 1:
        url = f"https://{city_code}.esf.fang.com/housing/{__district_pinyin(city_code, district)}/{page}/"

    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        resp.encoding = "utf-8"
    except requests.RequestException as e:
        print(f"[ERROR] 请求失败: {e}", file=sys.stderr)
        return []

    soup = BeautifulSoup(resp.text, "lxml")
    results = []

    # 房天下小区列表结构
    for item in soup.select(".houseList .listX"):
        try:
            name_tag = item.select_one(".listXName a")
            name = name_tag.get_text(strip=True) if name_tag else "未知"
            link = name_tag["href"] if name_tag and name_tag.has_attr("href") else ""

            price_tag = item.select_one(".listXPrice .listXPriceD")
            price_text = price_tag.get_text(strip=True) if price_tag else "暂无"

            info_tags = item.select(".listXInfo span")
            build_year = ""
            for tag in info_tags:
                text = tag.get_text(strip=True)
                if "年建" in text:
                    build_year = re.search(r"(\d{4})", text)
                    build_year = build_year.group(1) if build_year else ""

            address_tag = item.select_one(".listXAddress")
            address = address_tag.get_text(strip=True) if address_tag else ""

            results.append({
                "name": name,
                "district": CITY_MAP.get(city_code, city_code),
                "area": district,
                "avg_price": price_text,
                "build_year": build_year,
                "address": address,
                "url": f"https://{city_code}.esf.fang.com{link}" if link.startswith("/") else link,
            })
        except Exception:
            continue

    # 备用解析：尝试另一种页面结构
    if not results:
        for item in soup.select(".shoplist > dl, .houseList dl"):
            try:
                name_tag = item.select_one("dt a, .tit a")
                name = name_tag.get_text(strip=True) if name_tag else "未知"
                link = name_tag["href"] if name_tag and name_tag.has_attr("href") else ""

                price_tag = item.select_one(".price span, .listXPriceD")
                price_text = price_tag.get_text(strip=True) if price_tag else "暂无"

                results.append({
                    "name": name,
                    "district": CITY_MAP.get(city_code, city_code),
                    "area": district,
                    "avg_price": price_text,
                    "build_year": "",
                    "address": "",
                    "url": f"https://{city_code}.esf.fang.com{link}" if link.startswith("/") else link,
                })
            except Exception:
                continue

    return results


def __district_pinyin(city_code: str, district: str) -> str:
    """简单映射区域名到 URL 路径（房天下使用中文区域编码）"""
    # 房天下搜索页通常支持中文区域参数
    # 这里先用通用搜索 URL
    import urllib.parse
    return urllib.parse.quote(district)


def search_community(city_code: str, name: str) -> list[dict]:
    """按小区名搜索"""
    url = f"https://{city_code}.esf.fang.com/housing/"
    params = {"keyword": name}

    try:
        resp = requests.get(url, params=params, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        resp.encoding = "utf-8"
    except requests.RequestException as e:
        print(f"[ERROR] 搜索失败: {e}", file=sys.stderr)
        return []

    soup = BeautifulSoup(resp.text, "lxml")
    results = []

    for item in soup.select(".houseList .listX, .shoplist dl"):
        try:
            name_tag = item.select_one(".listXName a, dt a, .tit a")
            community_name = name_tag.get_text(strip=True) if name_tag else "未知"
            link = name_tag["href"] if name_tag and name_tag.has_attr("href") else ""

            price_tag = item.select_one(".listXPriceD, .price span")
            price_text = price_tag.get_text(strip=True) if price_tag else "暂无"

            results.append({
                "name": community_name,
                "avg_price": price_text,
                "url": f"https://{city_code}.esf.fang.com{link}" if link.startswith("/") else link,
            })
        except Exception:
            continue

    return results


def main():
    parser = argparse.ArgumentParser(description="房天下 - 搜索小区")
    parser.add_argument("--city", required=True, help="城市代码 (sz/bj/sh/...)")
    parser.add_argument("--district", help="板块名称 (如 蛇口)")
    parser.add_argument("--name", help="小区名称关键词")
    parser.add_argument("--price-min", type=int, help="最低单价")
    parser.add_argument("--price-max", type=int, help="最高单价")
    parser.add_argument("--output", choices=["json", "csv"], default="json")
    parser.add_argument("--limit", type=int, default=50)
    args = parser.parse_args()

    if args.name:
        results = search_community(args.city, args.name)
    elif args.district:
        results = fetch_community_list(args.city, args.district)
    else:
        print("[ERROR] 请指定 --district 或 --name", file=sys.stderr)
        sys.exit(1)

    # 价格筛选
    if args.price_min or args.price_max:
        filtered = []
        for r in results:
            try:
                price_str = str(r.get("avg_price", "0"))
                price_num = int(re.search(r"(\d+)", price_str).group(1))
                if args.price_min and price_num < args.price_min:
                    continue
                if args.price_max and price_num > args.price_max:
                    continue
                filtered.append(r)
            except (AttributeError, ValueError):
                continue
        results = filtered

    results = results[: args.limit]

    if args.output == "csv":
        import csv

        writer = csv.DictWriter(sys.stdout, fieldnames=["name", "district", "area", "avg_price", "build_year", "address", "url"])
        writer.writeheader()
        writer.writerows(results)
    else:
        print(json.dumps(results, ensure_ascii=False, indent=2))

    print(f"\n# 共 {len(results)} 条结果", file=sys.stderr)


if __name__ == "__main__":
    main()
