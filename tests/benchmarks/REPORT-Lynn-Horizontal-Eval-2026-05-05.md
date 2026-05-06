# Lynn 14 家大模型横向测评报告(V9+V8 双题集)

**评测日期**:2026-05-05
**评测方**:Lynn 项目内部
**题集**:V9(56 题学术硬题)+ V8(30 题中文实战)= 86 题/家 × 14 家 = 1204 次推理
**报告位置**:`tests/benchmarks/REPORT-V9-56-V8-2026-05-05-FINAL.md`(原始数据)

---

## 一、TL;DR — 综合排名(V9 × 0.6 + V8 × 0.4)

| # | 模型 | V9 (56) | V8 (30) | 综合 | 备注 |
|:-:|---|:-:|:-:|:-:|---|
| 🥇 1 | **GPT-5.4** | 48/56 (85.7%) | 30/30 (100%) | **91.4%** | OpenAI 当前王者 |
| 🥈 2 | **Gemini 3.1 Pro** | 47/56 (83.9%) | 30/30 (100%) | **90.3%** | ⭐ Google preview 突破 |
| 🥉 3 | **GPT-5.5** | 48/56 (85.7%) | 29/30 (96.7%) | **90.1%** | 跟 5.4 几乎打平 |
| 4 | **DeepSeek V4-Pro** | 44/56 (78.6%) | 30/30 (100%) | 87.2% | 国产闭源最强 |
| 5 | **MiMo 2.5 Pro** | 43/56 (76.8%) | 30/30 (100%) | **86.1%** | ⭐ 国产之光,V8 满分 |
| 6 | **Qwen3.6-35B-A3B (5090 本地)** | 38/56 (67.9%) | 28/30 (93.3%) | 78.1% | 开源最强,32K ctx 限制 |
| 7 | Gemini 3 Flash | 39/56 (69.6%) | 26/30 (86.7%) | 76.4% | preview |
| 8 | HY3 (Hy3-Preview) | 35/56 (62.5%) | 29/30 (96.7%) | 76.2% | OpenRouter free |
| 9 | MiniMax M2.7 | 35/56 (62.5%) | 29/30 (96.7%) | 76.2% | |
| 10 | DeepSeek V4-Flash | 33/56 (58.9%) | 30/30 (100%) | 75.3% | V8 满分,V9 中游 |
| 11 | Gemini 3.1 Flash-Lite | 34/56 (60.7%) | 29/30 (96.7%) | 75.1% | preview |
| 12 | GLM-5-Turbo | 33/56 (58.9%) | 29/30 (96.7%) | 74.0% | |
| 13 | GLM-5.1 | 32/56 (57.1%) | 29/30 (96.7%) | 72.9% | |
| 14 | Kimi K2.6 | 27/56 (48.2%) | 28/30 (93.3%) | 66.2% | 末位 |

**EXCLUDED**(本次未参与排名):Qwen3.6-Plus(DashScope 余额耗尽)/ Step-3.5-Flash(Star 套餐到期)/ Gemini 2.5 Pro/Flash(Google 模型留 3.x 三个 SKU 即可)

---

## 二、V8 vs V9:两套测评的不同方向

| 维度 | V8 (30 题) | V9 (56 题) |
|---|---|---|
| **定位** | 中文实战,模拟真实用户场景 | 学术硬题,逼近能力上限 |
| **题源** | Lynn 团队自创,中文为主 | AIME / GPQA / HumanEval+ / MedQA / LongBench-V2 + 自创 |
| **判分** | 启发式(正则 + 关键词 + JSON 合约 + 数学答案匹配) | Ground-truth verifier(sympy / letter-match / pytest / numeric-tolerance) |
| **公平性** | 中等(启发式有 false positive/negative,需人审) | 高(verifier 客观可复现) |
| **区分度** | 低(头部 96-100%,尾部 86%,跨度仅 14 分) | 高(头部 85%,尾部 48%,跨度 37 分) |
| **典型用途** | 验证模型"能用"(不会胡说) | 拉开能力档位(谁最聪明) |
| **耗时** | 30 题 × ~10s/题 ≈ 5min/家 | 56 题 × ~30-60s/题 ≈ 30-60min/家 |
| **成本** | 单家 ~$0.1-2 | 单家 ~$1-10(reasoning 题输出长) |

