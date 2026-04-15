---
name: a-share-scanner
description: A股量化选股扫描器，模型驱动自适应因子评分。通过 Tushare 扫描全 A 股 5000+ 只股票，检测市场环境（波动率、动量、资金面、板块轮动），动态调整因子权重，输出选股榜/异动榜/行业分布的 HTML 报告。适用于 A 股选股、量化筛选、因子分析、市场环境诊断、板块轮动、动量策略、价值投资筛选。Use for Chinese A-share stock screening, quantitative stock picking, sector rotation, market regime detection.
version: 1.0.0
homepage: https://tushare.pro
commands:
  - /a_scan - 运行全A股量化扫描，生成HTML报告
  - /a_top - 快速查看今日Top10选股
  - /a_regime - 查看当前市场环境诊断
  - /a_sector - 查看板块轮动与行业分布
  - /a_analyze - 深度分析指定股票（如 /a_analyze 000001 600519）
metadata: {"clawdbot":{"emoji":"🇨🇳","requires":{"bins":["python3"],"env":["TUSHARE_TOKEN"]},"install":[]}}
---

# A股量化选股扫描器 v1.0

模型驱动的全 A 股量化选股工具。扫描 5000+ 只 A 股，检测市场环境，自适应调整 6 因子权重，输出选股/异动排名 + HTML 报告。

## 配置

**必需：** 一个免费的 Tushare Pro token。

1. 访问 [https://tushare.pro](https://tushare.pro) 注册（免费）
2. 在个人主页获取 API Token
3. 设置环境变量：

```bash
export TUSHARE_TOKEN="your_token_here"
```

或直接传参：

```bash
python3 {baseDir}/scripts/a_share_scan.py --token YOUR_TOKEN
```

**依赖安装（自动）：**

```bash
pip install tushare pandas
```

或用 uv（推荐）：

```bash
uv run {baseDir}/scripts/a_share_scan.py
```

## 快速命令

### 全A扫描（HTML + JSON）

```bash
python3 {baseDir}/scripts/a_share_scan.py
```

执行流程：
1. 拉取全A股最新交易日日线快照（5000+ 只）
2. 过滤 ST/低价/低流动性
3. 获取 5日/20日历史参照日行情
4. 检测市场环境（波动率、动量、资金面、板块轮动）
5. 6 因子自适应评分
6. 输出选股榜 + 异动榜 + 行业分布 + HTML 报告

### 快速 Top 10

```bash
python3 {baseDir}/scripts/a_share_scan.py --top 10
```

### 指定股票分析

```bash
python3 {baseDir}/scripts/a_share_scan.py --codes 000001,600519,300750
```

### 仅 JSON 输出

```bash
python3 {baseDir}/scripts/a_share_scan.py --format json
```

## 工作原理

### 6 因子自适应评分

每只股票按 6 个因子评分，权重根据市场环境动态调整：

| 因子 | 基础权重 | 趋势市调整 | 震荡市调整 | 高波动调整 |
| --- | ---: | --- | --- | --- |
| **动量**（当日涨跌+5日+20日涨幅） | 25% | x1.3 加强 | x0.7 减弱 | — |
| **量能**（量比+换手率+成交额） | 20% | — | — | — |
| **估值**（PE/PB/市值合理性） | 15% | x0.8 降低 | x1.3 提升 | — |
| **成长**（营收增速+净利增速） | 20% | — | — | x1.2 提升 |
| **分析师**（评级+目标价空间） | 10% | — | — | — |
| **风险调整**（波动率+涨停风险+偏离度） | 10% | — | — | x1.4 加重 |

### 市场环境检测

扫描器分析全市场数据，自动判断：

- **波动率水平** — 高/中/低（全市场涨跌幅标准差）
- **动量环境** — 趋势市/震荡市/下跌市（上涨比例+平均涨幅）
- **资金面** — 偏多/中性/偏空（涨停数/跌停数/涨跌比）
- **板块轮动** — 热门行业集中度

### 数据源

| 接口 | 数据 |
| --- | --- |
| `daily` | 全A股日线行情（OHLCV+涨跌幅+换手率） |
| `daily_basic` | 量比、总市值、流通市值、PE、PB |
| `stock_basic` | 股票名称、行业、上市日期 |
| `trade_cal` | 交易日历 |

### 覆盖范围

全 A 股（上交所 + 深交所 + 北交所），自动过滤：
- ST / *ST 股票
- 股价 < 2 元
- 成交额过低

## 输出

### HTML 报告

精美响应式 HTML，包含：
- KPI 面板（Top1 选股、市场环境、核心指标）
- 市场环境诊断卡片
- 全A选股榜 Top 30（含行业、涨跌幅、量比、分数、标签）
- 异动榜 Top 20
- 行业分布
- 自适应权重说明表

### JSON 报告

完整机器可读输出，含全部评分数据。

## 限制

- Tushare 免费 token 每分钟有调用频次限制
- 全A扫描约需 10-30 秒
- 数据为收盘后快照，非实时盘中
- **不构成投资建议** — 仅用于研究与监控

## 示例

```
用户：帮我扫一下今天A股有什么好票
→ /a_scan

用户：现在市场什么环境？
→ /a_regime

用户：看看半导体和新能源板块
→ /a_sector

用户：分析一下宁德时代和比亚迪
→ /a_analyze 300750 002594

用户：给我一个快速Top10
→ /a_top
```

## Use with Lynn (Zero Config)

> Part of [Lynn](https://github.com/MerkyorLynn/Lynn) — a personal AI agent with memory and soul. Lynn has this built-in by default.

Lynn 桌面智能体内置了 A 股扫描器：

- **自然语言触发** — 说 "扫一下A股" / "今天买什么" 即可
- **记忆系统** — Lynn 记住你的持仓、偏好板块、历史扫描
- **多模型协作** — 推理模型做因子解读，快速模型拉数据
- **定时扫描** — 设置每日收盘后自动扫描
- **美股+A股双市场** — 搭配 quant-scanner 技能覆盖全球

```bash
git clone https://github.com/MerkyorLynn/Lynn.git
cd Lynn && npm install
# 然后直接聊天：
# "扫一下A股"
# "分析一下茅台和宁德"
# "设置每天收盘后自动扫描"
```
