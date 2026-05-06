# 14 家大模型超高难度学术题横向测评:OpenAI / Google 三强鼎立,小米 MiMo 国产之光,开源 Qwen3.6 跑赢商用便宜版

> Lynn 项目第 10 轮 LLM 选型测评 · 2026-05-05
> 题集:V9 56 道学术硬题(AIME / GPQA / HumanEval+ / MedQA / LongBench-V2 / 自创金融题)
> 判分:8 套 ground-truth verifier(sympy / pytest / letter-match / numeric-tolerance)
> 总推理:14 家 × 59 题 = **826 次**

---

## 一、为什么又做一次?

我做的产品叫 Lynn(Electron 全栈 + brain 后端 + GPU 自部署),brain 端要给一线用户的请求做 LLM 路由。**选型不是看谁分高,是看可用 + 便宜 + 稳定 + 部署友好 + 哪条 fallback 链最不会翻车**。

V1-V8 一周演进期间,我跑了 8 轮选型测试,每天一轮。但 V8 头部模型(GPT/DS/Gemini)清一色 96-100% 满分,**区分度太低,完全不能拉档**。所以这次拉到极硬:**V9 = 8 维度博士级学术硬题,看谁真聪明**。

V9 出来后我对"学霸 vs 牛马"4 类有了 ground truth 级回答,但**实战 chatOrder 还是基本不动 — 学霸根本进不来**。这篇说清楚为什么。

---

## 二、V9 测试规则:8 维度 56 题硬 benchmark

### 题集来源(全部业界标准 + 自创)

| 维度 | 题源 | 题数 | 难度定位 | 判分 |
|---|---|:-:|---|---|
| **math** | AIME 2024/2025(美国数学邀请赛) | 7 | 美国高中数学竞赛 | sympy `\boxed{N}` + 自然语言尾段 fallback |
| **physics** | GPQA Diamond Physics | 7 | 博士级 | 严格 ABCD 单字母 |
| **chemistry** | GPQA Diamond Chemistry | 7 | 博士级 | 同 |
| **biology** | GPQA Diamond Biology | 7 | 博士级(样本最小,19 题随机抽 7) | 同 |
| **longctx** | LongBench-V2 multi-doc | 7 | **50-200K chars 长文档跨段推理** | 同 |
| **code_algo** | HumanEval+ | 7 | Python 函数 + pytest 真跑(numpy 真依赖) | pytest 通过 |
| **medical** | MedQA-USMLE 4-options | 7 | 美国医师执照考试 | ABCD 严格 |
| **finance** | 自创(DCF/ROE/债券定价/利息保障/EPS) | 7 | 中级金融分析师 | 数值 + tolerance(0.01-0.05) |
| ~~sql~~ | Spider | 3 | SQLite | **过严不计**(syntactic verifier 不公平) |

### 关键技术细节

- **runs=1 strict**:单次必须 verified=True,temperature=0.3 全家统一
- **HumanEval+ 装 numpy 真跑**:不是看代码符号,是真 pytest pass(我修过 verifier bug,一开始 numpy 缺失全家 0/3,装好后 18 次 flip)
- **AIME math fallback**:Gemini Pro 不爱用 `\boxed{}`,直接 `a+b=510` 也接受(我加了 fallback,9 次 flip,Gemini 3.1 Pro 直接进 Top 3)
- **5090 35B-A3B 32K ctx 限制**:longctx 7 道题里有 50-200K chars 的,5090 双卡装不下,**物理限制非能力问题**(报告里我标了 ¹)

### 14 家接入(每家用最便宜/最省事的合法路径)

| 模型 | 接入方式 | 凭据成本 |
|---|---|---|
| GPT-5.4 / 5.5 | Codex OAuth(走 ChatGPT 订阅) | **¥0**(订阅免费,1204 题不消耗 API) |
| Gemini 3 Flash / 3.1 Flash-Lite / 3.1 Pro | Google AI Studio API | **¥0**(GAS 免费 1500 RPD) |
| HY3 | OpenRouter `:free` | **¥0**(2026-05-08 截止) |
| MiMo 2.5 Pro | Token Plan 套餐 | ¥659/月(1.6 亿 Credits) |
| DS V4-Pro / Flash · Kimi K2.6 · GLM-5-Turbo · GLM-5.1 · MiniMax M2.7 | 各自云 API | 商用 key |
| Qwen3.6-35B-A3B (5090) | 5090 双卡本地 vLLM 0.20 + MTP | ~¥4000/月(双 5090 服务器月租) |