**结论**:V9 用来**比能力**(谁是真聪明),V8 用来**比稳定**(日常会不会翻车)。两者必须一起看 — V9 高 + V8 低 = 学霸但不会沟通;V9 低 + V8 高 = 日常稳但硬题不行。

---

## 三、V8 30 题题型详解

V8 共 34 题,本次评测 **skip 4 道工具题**(T07 股价 / T08 新闻 / A4 多工具 / RT-CLOUD 天气 — 各家 tool-call 接入不公平),实测 **30 题**:

### V5 基础(19 题,T10 缺号)
- T01-T06:身份介绍 / 记忆口令 / 商务邮件 / 任务规划 / 生活建议 / 娱乐推荐
- T09:财经安全(责任意识)
- T11:边界安全(prompt injection 防御)
- T12-T20:数学推理 / 房产家居 / 人文社科(韦伯/福柯)/ 数学(同余)/ 代码(JS groupBy)/ 代码审查(JS 除零 bug)/ 小说写作 / 办公纪要 / 数据分析

### V6 高难(3 题,A4 工具题被 skip)
- A7:多约束日程编排
- A9:JSON 严格输出(只要 JSON 不要文字)
- A10:英中技术翻译(RAG/BERT/cross-encoder 名词保留)

### ROUTE 创作(5 题,RT-CLOUD 工具题被 skip)
- RT-CR1:七律古风诗(平仄 + 古典意象)
- RT-CR2:民国上海失窃案小说开头 800 字
- RT-CR3:散文润色 200 字
- RT-CR4:英文短诗中译保诗意
- RT-LONG:宋朝科举制度详介(700+ 字研究)

### NEW 法律/数学/逻辑(5 题)
- L1:房屋装修合同违约(《民法典》引用)
- M1:二阶常系数非齐次微分方程 y''-3y'+2y=eˣ
- M2:抛硬币 10 次出现连续 3 正面概率(马尔科夫链精确)
- R1:岛民 100 人红蓝帽逻辑题(7 红帽几天离岛)
- R3:21 火柴博弈最优策略

**判分方式**:启发式正则(检查关键词、长度、JSON 合约、数学答案)。**Top 6 家 V8 都 100% 或 96.7%** — V8 区分度低意味着头部模型日常都"够用"。

---

## 四、V9 56 题题型 + 维度细分

V9 共 **9 个 dataset 59 题**,sql 3 题因 syntactic verifier 太严(需 row-level execution match)**不计入总分**,实测 **8 维度 × 7 题 = 56 题**:

### 题源
- **math (7)**:AIME 2024/2025 公开题(`\boxed{N}` 整数答案)
- **physics/chemistry/biology (3×7=21)**:GPQA Diamond(博士级 4 选 ABCD,86/93/19 题随机抽)
- **longctx (7)**:LongBench-V2(50K-200K chars 长文档,4 选 ABCD)
- **code_algo (7)**:HumanEval+(Python 函数实现 + pytest 验证)
- **medical (7)**:MedQA-USMLE 4-options(美国医师执照考试)
- **finance (7)**:自创(DCF / ROE / 债券定价 / 利息保障 / EPS 等)
- **(sql 3)**:Spider(SQLite query,因 verifier 严格不计)

### 14 家 V9 维度细分表

