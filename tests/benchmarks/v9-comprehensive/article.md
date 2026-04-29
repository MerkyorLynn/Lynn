# 中美典型大模型超高难度试题横向测评 · 我花一周给 Lynn 选 LLM 打工牛马 · 第 9 轮看谁是学霸

> 我做的产品叫 Lynn(Electron 全栈 + brain 后端 + GPU 自部署)· brain 端要给一线用户的请求做 LLM 路由(主模型 + fallback 链)。
>
> 选 LLM provider 不是看谁分高 · 是看 **可用 · 便宜 · 稳定 · 部署友好**。我管这种叫"打工牛马"。
>
> 周二到周五 · 我每天跑一轮选型测试(V1-V8 · 共 8 轮)· 一直在筛 chatOrder 里该放谁。这周五 DS V4-Pro 和 V4-Flash 发布 · 我想"那干脆把题难度拉大 · 看看顶档是谁",于是搞了 V9。
>
> V9 出来后我对"学霸 vs 牛马"4 类有了 ground truth 级回答 · 但**实战 chatOrder 还是基本不动 · 学霸根本进不来**。这篇说清楚为什么。

---

## 一、背景:Lynn brain 选型为啥每天都在测

Lynn 的 brain 端是 OpenAI-compatible 路由层 · 收到 client 请求后:

1. **主路** · 调自部署的 Qwen 3.6(DGX Spark 跑 35B-A3B / 4090 跑 27B fallback)
2. **fallback 1-9** · Spark/4090 挂了或返空,按 chatOrder 顺次降级到云 API(各家不同价格 + reasoner / 多模态能力)

选型核心约束:
- **价格**:用户量大 · token 成本要可控
- **稳定性**:reasoner content 返空 / streaming 中断 / rate limit / API 飘移 都要兜底
- **能力够用**:中文综合 + 工具调用 + 多轮对话 · 不需要拿 olympiad 数学
- **多场景**:vision + reasoning + 工具 · 单一模型 不够 · 需多家组合

V8 之前的 V1-V7 都在解上面这些 · 不是看谁分最高。**目标是"打工人 + fallback 兜底链"** · 不是排行榜。

---

## 二、V1 → V8 一周演进

每天一轮的目的不一样:

| 轮 | 时间 | 干什么 |
|---|---|---|
| V1-V3 | 周二 | 原 chatOrder 5 家(GLM-Turbo / V3 / Step / MiniMax / Kimi K2.5)基础题对比 · 找 default 兜底 |
| V4 | 周二晚 | 加 Qwen3.6-A3B 本地 vLLM 主路验证 · 4090 60 tok/s 跑通 |
| V5 | 周三 | 19 题 4 维度第一个完整测评 · 但 17/19 撞天花板 · audit bias 8-14 分 |
| V6 | 周三晚 | 给 Codex GPT-5.4 加 OAuth · 测真 frontier 参照 |
| V7 | 周四 | 加 v8 硬题 20 题(数学 / 代码 / 法律)· 拉开 5 家差距 |
| V8 (245 制) | 周五 | 13 家 final · GPT-5.5 235 / Qwen 3.6 三部署 219-224 / Step 162 |

V8 final 满意度:**chatOrder 调好了**(Qwen 3.6 主路 + Kimi K2.6 / GLM-Turbo / V4-Flash / Step 兜底)· 但**T1 内部 1 分差**(GPT-5.5 235 vs GPT-5.4 234) + **Qwen 3.6 三部署同分 219-224 不能解释**。

我意识到 245 分制撞天花板了。

---

## 三、V9 触发:DS V4 周五发布 · 顺便看顶档

周五下午 DeepSeek 把 V4-Pro 和 V4-Flash 发布出来 · 24 小时内官方文档 / 知乎评测全套出。我跑了一遍 V8 题 · DS V4-Pro 218 (T1) / V4-Flash 217 (T1) · **跟 V8 已有的 Qwen 3.6 / V3.2 / Kimi K2.6 还是挤一档**。

我决定:**不要再扩 V8 题量 · 直接重做 V9** · 题难度上 AIME / GPQA Diamond 级 · verifier 全自动(0 主观审分)· 看谁是真 frontier。

V9 设计 5 条铁律:

