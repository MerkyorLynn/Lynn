#!/usr/bin/env python3
"""房天下 - 获取在售房源明细"""

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


def fetch_listings(city_code: str, community_name: str, max_pages: int = 3) -> list[dict]:
    """获取小区在售房源列表"""
    # 搜索小区获取 ID/URL
    search_url = f"https://{city_code}.esf.fang.com/housing/"
    params = {"keyword": community_name}

    try:
        resp = requests.get(search_url, params=params, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        resp.encoding = "utf-8"
    except requests.RequestException as e:
        print(f"[ERROR] 搜索失败: {e}", file=sys.stderr)
        return []

    soup = BeautifulSoup(resp.text, "lxml")

    # 找到小区在售房源页 URL
    base_url = None
    for link in soup.select("a[href*='esf.fang.com']"):
        href = link.get("href", "")
        text = link.get_text(strip=True)
        if community_name in text:
            # 尝试构造二手房列表页 URL
            if href.startswith("/"):
                base_url = f"https://{city_code}.esf.fang.com{href}"
            else:
                base_url = href
            break

    if not base_url:
        print(f"[WARN] 未找到小区链接，尝试直接搜索二手房", file=sys.stderr)
        # 直接搜索二手房
        base_url = f"https://{city_code}.esf.fang.com/"

    # 构造在售房源列表 URL
    # 房天下小区在售页: https://sz.esf.fang.com/house-a0xxxx/
    listings_url = base_url.rstrip("/") + "/"

    all_listings = []

    for page in range(1, max_pages + 1):
        if page == 1:
            url = listings_url
        else:
            url = listings_url + f"i{page}/"

        if page > 1:
            time.sleep(2)

        try:
            resp = requests.get(url, headers=HEADERS, timeout=15)
            resp.raise_for_status()
            resp.encoding = "utf-8"
        except requests.RequestException as e:
            print(f"[WARN] 第{page}页请求失败: {e}", file=sys.stderr)
            continue

        soup = BeautifulSoup(resp.text, "lxml")
        found = False

        # 房天下房源列表结构
        for item in soup.select(".shoplist dl, .houseList dl, .esfbgex"):
            try:
                listing = {}

                # 标题
                title_tag = item.select_one("dt a, .tit a, .houseName a")
                if title_tag:
                    listing["title"] = title_tag.get_text(strip=True)
                    link = title_tag.get("href", "")
                    if link.startswith("/"):
                        listing["url"] = f"https://{city_code}.esf.fang.com{link}"
                    else:
                        listing["url"] = link

                # 价格
                price_tag = item.select_one(".price span, .shoplistPrice")
                if price_tag:
                    listing["total_price"] = price_tag.get_text(strip=True)

                # 单价
                unit_tag = item.select_one(".price em, .unitPrice")
                if unit_tag:
                    listing["unit_price"] = unit_tag.get_text(strip=True)

                # 信息
                info_tag = item.select_one("dd, .houseInfo, .shoplistInfo")
                if info_tag:
                    info_text = info_tag.get_text(strip=True)
                    # 解析户型/面积/楼层等
                    area_match = re.search(r"(\d+\.?\d*)㎡", info_text)
                    if area_match:
                        listing["area"] = float(area_match.group(1))

                    room_match = re.search(r"(\d+)室(\d+)厅", info_text)
                    if room_match:
                        listing["rooms"] = f"{room_match.group(1)}室{room_match.group(2)}厅"

                    floor_match = re.search(r"(\d+)/(?:\d+)层", info_text)
                    if floor_match:
                        listing["floor"] = floor_match.group(0)

                    listing["raw_info"] = info_text

                # 标签
                tags = [tag.get_text(strip=True) for tag in item.select(".label, .tag, .fang-tag")]
                if tags:
                    listing["tags"] = tags

                if listing:
                    all_listings.append(listing)
                    found = True
            except Exception:
                continue

        if not found:
            break

    return all_listings


def main():
    parser = argparse.ArgumentParser(description="房天下 - 在售房源明细")
    parser.add_argument("--city", required=True, help="城市代码")
    parser.add_argument("--name", required=True, help="小区名称")
    parser.add_argument("--output", choices=["json", "csv"], default="json")
    parser.add_argument("--pages", type=int, default=3, help="最大翻页数")
    args = parser.parse_args()

    listings = fetch_listings(args.city, args.name, args.pages)

    if args.output == "csv":
        import csv

        if listings:
            keys = list(listings[0].keys())
            writer = csv.DictWriter(sys.stdout, fieldnames=keys, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(listings)
    else:
        print(json.dumps(listings, ensure_ascii=False, indent=2))

    print(f"\n# 共 {len(listings)} 套在售房源", file=sys.stderr)


if __name__ == "__main__":
    main()