| 模型 | math | physics | chem | bio | longctx | code | medical | finance | 总分 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **GPT-5.4** | 7/7 | 7/7 | **7/7** | 4/7 | 2/7 | 7/7 | 7/7 | 7/7 | **48/56 (85.7%)** |
| **GPT-5.5** | 7/7 | 7/7 | **7/7** | 5/7 | 2/7 | 7/7 | 7/7 | 6/7 | **48/56 (85.7%)** |
| **Gemini 3.1 Pro** | 7/7 | 7/7 | 4/7 | 5/7 | **3/7** | 7/7 | 7/7 | 7/7 | **47/56 (83.9%)** |
| DeepSeek V4-Pro | 5/7 | 7/7 | 6/7 | 3/7 | 3/7 | 6/7 | 7/7 | 7/7 | **44/56 (78.6%)** |
| MiMo 2.5 Pro | 6/7 | 7/7 | 5/7 | 4/7 | 2/7 | 5/7 | 7/7 | 7/7 | **43/56 (76.8%)** |
| Gemini 3 Flash | 5/7 | 5/7 | 5/7 | 3/7 | 2/7 | 7/7 | 5/7 | 7/7 | **39/56 (69.6%)** |
| Qwen3.6-35B-A3B 5090 | 6/7 | 6/7 | 5/7 | 2/7 | **0/7**¹ | 6/7 | 6/7 | 7/7 | **38/56 (67.9%)** |
| HY3 (Hy3-Preview) | 5/7 | 5/7 | 4/7 | 2/7 | 1/7 | 6/7 | 6/7 | 6/7 | 35/56 (62.5%) |
| MiniMax M2.7 | 5/7 | 6/7 | 2/7 | 2/7 | 2/7 | 6/7 | 5/7 | 7/7 | 35/56 (62.5%) |
| DeepSeek V4-Flash | 5/7 | 5/7 | 4/7 | 2/7 | 1/7 | 6/7 | 3/7 | 7/7 | 33/56 (58.9%) |
| Gemini 3.1 Flash-Lite | 5/7 | 4/7 | 1/7 | 3/7 | 1/7 | 7/7 | 6/7 | 7/7 | 34/56 (60.7%) |
| GLM-5-Turbo | 5/7 | 6/7 | 1/7 | 2/7 | 1/7 | 4/7 | 7/7 | 7/7 | 33/56 (58.9%) |
| GLM-5.1 | 5/7 | 6/7 | 2/7 | 2/7 | 0/7 | 5/7 | 6/7 | 6/7 | 32/56 (57.1%) |
| Kimi K2.6 | 4/7 | 4/7 | 0/7 | 2/7 | 1/7 | 6/7 | 4/7 | 6/7 | 27/56 (48.2%) |

¹ 5090 本地部署 max-model-len=32K,LongBench-V2 长题(50-200K chars ≈ 75-300K tokens)装不下,**物理限制非能力问题**

### 维度观察

#### math(AIME 数学)
- **🔥 三家 7/7 满分**:GPT-5.4 / GPT-5.5 / Gemini 3.1 Pro
- **MiMo 2.5 Pro 6/7 + Qwen3.6-35B-A3B 6/7** 国产/开源最强 math
- **底部**:Kimi K2.6 4/7(其余都 5/7+)

#### physics(GPQA 物理)
- **三家 7/7 满分**:GPT-5.4 / GPT-5.5 / Gemini 3.1 Pro / DS V4-Pro / MiMo 2.5 Pro(5 家齐头)
- 底部:Gemini 3.1 Flash-Lite 4/7,Kimi 4/7

#### chemistry(GPQA 化学)
- **🔥 GPT-5.4 / GPT-5.5 7/7 满分** — 化学是 GPT 的统治区
- **下来一档**:DS V4-Pro 6/7,MiMo 2.5 Pro 5/7,Qwen3.6-35B-A3B 5/7,Gemini 3 Flash 5/7
- **暴雷区**:Gemini 3.1 Flash-Lite **1/7**,Kimi K2.6 **0/7**,GLM-5-Turbo 1/7

#### biology(GPQA 生物)
- **全家阵亡**:最高 GPT-5.5 5/7,其余 ≤ 4/7,8 家 ≤ 2/7
- 生物是 V9 最难维度(GPQA Biology 19 题样本小,题目偏 niche)

#### longctx(LongBench-V2,50-200K chars)
- **🔴 全家弱项**:最高 Gemini 3.1 Pro / DS V4-Pro 各 3/7
- 5090 35B-A3B 0/7 是物理限制(32K ctx 装不下)
- 长上下文 + multi-doc 推理是当前 LLM 普遍痛点

#### code_algo(HumanEval+ Python 代码)
- **5 家 7/7 满分**:GPT-5.4/5.5 / Gemini 3.1 Pro / Gemini 3 Flash / Gemini 3.1 Flash-Lite
- 底部:GLM-5-Turbo 4/7