1. **8 维度替代 4 维度**:数学(AIME 2025)/ 物理 / 化学 / 生物(GPQA Diamond)/ 长 ctx(LongBench v2 525K)/ 编程(HumanEval+ Hard)/ 医学(MedQA)/ 金融(自定义 2024 Q4 财报)
2. **100% 自动 verifier**:sympy(数学)/ pytest 沙箱(代码)/ letter match(多选)/ 数字 tolerance(金融)
3. **题难度严格**:Qwen-Plus 这种 frontier reasoner 也要 ≤47%
4. **5 min 实战时限**:超时 = 不会(用户没耐心 / production 本来就这标准)
5. **禁用工具调用**:测裸推理 · 不让模型偷取 sympy / web search

24 题 · 12 家 · 1 day 跑完。

---

## 四、V9 12 家 final 榜

![V9 Leaderboard](charts/v9-leaderboard.png)

| 排名 | 模型 | V9 总分 | 梯队 |
|:-:|---|---:|:-:|
| 🥇 | GPT-5.4 (Codex) | **87.5%** | T0 学霸 |
| 🥈 | GPT-5.5 (Codex) | **79.2%** | T0 学霸 |
| 🥉 | DeepSeek V4-Pro | **75.0%** | T0 学霸 |
| 4 | MiniMax M2.7 | 66.7% | T1 偏科牛马 |
| 5 | GLM-5-Turbo | 62.5% | T1 偏科牛马 |
| 6 | DeepSeek V4-Flash | 58.3% | T2 平庸打工 |
| 7 | Step-3.5-Flash | 58.3% | T2 平庸打工 |
| 8 | GLM-5.1 | 54.2% | T2 平庸打工 |
| 9 | Qwen3.6-A3B (Spark NVFP4) | 54.2% | T2 平庸打工 |
| 10 | Kimi K2.6 | 50.0% | T3 落榜生 |
| 11 | Qwen3.6-Plus (官方 API) | 45.8% | T3 落榜生 |
| 12 | Qwen3.6-27B (4090 vLLM) | 41.7% | T3 落榜生 |

顶 vs 底分差 **45.8 pp** · 比 V8 的 30% 拉开很多。**学霸真分出来了**。

---

## 五、4 类画像 · 学霸 / 偏科牛马 / 平庸打工 / 落榜生

![V9 Heatmap](charts/v9-heatmap.png)

### T0 学霸(综合 ≥ 75%)· GPT-5.4 / GPT-5.5 / DS V4-Pro

8 维度无明显短板 · 数学 / 物理 / 化学 / 编程 / 医学 / 金融都打。真全能。

**V4-Pro (75.0%)** 是这次最大惊喜 · **国产/开源里唯一进 T0**。math 2 + physics 3 + chemistry 2 + biology 1 + code 3 + medical 3 + finance 3 · 唯一弱项是长 ctx (1/3) 和生物(博士级 GPQA)。**性价比比 GPT-5 高一个量级**(API 价 GPT-5 的 1/4)。

**GPT-5.4 反超 GPT-5.5 8.3 pp**(V8 时仅 1 分差)· 5.4 的 chemistry 3/3 + finance 3/3 + medical 3/3 是决胜手。可能 5.5 优化了对话流畅度损失了硬推理稳定性。

**学霸不在 Lynn brain chatOrder 里**(原因见第 6 节)。

### T1 偏科牛马(60-67%)· MiniMax M2.7 / GLM-5-Turbo

某 1-2 维度突出 · 综合中等。**特定场景王者 · 不是全能**。

**MiniMax M2.7 (66.7%)** · V8 时 T2 末位 (164) · V9 升 4 位的最大反转。**长 ctx 真王**:V9 longctx 3/3 全对 · 12 家里**只有 GPT-5.4 (2/3) 和 MiniMax 能在 525K avg ctx 长文档上有效检索 · 连 GPT-5.5 都只 1/3**。MiniMax 的 1M ctx 设计真把推理能力延展到长 ctx · 不是规格表上虚标。

但 MiniMax 数学物理推理一般(physics 1/3 · medical 1/3) · 长 ctx 之外比较平。

**GLM-5-Turbo (62.5%)** · code 3/3 + medical 3/3 + finance 3/3 + math 2/3 + physics 2/3 · 简单题做得好 · 但 biology 0/3 · longctx 1/3 · 难题撑不住。**适合实战快速调用**(Lynn brain chatOrder 第 3)。

