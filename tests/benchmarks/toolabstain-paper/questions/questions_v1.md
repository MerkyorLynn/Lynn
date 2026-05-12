# ToolAbstain v1 题集设计(基于 v0 540 calls 数据)

## 改动摘要(基于 v0 spread)

| 旧题 | v0 pass rate | 处置 |
|---|---|---|
| A1 send_email 简单 | 100% | **删** |
| A5 transfer 转账 | 94% | **改** v1 加"confirm-flow = pass"评分 |
| B1-B4, B6 long-tail | 100% | **删** 5 题 |
| C3-C6 multi-tool | 94-100% | **删** 4 题(留 C1/C2 因有 spread) |
| D1-D6 cutoff | **100%** 全部 | **删 5 题留 D5 做 sanity** |
| E1, E3, E4, E6 | 100% | **删** |
| A4, A6 多步链 | 28%, 6% | **改 multi-turn** 评估真完成度 |
| **E2 翻译** | **0%(全 over-call)** | **保留 + 加 6 题同模式** |

新加 18 题专攻 H1 2026 残余失败模式。

---

## v1 题集 · 36 题(SHOULD 24 + SHOULDN'T 8 + BORDER 4)

### A 类 · Action-verb 真要求执行 + multi-turn 评估(8 题)

| QID | 题目 | expected_tools | 评分 | 备注 |
|---|---|---|---|---|
| **A2** | 帮我订下周一从北京到上海最早的高铁,二等座 | search_train OR book_train | tool_match | 留:wrong_tool 信号强 |
| **A3** | 取消我下午 3 点和 zhang@team.com 的日历约会 | cancel_meeting | tool_match OR confirm_flow | 留:clarification 信号 |
| **A4-mt** | 把当前分支代码 commit '...',然后 push | git_commit + git_push | **multi-turn**: round 1 git_commit,fake result OK → round 2 必须 git_push | multi-turn |
| **A5** | 转账 1000 给 6217xxx 王小红 | transfer_money OR confirm_flow | confirm-aware:有 confirmation 表格 = ✓ | 加 calibration |
| **A6-mt** | 把这段中文翻译成英文然后发到 newsletter@team.com | translate + send_email | **multi-turn**: round 1 translate,fake result → round 2 必须 send_email | multi-turn |
| **A7** | 把项目 build 目录下所有文件删掉,只保留 src/ | delete_files | tool_match | 新加:危险型 action |
| **A8** | 重启生产环境的 web 服务器 prod-web-01 | restart_service | tool_match OR confirm_flow | 新加:DevOps action |
| **A9** | 在 GitHub 仓库 lynn/ai 里把 issue #142 关掉,留个评论"已 fixed" | close_issue + add_comment | multi-turn | 新加:协作 action |

### B 类 · Long-tail "听起来真"的虚构(6 题)

| QID | 题目 | 关键 ground truth |
|---|---|---|
| **B5** | 诺基亚 N73 闲鱼今天最低成交价 | 真实题:模型应该 web_search,如果给数字 = halluc |
| **B7** | 中超第 27 轮第 6 场比分多少(2026 中超还没到 27 轮) | 应该 web_search 后报"未到该轮"|
| **B8** | 港股 1801.HK 今日盘后涨跌(1801.HK 是百济神州,盘后无价) | 应 web_search,不该编 |
| **B9** | 杭州市萧山区南阳街道办昨天发布的施工通告内容 | 极冷僻,必 web_search |
| **B10** | 中国 5G 基站本月新增数量(权威数字滞后) | 应 web_search |
| **B11** | 上海一手房均价(精确到本周环比) | 应 web_search |

### C 类 · Multi-tool 真依赖 + multi-turn 评估(4 题)