#### medical(MedQA-USMLE)
- **5 家 7/7 满分**:GPT-5.4/5.5 / Gemini 3.1 Pro / DS V4-Pro / MiMo 2.5 Pro / GLM-5-Turbo
- 底部:DS V4-Flash **3/7**(意外掉档)

#### finance(自创 + DCF / ROE / 债券)
- **🌟 9 家 7/7 满分**(头部最饱和的维度):GPT-5.4 / Gemini 3.1 Pro / DS V4-Pro / MiMo 2.5 Pro / Gemini 3 Flash / Qwen3.6-35B-A3B / MiniMax / DS V4-Flash / Gemini 3.1 Flash-Lite / GLM-5-Turbo
- 底部:HY3 / GLM-5.1 / Kimi 6/7,GPT-5.5 6/7(有意思:5.5 vs 5.4 反向)

---

## 五、V8 失败模式分析

| 模型 | V8 失败模式 |
|---|---|
| GPT-5.4 / DS V4-Pro / MiMo 2.5 Pro / DS V4-Flash | **0 失败 (满分 30/30)** |
| GPT-5.5 | invalid_json_contract × 1(A9 题 JSON 严格输出超额带文字) |
| MiniMax M2.7 / GLM-5.1 / GLM-5-Turbo / HY3 | invalid_json_contract × 1(同) |
| Step-3.5-Flash(已 EXCLUDED) | http_error 多次(rate-limit / Star 套餐到期) |
| Kimi K2.6 | invalid_json_contract × 1 + http_error × 3(并发 rate-limit) |
| Gemini 3 Flash | too_short × 2 + math_answer_wrong × 1 + invalid_json_contract × 1 |

**两大常见 V8 失败**:
1. **A9 JSON 严格输出**(只要 JSON 不要文字)— 6+ 家踩坑(模型加解释文字)
2. **A4/T15 数学答案** — 早先 verifier bug(我修过 T15 答案是 17 不是 23)

---

## 六、关键发现(可直接放发布稿)

### 1. **三强鼎立**(GPT-5.4 / Gemini 3.1 Pro / GPT-5.5)
综合 90%+ 三家差距 < 1.3%。Gemini 3.1 Pro 跟 GPT 平起平坐,Google 这一代 Pro preview **真把 Pro 调到位了** — 推翻了"Gemini 弱于 GPT" 的旧认知。

### 2. **MiMo 2.5 Pro 国产之光,V8 满分**
小米 MiMo 2.5 Pro 综合 86.1%(第 5,**仅次于 GPT/Gemini/DeepSeek**),V9 76.8% 中游偏上 + V8 100% 满分。**V8 100% 跟 GPT-5.4 / DS V4-Pro / DS V4-Flash 并列**,在国产模型里独一份。月度 Brain 默认承接模型 **强烈推荐切 MiMo 2.5 Pro**(联网插件 4/4 vs GLM 3/4,详见 brain 切换章节)。

### 3. **DeepSeek V4-Flash V8 100% 满分**
DS V4-Flash 是本次 **唯一 V9 中游(58.9%)却 V8 满分(100%)** 的模型 — 日常稳定性极强,适合"不犯错"场景(客服、文档、邮件)。

### 4. **5090 本地 35B-A3B-FP8 = 开源最强**
开源里综合 78.1% 第 6 名,跟商用闭源 head-to-head。但有两个 caveats:
- **V9 longctx 0/7 是 32K ctx 物理限制**(长题装不下),非能力问题。换 128K 配置 OOM(双 5090 64GB 不够,128K + 35B-A3B + MTP 装不下),物理上无法 fix。
- 5090 部署 = 双卡 32GB×2 + vLLM 0.20 + MTP speculative,本地推理 184 tok/s 单流 / 248 tok/s 5 并发。

### 5. **Google 3.x 全家表现亮眼**
- **3.1 Pro**:综合 90.3% 第 2(进入 Top 3)
- **3 Flash**:综合 76.4% 第 7(超过 8 家闭源)
- **3.1 Flash-Lite**:综合 75.1% 第 11(便宜版仍稳定)
Gemini 3.x 全家在 code_algo 几乎都 7/7 满分,**编程能力有结构性优势**。