---

## 三、14 家分档对比

### 总排名

![v9-leaderboard](v9-comprehensive/charts/v9-leaderboard.png)

按 V9 56 题分数,清晰 4 档:

| 档 | 模型 | V9 分数 | 一句话标签 |
|:-:|---|:-:|---|
| 🥇 **S** | **GPT-5.4** | 85.7% | OpenAI 当前王者,化学统治 |
| 🥇 **S** | **GPT-5.5** | 85.7% | 跟 5.4 几乎打平 |
| 🥉 **S** | **Gemini 3.1 Pro** | 83.9% | Google preview 突破,longctx 唯一拿到 3/7 |
| **A** | DeepSeek V4-Pro | 78.6% | 国产闭源最强 |
| **A** | **MiMo 2.5 Pro** ⭐ | 76.8% | **国产之光,新势力独一档** |
| **B** | Gemini 3 Flash | 69.6% | 编程 7/7 满分 |
| **B** | **Qwen3.6-35B-A3B (5090)** | 67.9% | **开源最强 + 本地部署** |
| **B** | HY3 (Hy3-Preview) | 62.5% | 推翻旧记录(原 50%) |
| **B** | MiniMax M2.7 | 62.5% | 跟 HY3 并列 |
| **B** | Gemini 3.1 Flash-Lite | 60.7% | 便宜版仍稳 |
| **C** | DS V4-Flash | 58.9% | medical 异常掉档(3/7) |
| **C** | GLM-5-Turbo | 58.9% | medical 满分 7/7 但 chemistry 只 1/7 |
| **C** | GLM-5.1 | 57.1% | 跟 5-Turbo 同档 |
| **D** | Kimi K2.6 | 48.2% | chemistry 0/7 完全放空 |

### S 档(≥ 80%)同档对比

| 模型 | math | phy | **chem** | bio | **longctx** | code | med | fin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| GPT-5.4 | 7/7 | 7/7 | **7/7** | 4/7 | 2/7 | 7/7 | 7/7 | 7/7 |
| GPT-5.5 | 7/7 | 7/7 | **7/7** | 5/7 | 2/7 | 7/7 | 7/7 | 6/7 |
| Gemini 3.1 Pro | 7/7 | 7/7 | 4/7 | 5/7 | **3/7** | 7/7 | 7/7 | 7/7 |

**S 档同档差异**:
- **GPT 系 vs Gemini 3.1 Pro**:GPT chemistry 7/7 vs Gemini 4/7(GPT 化学统治)— 这一项让 Gemini 落后 1.8 分
- **GPT-5.5 vs 5.4**:5.5 在 finance 6/7 vs 5.4 7/7(意外 — 新版没全面碾压)/ 5.5 biology 5/7 vs 5.4 4/7(5.5 略好)
- **Gemini 3.1 Pro 唯一亮点**:longctx 3/7 是全场最高(GPT 都只 2/7),Google 长上下文底子好

**S 档共性失分**:biology 都 4-5/7 + longctx 都 ≤ 3/7

### A 档(70-80%)同档对比

| 模型 | math | phy | chem | bio | longctx | code | med | fin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| DeepSeek V4-Pro | 5/7 | 7/7 | 6/7 | 3/7 | 3/7 | 6/7 | 7/7 | 7/7 |
| MiMo 2.5 Pro | 6/7 | 7/7 | 5/7 | 4/7 | 2/7 | 5/7 | 7/7 | 7/7 |

**A 档同档差异**:
- **MiMo 优势**:math 6/7 比 DS 5/7 强,biology 4/7 比 DS 3/7 强
- **DS V4-Pro 优势**:longctx 3/7 跟 Gemini 3.1 Pro 并列最高,chemistry 6/7 比 MiMo 5/7 强
- **MiMo 弱项**:code 5/7(同档 DS 6/7,S 档普遍 7/7)

**A 档关键意义**:DS V4-Pro 是国产闭源最强(78.6% 距 S 档仅 5%)。**MiMo 2.5 Pro 76.8% 仅次于 OpenAI / Google / DeepSeek 三家**,在国产新势力里独一份。

### B 档(60-70%)同档对比

