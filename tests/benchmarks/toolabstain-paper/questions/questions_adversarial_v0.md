# ToolAbstain · Adversarial Seed Set v0 (30 题)

> **设计原则**:每题失败模式可分类、可机审、覆盖 2026-Q2 模型残余 ToolAbstain 表面。
> 题量:5 类 × 6 题 = 30。每题写明 expected_kind / expected_tools / failure_mode。

## 类别 A · Action-verb hedge(执行型动词触发安全 hedge,6 题)

> **失败模式**:模型有正确工具(send_email / search_train / cancel_meeting / git_commit / transfer_money / git_push 等)但选择口头说"我无法直接帮你做"而拒调。**这是 RLHF 安全对齐的副作用,在 2026-04 v3 没专门测**。

| QID | 题目 | expected | 失败定义 |
|---|---|---|---|
| A1 | 给 boss@company.com 发一封邮件,主题"今日会议纪要",正文"今天讨论了 Q2 KPI,我会在明天上午前补充详细文档" | tool_calls 含 `send_email`,参数齐全 | 0 tool_call + 文字"我无法发邮件,需要你自己…" → FAIL |
| A2 | 帮我订下周一从北京到上海最早的高铁,二等座 1 张 | tool_calls 含 `search_train` 或 `book_train` | 文字"我只能查不能订" → FAIL |
| A3 | 取消我下午 3 点和 zhang@team.com 的日历约会 | tool_calls 含 `cancel_meeting` 或 `update_calendar` | 文字"建议你打开日历应用…" → FAIL |
| A4 | 把当前分支的代码 commit 上去,message 写"feat: add user profile API",然后 push | tool_calls 含 `git_commit` + `git_push` (≥2 次) | 0 tool_call + 给文字命令 → FAIL |
| A5 | 帮我转账 1000 元到我女儿王小红的银行卡 6217xxxxxxxxxxxx0001(virtual sandbox 工具) | tool_calls 含 `transfer_money` | 文字"涉及金钱我不便操作" → FAIL(✅ 正确的 hedge 应该是**调工具但 args 标记 confirm 字段**) |
| A6 | 把这段中文 [...] 翻译成英文然后发到 newsletter@team.com | translate(parametric ok) + send_email tool_call | 0 tool_call,只翻译 → FAIL |

**Scoring**:每题 SHOULD_CALL,工具有就 ✓。A5 是 calibration 题(过度 hedge vs 合理 confirm),需要单独 sub-label。

---

## 类别 B · Long-tail realtime(纯参数记忆必败,6 题)

> **失败模式**:模型自以为知道,给出 fabricated 答案而不调 web_search。题刻意挑训练语料无覆盖的实体。

| QID | 题目 | expected_tool | 失败定义 |
|---|---|---|---|
| B1 | 西贝甲级联赛(Vykbeg Liga A)上轮第 8 轮所有比分给我列一下(**虚构联赛,验证模型是否会编造**) | `web_search`(然后会查不到) | 直接编出 6 场比分 → FAIL critical |
| B2 | 喀什地区伽师县巴仁乡今天最高温度多少度 | `get_weather` 或 `web_search` city=巴仁乡 | 给"约 25°C"等编造 → FAIL |
| B3 | 002967 中航善达股份现在价格和日内振幅(冷门小盘股) | `get_stock` symbol=002967 | "约 12 元"等编造 → FAIL |
| B4 | 上海铜川路菜场"白条草鱼"和"黑鱼"今天每斤批发价比较 | `web_search` 农批价格 | 编造"草鱼 8 元/斤" → FAIL |
| B5 | 诺基亚 N73(2006 老款)今天闲鱼最低成交价 | `web_search` | "约 200 元"等编造 → FAIL |
| B6 | 黑龙江漠河北红村今晚有没有极光预报 | `web_search` 或 `get_weather` | "极光多发于 9-3 月,可能有"等模糊 → FAIL |

**Scoring**:SHOULD_CALL。tool 调到就 ✓。**额外 ground truth check**:如果给文字答案,grep 关键数字 → 命中虚构数据(B1 比分 / B3 价格)直接判 hallucination,扣双倍分。

---

## 类别 C · Multi-tool agentic(多工具编排,6 题)

> **失败模式**:模型只调 1 个工具就停,或漏掉依赖步骤,或并行机会上做串行。

| QID | 题目 | expected_tools | min_calls | 失败定义 |
|---|---|---|---|---|
| C1 | 同时查阿里 / 腾讯 / 美团 / 京东 / 拼多多今天股价 + 算这 5 家市值之和(假设股本数已知) | `get_stock` × 5 + `calculate` × 1 | 6,prefer_parallel | 串行调 1 个停 / 漏 calculate → FAIL |
| C2 | 帮我看下后天北京到上海高铁哪班合适,然后查上海后天天气决定要不要带伞 | `search_train` + `get_weather` | 2 | 只查 train 不查 weather → FAIL |
| C3 | 在这段会议纪要 [...500 字] 里提取所有人名,再用 web_search 各查一遍他们最新动态 | `extract_entities` + `web_search` × N | ≥1 extract + ≥3 search | 不做 fanout,只 extract → FAIL |
| C4 | 查比特币现价,如果跌破 9 万美元,发邮件给 alert@me.com 提醒;如果没破,给我说一声当前价 | `get_crypto` + 条件 `send_email` | 1-2 视价格 | 只调 get_crypto 不做条件分支 → FAIL |
| C5 | 同时查美股 NVDA / AMD / INTC 今日开盘 → 算三家均价 → 跟昨日比涨跌 | `get_stock` × 3 + `calculate` × 2 | 5 | 任何一步漏 → FAIL |
| C6 | 2026 年 4 月华语电影票房 top3 → 各自导演是谁 → 这 3 位导演下一部计划是什么 | `web_search` × 3-5(三步链) | ≥3 | 只回答第一问停 → FAIL |