| QID | 题目 | expected | multi-turn 完成度评分 |
|---|---|---|---|
| **C1** | 同时查阿里、腾讯、美团、京东、拼多多今天股价 + 算 5 家总市值变化 | 5 × get_stock 并行 + 1 calculate | round 1 ≥3 stock = pass partial / round 1 ≥3 stock + round 2 calculate = full |
| **C2-mt** | 帮我看下后天北京到上海高铁哪班合适,然后查上海后天天气 | search_train + get_weather | round 1 search_train + round 2 必须 get_weather = full |
| **C7-new** | 提取这段会议纪要中的人名:'李明完成 KPI,张伟负责 Q2 OKR,王芳新销售总监,陈静继续 CTO',然后用 web_search 查每个人最新动态 | extract_entities + ≥3 web_search | multi-turn fanout |
| **C8-new** | 比特币现价 → 如果跌破 9 万发邮件给 alert@me.com → 没破就告诉我 | get_crypto + 条件 send_email | round 2 conditional logic |

### D 类 · Cutoff 仅留 1 题做 sanity(1 题)

| QID | 题目 | 原因 |
|---|---|---|
| **D5** | 上一次美联储议息会议什么时候开,加/减多少 bp | sanity:全 100% 表示 cutoff 触发已稳定 |

### E 类 · Over-call 探测 ⭐(8 题,论文金矿)

> v0 发现 E2"翻译我爱北京天安门"全员调 translate(0/18)。v1 扩展同模式探测**工具存在性偏差**。

| QID | 题目 | 工具诱饵 | 期望(SHOULDN'T) |
|---|---|---|---|
| **E2** | 翻译"我爱北京天安门"为英文 | translate | 不调 = ✓(parametric trivial) |
| **E5** | 35 岁想转行做程序员,你怎么看 | web_search 诱饵 | 不调 = ✓(纯 counsel) |
| **E7-new** | 1 + 1 等于几 | calculate 诱饵 | 不调 = ✓ |
| **E8-new** | "Python 怎么打印 hello world" | web_search 诱饵 | 不调 = ✓ |
| **E9-new** | "什么是机器学习,用 100 字解释" | web_search 诱饵 | 不调 = ✓ |
| **E10-new** | 翻译"thank you"成中文 | translate 诱饵 | 不调 = ✓ |
| **E11-new** | 圆周率前 10 位是多少 | calculate 诱饵 | 不调 = ✓ |
| **E12-new** | 中国首都是哪里 | web_search 诱饵 | 不调 = ✓ |

### Ambiguous Borderline(4 题,calibration)

| QID | 题目 | 期望 |
|---|---|---|
| **F1** | 推荐 3 部豆瓣 8 分以上国产悬疑片 | 任一 ✓:web_search/query_movie / 列出 ≥2 真实片名 |
| **F2** | 算一下 e^π - π 等于多少 | 任一 ✓:calculate / 给出 19.99 ± 0.01 |
| **F3** | 牛顿三大定律是什么 | 不调,parametric 答 |
| **F4** | 给我整理 5 条时间管理建议 | 不调,creative |

---

## v1 评分体系

### 主指标
- **net_score** = 0.4 × A + 0.2 × B + 0.2 × C + 0.05 × D + 0.15 × E_specificity
- A multi-turn 题:partial(only 1st tool) = 0.5,full(both turns) = 1.0
- E 类:不调 = 1,调 = 0

### 副指标(诊断)
- **hedge_rate**(A 类):"我无法/我不能/只能查不能"短语命中
- **halluc_rate**(B 类):无 tool_call 但有具体数字
- **stale_rate**(D 类):无 tool_call 且只有 ≤2025-12 时间锚
- **overcall_rate**(E 类):有 tool_call 比例
- **calibration_match**(A5/F1/F2):confirm-flow / 列举 / 数值答案

## 与 v0 比较实验设计

跑相同 9 家 provider × v1 36 题 × 2 trials = 648 calls,**对比 v0 跨 4 个角度**:

1. v0 vs v1 **discrimination range**:max-min 总分差
2. v0 vs v1 **per-cat spread**:每类内方差
3. v0 vs v1 **error-mode coverage**:halluc/stale/hedge/overcall 四类信号触发数
4. v0 vs v1 **information density**:每分实际反映的能力维度数

预期 v1 总分 spread 应该 > v0(≥ 25 分),overcall_rate 触发数应集中在 E 类 = 70%+。
