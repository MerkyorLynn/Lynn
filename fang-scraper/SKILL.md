---
name: fang-scraper
description: "中国房产数据抓取工具。通过房天下(fang.com)公开接口抓取小区均价、在售房源、历史价格、区域对比等结构化数据。支持全国主要城市。当用户需要查询房价、分析楼盘、对比小区、获取房产数据时使用。Triggers: 查房价, 楼盘分析, 小区对比, 房产数据, 二手房, 成交价, 均价, 房价走势, real estate data, property price, housing market"
metadata:
  author: Hanako
  version: 1.0.0
  category: data
  language: python
  requirements: requests, beautifulsoup4, lxml
---

# 房天下房产数据抓取工具

通过房天下（fang.com）公开页面抓取结构化房产数据。房天下反爬策略较宽松，不需要验证码，适合快速批量获取数据。

## 支持的城市

北京(bj) 上海(sh) 深圳(sz) 广州(gz) 杭州(hz) 成都(cd) 南京(nj) 武汉(wh) 天津(tj) 重庆(cq) 西安(xa) 长沙(cs) 郑州(zz) 苏州(suzhou) 合肥(hf) 大连(dl) 青岛(qd) 宁波(nb) 东莞(dg) 佛山(fs) 等

## 使用方法

所有脚本位于 `fang-scraper/` 目录下，使用 Python3 运行。依赖：`requests`, `beautifulsoup4`, `lxml`。

### 1. 按区域搜索小区列表

```bash
python3 fang-scraper/fang_search.py --city sz --district 蛇口 --output json
```

参数说明：
- `--city`: 城市代码（sz=深圳, bj=北京, sh=上海 等）
- `--district`: 板块名称（如 蛇口、南山、福田）
- `--price-min`: 最低单价（可选，如 60000）
- `--price-max`: 最高单价（可选，如 100000）
- `--age`: 建成年限筛选（可选，如 10表示10年内）
- `--output`: 输出格式 json/csv，默认 json
- `--limit`: 最多返回条数，默认 50

返回字段：
```json
{
  "name": "山语海",
  "district": "南山",
  "area": "蛇口",
  "avg_price": 83087,
  "build_year": 2016,
  "listings_count": 10,
  "address": "蛇口小南山少帝路",
  "score": 9.2,
  "url": "https://sz.esf.fang.com/..."
}
```

### 2. 获取小区详细信息

```bash
python3 fang-scraper/fang_community.py --city sz --name "山语海" --output json
```

返回字段包含：基本信息、在售房源列表（户型、面积、总价、单价、楼层、朝向）、租金信息、价格走势。

### 3. 对比多个小区

```bash
python3 fang-scraper/fang_compare.py --city sz --names "山语海,兰溪谷,鲸山觐海,金众云山海" --output markdown
```

输出一个横向对比表格（markdown格式），包含单价、总价段、楼龄、容积率、交通等维度。

### 4. 获取在售房源明细

```bash
python3 fang-scraper/fang_listings.py --city sz --name "山语海" --output json
```

返回每套在售房源的详细信息：户型、面积、总价、单价、楼层、朝向、装修、是否满五唯一等。

## 数据来源与可靠性

- 数据来源：房天下(fang.com)公开页面
- 挂牌价与实际成交价通常有 5-15% 偏差（买方市场下挂牌价偏高）
- 价格数据有 1-4 周滞后
- 建议结合链家成交记录验证真实成交价

## 典型工作流

### 楼盘分析报告

```
1. fang_search.py --city sz --district 蛇口 --price-min 60000 --price-max 100000
   → 获取蛇口片区6-10万单价的所有小区
2. fang_community.py --city sz --name "山语海"
   → 获取目标小区详细信息
3. fang_compare.py --city sz --names "山语海,兰溪谷,鲸山觐海"
   → 对比竞品小区
4. 基于数据撰写分析报告
```

### 区域扫描选房

```
1. fang_search.py --city sz --district 蛇口 --age 15 --output csv
   → 筛选蛇口15年内楼龄的小区
2. 对输出按价格排序，挑选目标小区
3. fang_community.py 逐个查看详细信息
4. fang_listings.py 查看具体房源
```

## 脚本文件清单

| 脚本 | 功能 |
|------|------|
| `fang-scraper/fang_search.py` | 按区域/关键词搜索小区列表 |
| `fang-scraper/fang_community.py` | 获取小区详细信息（均价、基本信息、在售房源） |
| `fang-scraper/fang_compare.py` | 多小区横向对比（输出 Markdown 表格） |
| `fang-scraper/fang_listings.py` | 获取在售房源明细（户型、面积、价格、楼层） |

## 注意事项

- 请求间隔已内置 2-3 秒延迟，避免触发反爬
- 如遇到 403 错误，等待 5 分钟后重试
- 数据仅供分析参考，不构成投资建议
- 脚本支持 `--proxy` 参数设置代理