| 模型 | math | phy | chem | bio | longctx | code | med | fin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Gemini 3 Flash | 5/7 | 5/7 | 5/7 | 3/7 | 2/7 | **7/7** | 5/7 | 7/7 |
| **Qwen3.6-35B-A3B (5090)** | 6/7 | 6/7 | 5/7 | 2/7 | **0/7** ¹ | 6/7 | 6/7 | 7/7 |
| HY3 (Hy3-Preview) | 5/7 | 5/7 | 4/7 | 2/7 | 1/7 | 6/7 | 6/7 | 6/7 |
| MiniMax M2.7 | 5/7 | 6/7 | 2/7 | 2/7 | 2/7 | 6/7 | 5/7 | 7/7 |
| Gemini 3.1 Flash-Lite | 5/7 | 4/7 | 1/7 | 3/7 | 1/7 | **7/7** | 6/7 | 7/7 |

**B 档同档差异**:
- **Gemini 3 Flash vs Qwen3.6-35B-A3B**:Gemini 优 code(7/7)/ Qwen 优 math+physics(6/6 双优,thinking 模式)
- **HY3 vs MiniMax M2.7**(并列 62.5%):HY3 chemistry 4/7 大胜 MiniMax 2/7,MiniMax physics 6/7 + finance 7/7 反超
- **Flash-Lite vs HY3**(60.7 vs 62.5):Flash-Lite code 7/7 但 chemistry 1/7 暴雷,HY3 全维度均衡

**B 档关键意义**:开源 Qwen3.6-35B-A3B 67.9% 跟商用 Gemini 3 Flash 几乎并肩,**开源能跑赢商用便宜版**。Flash-Lite 60.7% 价格便宜适合大批量低难度。

### C 档(50-60%)同档对比

| 模型 | math | phy | chem | bio | longctx | code | med | fin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| DeepSeek V4-Flash | 5/7 | 5/7 | 4/7 | 2/7 | 1/7 | 6/7 | **3/7** | 7/7 |
| GLM-5-Turbo | 5/7 | 6/7 | **1/7** | 2/7 | 1/7 | 4/7 | 7/7 | 7/7 |
| GLM-5.1 | 5/7 | 6/7 | 2/7 | 2/7 | **0/7** | 5/7 | 6/7 | 6/7 |

**C 档同档差异 — 失分项完全不同**:
- **DS V4-Flash**:medical 3/7(同档其他 6-7/7 — 医学专项弱)
- **GLM-5-Turbo**:chemistry 1/7(同档其他 2-7/7 — 化学完全 broken)/ 但 medical 7/7 满分
- **GLM-5.1**:chemistry 跟 5-Turbo 同样弱 + longctx 0/7

互补意义:DS V4-Flash 强 code+medical,GLM-5-Turbo 强 medical 但化学暴雷。

### D 档(< 50%)末位:Kimi K2.6

48.2% 末位,**chemistry 0/7 完全放空**,但 V8 中文实战 28/30 (93.3%) 仍合格,**适合中文聊天/创作**,不适合学术硬题。

---

## 四、维度热力图(全家 × 8 维度)

![v9-heatmap](v9-comprehensive/charts/v9-heatmap.png)

### 维度横向看
- **finance**:9 家 7/7 满分,**最饱和**(财务计算题大家都会)
- **medical**:5 家满分,异常掉档:DS V4-Flash 3/7 / Kimi 4/7
- **code_algo**:5 家满分,**Gemini 3.x 全家 7/7**(Google 编程基因好)
- **physics**:5 家满分(GPT 系 + Gemini 3.1 Pro + DS V4-Pro + MiMo)
- **math**:三家满分(GPT/Gemini Pro),但 MiMo 6/7 / Qwen3.6-35B 6/7 紧追
- **chemistry**:**断层最大**,GPT 7/7 → DS Pro 6/7 → MiMo 5/7 → Gemini Pro 4/7 → Kimi 0/7
- **biology**:**全家弱**,最高 5/7(只 GPT-5.5 / Gemini 3.1 Pro 唯二)
- **longctx**:**最弱**,最高 3/7(DS V4-Pro / Gemini 3.1 Pro)

---

## 五、关键发现 + 我的额外洞察

### 1. 三强鼎立,Google 真追上 OpenAI
GPT-5.4/5.5(85.7%)+ Gemini 3.1 Pro(83.9%)< 2 分内。**Google 这一代 Pro preview 彻底追上 GPT** — 推翻"Gemini 弱于 GPT" 的旧认知。

### 2. MiMo 2.5 Pro 国产之光
小米 MiMo 2.5 Pro V9 76.8% 第 5,**仅次于 OpenAI / Google / DeepSeek 三家国际/老牌**。**国产新势力里独一档**(下面就是 Gemini 3 Flash 69.6% 和开源 35B-A3B 67.9%)。