### T2 平庸打工人(50-60%)· DS V4-Flash / Step / GLM-5.1 / Qwen-A3B-Spark

题题都做但都不顶。**正是 Lynn brain chatOrder 主体**:

- **DS V4-Flash (58.3%)** · chatOrder 第 5 · 长 ctx 0 · 化学 0 但日常 OK · 价格便宜
- **Step-3.5-Flash (58.3%)** · chatOrder 第 8 · code/medical/physics 平均 · 兜底用 OK
- **GLM-5.1 (54.2%)** · chatOrder 第 6/7 · reasoner 但稳定性差(stream=False 才能跑)
- **Qwen3.6-A3B (Spark NVFP4) (54.2%)** · **Lynn brain 主路** · biology / code / medical 全 3/3 · 中文场景强 · 数学化学 reasoner 撑不住

**这一档才是 production 真主力**。便宜 · 数百万 token / 元 · 7×24 · 不卡 · 工具调用稳。

### T3 落榜生(< 50%)· Kimi K2.6 / Qwen-Plus / Qwen-27B (4090)

**Kimi K2.6 (50%)** · V8 时 T1 (202) · V9 大幅滑。reasoner 但 hard 题不行。**仍然在 Lynn chatOrder 第 4**(Moonshot 的 Coding plan 中文长文档不错)。

**Qwen3.6-Plus (45.8%)** / **Qwen3.6-27B (4090) (41.7%)** · 部署 + 题难度都打到天花板。

---

## 六、回到现实 · Lynn brain chatOrder · 学霸基本不进来

这是 V9 后我对实战选型的反思 · 也是这篇文章的真意:

| chatOrder 位 | Provider | V9 排名 | V9 % | 为啥放这位 |
|:-:|---|:-:|:-:|---|
| 主 | Qwen3.6-A3B (Spark NVFP4) | 9 | 54.2% | 自部署 · 中文好 · 工具调用稳 |
| 主 fallback | Qwen3.6-27B (4090 vLLM) | 12 | 41.7% | 主路挂时秒切 · 同家系列 |
| 1 | qwen3.6-flash (官方) | - | - | 88 天试用 + 价格低 |
| 2 | GLM-5-Turbo | 5 | 62.5% | 偏科牛马 · 实战快 |
| 3 | Kimi K2.6 | 10 | 50% | 中文长文档强(V9 没测中文长 ctx) |
| 4 | DS V4-Flash (deepseek-chat) | 6 | 58.3% | 便宜 + 中文综合好 |
| 5-7 | GLM-4.7 / GLM-4.7-Flash | - | - | 兜底链 |
| 8 | Step-3.5-Flash | 7 | 58.3% | 老 fallback · 准备退役 |

**没有 GPT-5.4 / GPT-5.5 / DS V4-Pro**(三 T0 学霸全部不在生产 chatOrder 里)。

为什么?
- **GPT-5.4/5.5** · OAuth 麻烦 + 单价 ~10 倍 + 国内访问需代理 · production 不可接受
- **DS V4-Pro** · 单价比 V4-Flash 贵 5 倍 · 触发 reasoner content 返空 bug · production 默认走不通(必须 stream=True + max_tokens=32K)

**学霸是炫技 / 边界探索 · 牛马是真打工**。

---

## 七、Qwen 3.6 三部署 · 同模型 12.5 pp 反差

![Qwen3 Deployment](charts/qwen3-deployment.png)

V8 时我做了"Qwen 3.6 三部署同分"实证(都 219-224) · 当时引为强论据"Qwen 3.6 真能力 220"。

V9 题升级后 · 三部署**大幅分化**:

| 部署 | V9 总分 | 突出维度 |
|---|---:|---|
| Qwen 3.6 在 DGX Spark NVFP4 (35B-A3B) | **54.2%** | 编程 3/3 + 医学 3/3 + 生物 3/3 |
| Qwen 3.6 官方 API (Plus reasoner) | **45.8%** | 编程 2/3 + 医学 3/3(慢但能做)|
| Qwen 3.6 在 4090 vLLM (27B FP8) | **41.7%** | 长 ctx 0/3(部署限制 65K)|

