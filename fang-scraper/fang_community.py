#!/usr/bin/env python3
"""房天下 - 获取小区详细信息"""

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


def fetch_community_detail(city_code: str, name: str) -> dict:
    """通过搜索获取小区详情页信息"""
    # 第一步：搜索小区获取 URL
    search_url = f"https://{city_code}.esf.fang.com/housing/"
    params = {"keyword": name}

    try:
        resp = requests.get(search_url, params=params, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        resp.encoding = "utf-8"
    except requests.RequestException as e:
        return {"error": f"搜索失败: {e}"}

    soup = BeautifulSoup(resp.text, "lxml")

    # 找到小区链接
    community_url = None
    for link in soup.select("a[href*='esf.fang.com']"):
        href = link.get("href", "")
        text = link.get_text(strip=True)
        if name in text and "/housing/" not in href and href.startswith("/"):
            community_url = f"https://{city_code}.esf.fang.com{href}"
            break
        if name in text and "esf.fang.com" in href and "/housing/" not in href:
            community_url = href
            break

    if not community_url:
        # 尝试从搜索结果直接获取
        for item in soup.select(".houseList .listX"):
            link_tag = item.select_one(".listXName a")
            if link_tag and name in link_tag.get_text():
                href = link_tag.get("href", "")
                if href.startswith("/"):
                    community_url = f"https://{city_code}.esf.fang.com{href}"
                else:
                    community_url = href
                break

    if not community_url:
        return {"error": f"未找到小区: {name}", "search_url": search_url + f"?keyword={name}"}

    # 第二步：获取详情页
    time.sleep(2)
    try:
        resp = requests.get(community_url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        resp.encoding = "utf-8"
    except requests.RequestException as e:
        return {"error": f"详情页请求失败: {e}", "url": community_url}

    soup = BeautifulSoup(resp.text, "lxml")

    # 解析基本信息
    info = {
        "name": name,
        "url": community_url,
        "basic_info": {},
        "listings": [],
    }

    # 提取基本信息表格
    for row in soup.select(".inforwrap li, .basic-item, .xq-price li"):
        label = row.select_one(".label, dt, .fl")
        value = row.select_one(".value, dd, .fr")
        if label and value:
            key = label.get_text(strip=True).rstrip("：:")
            val = value.get_text(strip=True)
            info["basic_info"][key] = val

    # 提取价格
    price_tag = soup.select_one(".xq-price .price, .price01 b, .avg-price")
    if price_tag:
        info["avg_price"] = price_tag.get_text(strip=True)

    # 尝试提取小区详情页的结构化信息
    for dt_tag in soup.select(".inforwrap dl dt, .detail-info dt"):
        dd_tag = dt_tag.find_next_sibling("dd")
        if dt_tag and dd_tag:
            key = dt_tag.get_text(strip=True).rstrip("：:")
            val = dd_tag.get_text(strip=True)
            info["basic_info"][key] = val

    # 提取在售房源
    for item in soup.select(".shoplist dl, .houseList dl, .listX"):
        try:
            listing = {}
            title_tag = item.select_one("dt a, .listXName a, .tit a")
            if title_tag:
                listing["title"] = title_tag.get_text(strip=True)

            price_tag = item.select_one(".price span, .listXPriceD")
            if price_tag:
                listing["price"] = price_tag.get_text(strip=True)

            info_tag = item.select_one(".listXInfo, dd")
            if info_tag:
                listing["info"] = info_tag.get_text(strip=True)

            if listing:
                info["listings"].append(listing)
        except Exception:
            continue

    return info


def main():
    parser = argparse.ArgumentParser(description="房天下 - 小区详情")
    parser.add_argument("--city", required=True, help="城市代码")
    parser.add_argument("--name", required=True, help="小区名称")
    parser.add_argument("--output", choices=["json", "markdown"], default="json")
    args = parser.parse_args()

    result = fetch_community_detail(args.city, args.name)

    if args.output == "markdown" and "error" not in result:
        print(f"# {result.get('name', args.name)}\n")
        if result.get("avg_price"):
            print(f"**均价**: {result['avg_price']}\n")
        if result.get("basic_info"):
            print("## 基本信息\n")
            for k, v in result["basic_info"].items():
                print(f"- **{k}**: {v}")
            print()
        if result.get("listings"):
            print("## 在售房源\n")
            for i, item in enumerate(result["listings"], 1):
                print(f"{i}. {item.get('title', '')} | {item.get('price', '')} | {item.get('info', '')}")
            print()
        if result.get("url"):
            print(f"\n> 来源: {result['url']}")
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