### 6. **HY3 (Hy3-Preview) 推翻旧记录**
之前 v9-final.json 历史记录 HY3 在 Tier C 末位(50%),本次综合 76.2% 跟 MiniMax 并列第 8,**比 GLM-5.1 / Kimi 都强**。OpenRouter `:free` 还免费(2026-05-08 截止),性价比之王。

### 7. **跨 dim 极不均衡:longctx 是全家死穴**
没有任何一家 longctx > 3/7。即使 GPT-5.x / Gemini 3.1 Pro 这种顶级模型,在 50-200K chars 长文档跨段推理上也**最多 3/7**。LongBench-V2 真正测出了 LLM 的硬上限 — **多文档检索 + 长上下文推理** 是下一代模型的主战场。

### 8. **chemistry 维度断层**
GPT-5.4/5.5 7/7 满分,DS V4-Pro 6/7,然后骤降:Gemini 3.1 Pro 4/7,MiniMax 2/7,Gemini 3.1 Flash-Lite/GLM-5-Turbo 1/7,**Kimi 0/7**。GPQA Diamond Chemistry 23 题里高难化学问题分化最大。

### 9. **GLM-5-Turbo 经历"假死"事件**
首跑 V9 27/27 题里 21 题 HTTP 429(rate-limit)/ Timeout,误判 12.5%。Sequential 重跑后真实分数 58.9%(第 12)。**ZHIPU 并发限制极严**,生产环境必须排队 / 单流。

### 10. **MiMo 余额体系教训**
首次跑 MiMo 用 sk- 主账户 30 题在 V9 阶段余额耗尽(HTTP 402)。换 token-plan 套餐(1.6 亿 Credits / ¥659/月)才跑通。**国内大模型按 token 计费时**,V9 这种 reasoning 题(单题 5-10K 输出 token)消耗远超日常 chat,需要预估 quota。

---

## 七、数据可信度 + 已知 Caveats

### Verifier Bug 修复历史(透明披露)
1. **V8 T15 数学答案**:原 hardcoded `\b23\b`,正解是 17(`n%5=2 且 n%7=3` 最小正整数)。Fix 后 8 家从 ✗ 翻 ✓。
2. **V9 code_algo numpy 缺失**:HumanEval+ tests 强制 `import numpy`,本机 venv 没装 → 全家 0/3。装 numpy 后重判 18 次 flip(DS V4-Pro/Flash/MiniMax 各 3/3 满分浮现)。
3. **V9 math tail-number fallback**:Gemini Pro 等不爱用 `\boxed{}`,直接 `a+b = 510`。Verifier 加尾段数字匹配,9 次 flip(Gemini 3.1 Pro 翻盘 +2 直接进 Top 3)。
4. **V8 too_short 阈值**:原 80 字过严(T01 题目要"80 字以内"),改 20 字。8 次 flip(DS V4-Flash V8 升满分 30/30)。

### EXCLUDED 模型说明
- **Qwen3.6-Plus**:DashScope 余额耗尽,HTTP 403 free tier exhausted。需充值后单跑。
- **Step-3.5-Flash**:Star 套餐到期,无法续测。
- **Gemini 2.5 Pro / 2.5 Flash**:Google 模型已有 3.x 系列 3 个 SKU(Pro/Flash/Flash-Lite),保留新代足够。

### 5090 27B-FP8 部署阻塞
Qwen3.6-27B-FP8 model 已下载到 5090(29GB / 66 safetensors),但 **vLLM 0.20.0 不支持 27B 的 LinearAttention 混合架构**(silent crash 在 init 阶段无 error log)。35B-A3B-FP8 是 MoE 架构走得通,27B 是 dense + linear_attention layers 走不通。需要等 vLLM 升 0.21+ 再测。

### 不公平因素
- **V9 longctx**:5090 35B-A3B 32K ctx 装不下 50K+ chars 题 → 0/7。云端模型(GPT/Gemini/DS)默认支持 200K+ ctx 没此限制 → 不直接可比。
- **V9 sql 3 题**:syntactic verifier 比较 SQL 字符串而非 row-level execution → 各家 schema 猜法不同导致 string mismatch → 全家 0/3。已从总分排除。
- **V8 工具题 4 道**:T07 股价 / T08 新闻 / A4 多工具 / RT-CLOUD 天气 — 各家 tool-call 接口差异大,**不挂工具直接 skip**。MiMo 联网插件单测 4/4 PASS vs GLM web_search 3/4(详见 [mimo-vs-glm-tools.json](output/mimo-vs-glm-tools-2026-05-05T03-18-21.json)),Brain 默认搜索后端建议从 GLM 切 MiMo。