**12.5 pp 部署分差**。

部署关键差异:
1. **Spark NVFP4 用 35B-A3B 大模型**(MoE 激活 3B · NVFP4 量化)+ SGLang `--reasoning-parser qwen3` + MTP 加速 → 推理收敛快
2. **官方 Plus API** 是 reasoner 模式 · 但 5 min 时限被 timeout 几次
3. **4090 vLLM 跑 27B Dense**(单卡 48GB · max-model-len 限 65K)→ 长 ctx 完全失败 · 化学/数学 reasoner timeout

**Qwen 3.6 系列的"真能力"没有统一答案** · 用什么硬件 + 什么引擎 + 什么参数 · 直接决定它是 T2 还是 T3。

V8 时同分是因为题不需要真本事 · V9 题让部署成为放大器。

---

## 八、V8 → V9 大反转

![V8 vs V9](charts/v9-vs-v8.png)

最戏剧性的 5 个变化:

- **Qwen3.6-27B (Spark) · V8 #3 (224 开源最高) → V9 #9 (54.2%)** — 题升级硬题 · reasoner 5min 推不出
- **MiniMax M2.7 · V8 #11 (164) → V9 #4 (66.7%)** — 长 ctx 真本事终于得分 · **逆袭学霸**
- **Qwen3.6-Plus · V8 #4 (219) → V9 #11 (45.8%)** — 数学/化学 reasoner 全 timeout
- **Kimi K2.6 · V8 #9 (202) → V9 #10 (50%)** — 中文综合稳 · hard 推理弱
- **DS V4-Pro · V8 #6 (218) → V9 #3 (75%)** — 真 frontier · 题硬反而显能力

**V9 升级后 · 排名跟 V8 几乎不一样了**。这恰好说明 V8 是"打工牛马筛选" · V9 是"学霸甄别" · **两个测的不是同一件事**。

---

## 九、V9 局限 + V10 路线图

V9 也有局限:

1. **SQL 维度被砍**(syntactic verifier 太严 · 全家 0/3 · 改真 SQL exec 工程量大)
2. **编程工程没做** — SWE-Bench Verified Hard 沙箱复杂 · 留 V10
3. **24 题样本量偏小** — 单题 5 分占 4.2% · 一题运气波动影响排名 · 理论上要 50/维度
4. **训练污染风险** — HumanEval+ / GPQA Diamond / MedQA 都是公开 benchmark · AIME 2025 较干净
5. **中文文学/创意没测** — V9 全用英文 / 通用知识题 · Qwen 系列的中文创作优势没体现(V8 测过)

**V10 路线**:
- 加 SWE-Bench Verified Hard(真沙箱)
- 加自建中文创意题(Opus N=3 cross-audit · 降 bias)
- 题数升到 50/维度 · 总 400 题
- N=3 跑取众数 · 进一步降随机性

---

## 总结:打工牛马优于学霸

V8+V9 一周下来给我的实战结论:

1. **production chatOrder 不要塞学霸** — 太贵 · 太挑剔 · 不稳定
2. **找 偏科牛马 + 平庸打工 组合**(如 GLM-Turbo 长项 + V4-Flash 便宜兜底 + Qwen 自部署主路)· 总体可用性 + 性价比最优
3. **学霸只在 V9 这种 hard benchmark 里有用** · 实战大部分场景**不需要 frontier 推理**
4. **部署 + 引擎 + 参数 同样影响成绩 12.5+ pp** · 选模型不如选好部署
5. **V8 撞天花板 ≠ 模型一样** · 是题不够难 · V9 把它们的真本事打出来了

数据 + 题库 + verifier 全开源 · 任何人复现得同分:
- 题库 · `v9/data/*.json` · 24 题
- Verifiers · `v9/verifiers/*.py` · sympy / pytest / letter / finance · 5 个 selftest 全过
- Harness · `v9/scripts/harness_v9.py` + GPT-5 OAuth 单独脚本
- Raw 结果 · `v9/results/v9_*.json` · 每家 raw_full output 限 8K(spot check 用)
- Final · `v9/v9-final.json` · 12 家 8 维度子分

**关注我专栏跟进 V10**。Lynn brain 部署细节 / chatOrder 每次调整都会 reflect 到这里。