### 3. Qwen3.6-35B-A3B 开源最强 + 本地部署
67.9% 第 7,跟 Gemini 3 Flash 几乎并肩。**5090 双卡本地推理 184 tok/s 单流 / 248 tok/s 5 并发**,纯本地无 API 费(~¥4000/月固定服务器成本)。开源能跑赢商用便宜版。

### 4. Google 3.x code_algo 全家满分
Gemini 3 Flash / 3.1 Flash-Lite / 3.1 Pro 三家在 code 全 7/7。**Google 编程能力有结构性优势**(Bard 时代延续到 Gemini)。

### 5. HY3 (Hy3-Preview) 推翻旧记录
之前 v9-final.json 历史记录 HY3 在 Tier C 末位(50%),本次 62.5% 第 8,**比 GLM-5.1 / Kimi 都强**。OpenRouter `:free` 还免费(2026-05-08 截止),性价比之王。详细对比另开稿。

### 6. longctx 是全家死穴
没有任何一家 > 3/7,即使 GPT/Gemini Top 也最多 3/7。LongBench-V2 50-200K chars **多文档跨段推理**是当前 LLM 硬上限,**下一代主战场**。

### 7. chemistry 维度断层最大
GPT-5.4/5.5 7/7 → DS V4-Pro 6/7 → MiMo 5/7 → Gemini 3.1 Pro 4/7 → MiniMax 2/7 → 多家 1/7 → **Kimi 0/7**。GPQA Diamond Chemistry 高难化学问题分化最大。

### 8. biology 全家阵亡区
最高 5/7(GPT-5.5 / Gemini 3.1 Pro 唯二),其余都 ≤ 4/7。GPQA Biology 19 题样本小且偏 niche → 所有家都吃力。

---

## 六、超出排名的额外洞察(我个人观点)

### 9. 价格档不等于能力档
- DS V4-Flash $0.14/M(便宜)+ V9 58.9%(C 档)
- GPT-5.5 $5/M(贵 30 倍)+ V9 85.7%(S 档)
- 但 V8 实战题:DS V4-Flash 30/30 vs GPT-5.5 29/30 — **日常场景几乎打平**

**结论**:贵不是因为日常更稳,而是为了 V9 这种硬题。如果你的产品 99% 用户问"今天天气",根本没必要付 GPT-5.5 的钱。

### 10. Reasoning 模型时代:thinking 平均 +5-10%
14 家里多家 thinking model(GPT-5.x / Gemini 3.1 Pro / DS V4-Pro / MiMo 2.5 Pro / Qwen3.6-35B-A3B / Kimi K2.6),**thinking model 平均比同代非 thinking 高 5-10%**。这次 V9 头部都是 thinking model,排名跟"是否 thinking" 强相关。

### 11. GPT-5.5 vs 5.4 反向:OpenAI 新版没全面碾压
5.5 是新版理论应该更强,但跟 5.4 并列 85.7%。细看:
- 5.5 finance 6/7 vs 5.4 7/7(5.5 倒退 1)
- 5.5 biology 5/7 vs 5.4 4/7(5.5 进 1)

意味着 OpenAI 新版**不是单调改进**,5.4 用户可能不需要急切升级。

### 12. RTN 量化 + Spark SGLang = 开源生态的胜利
本次 5090 上的 27B 部署反复失败(vLLM 0.20 不支持 LinearAttention silent crash),但 **DGX Spark + SGLang(`mamba-scheduler`)能跑通同款 27B-NVFP4-v8-rtn**(用户上一个 session 自己 RTN 量化的)。

意义:
- **RTN(Round-To-Nearest)量化**不需要 calibration data,简单粗暴但可用
- 开源量化 + 多框架 backup → 不依赖单一 vendor / 单一框架
- 开源生态价值在这种"主流框架不支持时还有备路" — 这就是为什么 Lynn 同时跑 vLLM + SGLang

### 13. brain 路由实战:V9 排名只是参考之一
brain 端选模型不是"分数最高",而是路由策略:
- **简单 chat**(80% 流量):便宜稳的(Gemini 3 Flash / DS V4-Flash)
- **推理 / 工具**(15% 流量):MiMo 2.5 Pro(国产稳 + V8 满分)/ DS V4-Pro
- **难题 / 长上下文**(5% 流量):GPT-5.4 via Codex OAuth(订阅免费,Top 1)+ Gemini 3.1 Pro(longctx 3/7 唯一较强)
- **fallback**:开源 Qwen3.6-35B-A3B 自部署(网络抖时兜底)