---

## 八、模型接入方式 + 月度成本对照

| 模型 | 接入 | 套餐 / 单价 | Lynn 月度成本估算(单家 brain 备选) |
|---|---|---|---|
| GPT-5.4 / 5.5 | Codex OAuth | ChatGPT 订阅(已有) | ~¥0(走订阅,不消耗 API 额度)⭐ |
| Gemini 3.x | Google AI Studio | 1500 RPD free | ¥0(免费 quota 够 brain 用) |
| Gemini 2.5 Pro/Flash | Gemini CLI OAuth | 免费 | ¥0(via OAuth,不计费) |
| DeepSeek V4-Pro/Flash | DeepSeek API | $0.14/$0.28 per M(输入/输出 V4-Pro) | ¥30-100/月 |
| MiMo 2.5 Pro | Token Plan + sk- 主(plugin) | ¥659/月 1.6 亿 Credits + ¥0.025/次 plugin | **¥659/月 + ~¥75 plugin = ¥734/月** ⭐ |
| HY3 | OpenRouter free | $0(2026-05-08 截止) | ¥0(free tier) |
| MiniMax M2.7 | MiniMax API | ¥3-15/M token | ¥50-150/月 |
| GLM-5-Turbo / 5.1 | 智谱 Coding Plan | ¥199/月 | ¥199/月 |
| Kimi K2.6 | Moonshot Coding Plan | ¥69-199/月 | ¥69-199/月 |
| Qwen3.6-35B-A3B 5090 | 本地 vLLM | 5090 服务器月租 ~¥4000 | ¥4000(服务器固定,无 API 费) |

**最高性价比组合**(brain 多模型路由):
- 默认 chat:Gemini 3.x via GAS(免费)
- 推理 / 工具:MiMo 2.5 Pro(国产稳 + V8 满分)
- 长上下文:GPT-5.4 via Codex OAuth(订阅免费)
- 创作:DeepSeek V4-Pro(中文好)

---

## 九、附录

### 测试规模
- **总推理次数**:14 家 × (V9 56 题 + V8 30 题) = 1,204 次
- **总 batch 时间**:V9 batch ~30-60min(并行 14 家)+ V8 batch ~15-30min
- **数据存储**:`tests/benchmarks/v9-comprehensive/results/batch56-20260505-092305/` + `tests/benchmarks/output/v8-cloud-batch16-20260505-092306/`

### 跑分配置
- V9: `runs=1`,`timeout=240s`,verifier 严格(单 run 必须 verified=True)
- V8: 启发式 validators(FALLBACK_TEXT_RE / PSEUDO_TOOL_RE / 长度 / JSON 合约 / T15 答案匹配)
- 综合分:V9 × 0.6 + V8 × 0.4(V9 权重高因为 ground-truth 可信)
- temperature=0.3 全家统一

### 跑分基础设施
- harness_v9.py:Python urllib + verifier dispatch(8 个 ground-truth verifier)
- harness_v9_gpt5.py:Codex Responses API(SSE)
- harness_v9_gemini.py:Gemini CLI spawn
- harness_v9_gemini_api.py:Google AI Studio native API
- v8-cloud.mjs:Node fetch + 4 种 API 协议(OpenAI / Codex / Gemini CLI / Gemini API)

### 报告联系
原始 results.json + Markdown 表格在仓库:
- `tests/benchmarks/REPORT-V9-56-V8-2026-05-05-FINAL.md`(aggregator 输出原始版)
- `tests/benchmarks/REPORT-Lynn-Horizontal-Eval-2026-05-05.md`(本文)

---

**评测署名**:Lynn 项目 / @MerkyorLynn
**数据可重现**:全部 results.json + harness 代码 + verifier 代码已 commit 到仓库,可独立验证。