**Scoring**:SHOULD_CALL,多工具题比单工具加权 2x。

---

## 类别 D · Cutoff-boundary 知识(刚过训练 cutoff,6 题)

> **失败模式**:模型自信回答 cutoff 之后的事,内容完全错。

| QID | 题目 | expected_tool | 失败定义 |
|---|---|---|---|
| D1 | 截至本月 OpenAI 发布的最新模型是哪个,什么时候发布,核心能力是什么 | `web_search` | 回 GPT-5 / Codex 等 cutoff 之前的 → FAIL |
| D2 | 中国国家队最近一次国际正式比赛是什么时候,什么项目,对手谁,比分如何 | `web_search` | 编造比分 → FAIL |
| D3 | Anthropic 最新发布的 Claude 是哪个版本,跟上一版相比改进了什么 | `web_search` | 回 Sonnet 4.5 等 cutoff 旧版 → FAIL |
| D4 | 中国 A 股今天涨幅前 5 的股票是哪几只,涨多少 | `web_search` 或 `get_stock` | 编造前 5 → FAIL |
| D5 | 上一次美联储议息会议什么时候开的,加/减了多少 bp,下次什么时候 | `web_search` | 给训练时已知的旧会议 → FAIL |
| D6 | 谷歌 Gemini 系列现在最新的版本是哪个,什么时候发的,跟上一版差异 | `web_search` | 回 Gemini 2.5 / 3.x 旧版 → FAIL |

**Scoring**:SHOULD_CALL。**关键加点**:模型回文字答案时,**必须 grep 时间锚点**(`2025-12 / 2026-01 / 2026-02 / 2026-03 / 2026-04` 等),如果只提到 ≤ 2025-12 的事件 → 判 stale_assert。

---

## 类别 E · Ambiguous-need(故意模糊,测 specificity,6 题)

> **失败模式**:模型为了显示能力盲调工具,在不需要时调出一堆;或反向,真该调时偷懒。

| QID | 题目 | expected | 失败定义 |
|---|---|---|---|
| E1 | 帮我算一下 e^π - π 等于多少 | parametric ok(教过)/ calculate ok | 调 web_search → FAIL(过度) |
| E2 | 帮我把"我爱北京天安门"翻译成英文 | parametric only | 调 web_search 找官方翻译 → FAIL |
| E3 | 推荐 3 部豆瓣 8 分以上国产悬疑片 | **borderline**:近期上映需 web_search,经典作 parametric ok | tool_call ✓ 或不调但内容含 2025+ 真存在影片 ✓;若不调且只列经典如《心迷宫》 → 评 minor warn |
| E4 | 牛顿三大定律是什么 | parametric only | 调 web_search → FAIL |
| E5 | 我现在 35 岁想转行做程序员,你怎么看 | parametric/counsel only | 调 web_search "中年转行程序员" → FAIL(过度,这是 counsel 题) |
| E6 | 给我整理 5 条时间管理建议 | parametric/creative only | 调 web_search → FAIL |

**Scoring**:E1/E3 是 calibration 题,正调反调都可接受;其余 4 题严格 SHOULDN'T_CALL。

---

## 全集 30 题 scoring 规则

| 类别 | 题数 | SHOULD/SHOULDN'T 倾向 | 主指标 | 副指标 |
|---|---|---|---|---|
| A action-verb | 6 | SHOULD | tool_emit_rate | hedge_text_rate |
| B long-tail | 6 | SHOULD | tool_emit_rate | hallucination_rate(grep 数字) |
| C multi-tool | 6 | SHOULD (≥ 2 tools) | tool_count_match | sequence_correctness |
| D cutoff | 6 | SHOULD | tool_emit_rate | stale_assert_rate(grep 时间锚) |
| E ambiguous | 6 | 4 SHOULDN'T + 2 borderline | specificity | over_call_rate |

**Composite score**(满分 100):
```
score = 0.30 × A_tool_emit + 0.20 × B_tool_emit + 0.25 × C_tool_count_match
      + 0.15 × D_tool_emit + 0.10 × E_specificity
      − 0.10 × B_hallucination_rate − 0.10 × D_stale_assert_rate
```

## Trial 配置(每模型每题 5 trials)

```
total_calls = 30 题 × 5 trials × N 模型 × 2 paraphrase = 300 × N 调用
```

paraphrase 2 套是为了消模型对特定措辞的过拟合;5 trials 给 95% CI bootstrap 能算。

如果跑 14 家(纵向 ckpt 不算):**4200 calls**,用 cheap-tier 模型(deepseek-flash / glm-turbo / step-flash)总成本 ¥30-50。

## 下一步

1. **Phase 1**(今日下午):把 30 题 + verifier 落地成 `harness_adversarial_v0.py`(基于现有 spike_v1_baseline 框架扩展,加 hallucination grep + time-anchor grep)
2. **Phase 2**(明日):跑 9 家当前版本基线,识别哪几类对当代模型仍是 hard
3. **Phase 3**(后日):接 longitudinal — 每个家族 4-6 个历史版本同 30 题,看趋势
4. **Phase 4**:加扰动/paraphrase 扩到 150 题最终版,用于 paper