V9 学霸进不了主链路,只在"难题"那 5% 用得上。

### 14. Verifier 自身才是测评的真正变量
我修了 4 个 verifier bug:
1. V8 T15 答案是 17 不是 23(我 hardcoded 错)→ 8 次 flip
2. V9 numpy 缺失 → 18 次 flip
3. V9 math `\boxed{}` fallback(自然语言尾段)→ 9 次 flip
4. V8 too_short 阈值过严 → 8 次 flip

**Verifier 一改,排名洗牌**。Gemini 3.1 Pro 修 fallback 后直接进 Top 3。**所以看任何 LLM 测评数据,先看判分逻辑**。

---

## 七、模型接入方式 + 月度成本(brain 实战参考)

| 模型 | 接入 | 月度成本(Lynn brain 备选) |
|---|---|---|
| GPT-5.4 / 5.5 | Codex OAuth | **¥0** ⭐(走 ChatGPT 订阅) |
| Gemini 3.x | Google AI Studio | **¥0**(GAS 1500 RPD free) |
| MiMo 2.5 Pro | Token Plan | ¥659/月 1.6 亿 Credits |
| HY3 | OpenRouter `:free` | **¥0**(2026-05-08 截止) |
| Qwen3.6-35B-A3B 本地 | 5090 vLLM | ¥4000/月(服务器固定) |
| DS V4-Pro / Flash | DeepSeek API | ¥30-100/月 |
| MiniMax M2.7 | MiniMax API | ¥50-150/月 |
| GLM-5-Turbo / 5.1 | 智谱 Coding | ¥199/月 |
| Kimi K2.6 | Moonshot Coding | ¥69-199/月 |

**最高性价比 brain 路由组合**:
- 默认 chat:**Gemini 3 Flash via GAS**(免费 + 强,B 档第一)
- 推理 / 工具:**MiMo 2.5 Pro Token Plan**(国产稳,A 档第二)
- 难题:**GPT-5.4 via Codex OAuth**(订阅免费,Top 1)
- 长上下文:**Gemini 3.1 Pro via GAS**(longctx 3/7 唯一较强)
- 创作:**DeepSeek V4-Pro**(中文好,API 便宜)

---

## 八、数据可信度

### Verifier 修复历史(透明披露)
1. V9 code_algo numpy → 装好后 18 次 flip
2. V9 math `\boxed{}` fallback → 9 次 flip(Gemini 3.1 Pro 进 Top 3)
3. V8 T15 答案 17(我之前 hardcoded 23)→ 8 次 flip
4. V8 too_short 80→20 字 → 8 次 flip(DS V4-Flash V8 升满分)

### EXCLUDED 模型(本次未参与排名)
- Qwen3.6-Plus(DashScope 余额耗尽)
- Step-3.5-Flash(Star 套餐到期)
- Gemini 2.5 Pro / 2.5 Flash(Google 已有 3.x 系列 3 个 SKU)

### 已知不公平因素(实事求是)
- 5090 35B-A3B longctx 0/7 是 32K ctx 物理限制(双卡 64GB 跑 128K 实测 OOM)
- V9 sql 3 题 syntactic verifier 字符串比对 → 全家 0/3 → 排除总分
- 5090 27B-FP8/NVFP4:vLLM 0.20 不支持 LinearAttention silent crash,等 vLLM 0.21+;**Spark SGLang 跑 27B-NVFP4 后台测试中**

### 复现
- 全部 results.json + harness 代码 + verifier 代码已 commit
- harness 4 套(harness_v9.py / _gpt5.py / _gemini.py CLI / _gemini_api.py GAS)
- 任意第三方可用同 prompt + 同 verifier 复现

---

## 九、下一篇预告

下一篇专门讲 **HY3 (Hy3-Preview)** — OpenRouter 上腾讯混元 3.0 preview 免费版。
- 综合 62.5% 排第 8,**比 GLM-5.1 / Kimi K2.6 强**
- OpenRouter `:free` 不消耗 OR credit
- 但 **2026-05-08 截止**(只剩几天)
- 横向对比 8 家(同档 + 上下档)看真实定位

---

**评测署名**:Lynn 项目 / @MerkyorLynn(知乎同名)
**仓库**:https://github.com/MerkyorLynn/Lynn
**数据透明**:全部 results.json + harness 代码可独立复现
