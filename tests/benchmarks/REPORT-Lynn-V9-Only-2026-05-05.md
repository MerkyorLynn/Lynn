# Lynn V9 学术硬题横评(56 题,14 家)

**评测日期**:2026-05-05
**题集**:V9(56 计分 + 3 sql 不计 = 59 题/家)
**判分**:Ground-truth verifier(sympy / letter-match / pytest / numeric-tolerance)
**总推理量**:14 家 × 59 题 = 826 次
**报告位置**:`tests/benchmarks/REPORT-Lynn-V9-Only-2026-05-05.md`

> 注:V8 启发式日常题头部模型都 96-100% 满分,**区分度太低不放结果**。本报告专注 V9 学术硬题,真正拉开档位。

---

## 一、测试规则

### 1.1 题集来源(8 个学术 dataset)

| 维度 | 题源 | 题数 | 难度定位 | 题目格式 |
|---|---|:-:|---|---|
| **math** | AIME 2024/2025(美国数学邀请赛) | 7 | 美国高中数学竞赛级 | 整数答案(`\boxed{N}`) |
| **physics** | GPQA Diamond Physics | 7 | 博士级 | 4 选 ABCD |
| **chemistry** | GPQA Diamond Chemistry | 7 | 博士级 | 4 选 ABCD |
| **biology** | GPQA Diamond Biology | 7 | 博士级 | 4 选 ABCD(样本最小) |
| **longctx** | LongBench-V2 multi-doc | 7 | 50-200K chars 长文档跨段推理 | 4 选 ABCD |
| **code_algo** | HumanEval+ | 7 | Python 函数实现 + pytest 真验 | Python 代码 |
| **medical** | MedQA-USMLE 4-options | 7 | 美国医师执照考试 | 4 选 ABCD |
| **finance** | 自创 | 7 | DCF / ROE / 债券定价 / 利息保障 / EPS | 数值 + tolerance |
| ~~sql~~ | Spider | 3 | SQLite 查询 | **不计入总分**(syntactic verifier 严格,各家 schema 猜法不同全家 0/3) |

**总题数:56 题计分**(8 dim × 7 题),sql 3 题保留但不计。

### 1.2 判分机制(Ground-truth verifier,客观可复现)

| 维度 | Verifier 实现 | 容错 |
|---|---|---|
| math | sympy 数值/符号简化 + LaTeX `\boxed{}` 提取 | 接受 `a+b=510` 这种自然语言尾段(我修了 fallback) |
| physics/chem/bio/longctx/medical | 严格 ABCD 单字母匹配(支持多种格式 / `Answer: A` / `(A)` / 单 A 等) | 大小写不敏感 |
| code_algo | 模型代码 + pytest 真跑(numpy 真依赖) | pytest 通过即对 |
| finance | 数值答案 + tolerance(0.01-0.05) | 浮点容忍 |
| ~~sql~~ | sqlglot AST 字符串比对(非执行) | **过严,排除** |

**严格模式**:`runs=1`,单次必须 verified=True 才算对。temperature=0.3 全家统一。

### 1.3 接入方式 + 凭据

| 模型组 | 接入方式 | 凭据 |
|---|---|---|
| GPT-5.x | Codex OAuth(走 ChatGPT 订阅) | `~/.codex/auth.json` |
| Gemini 3.x | Google AI Studio API | `GEMINI_API_KEY`(免费 1500 RPD) |
| Gemini 2.5 Pro/Flash | Gemini CLI OAuth | `~/.gemini/oauth_creds.json`(免费) |
| HY3 (Hy3-Preview) | OpenRouter `:free` | `OPENROUTER_KEY`(2026-05-08 截止) |
| MiMo 2.5 Pro | Token Plan 套餐 | `tp-` key + `token-plan-cn.xiaomimimo.com/v1` |
| DS / Kimi / GLM / MiniMax | 各自云 API | 商用 key(brain.env) |
| Qwen3.6-35B-A3B | 5090 双卡本地 vLLM 0.20 + MTP | localhost tunnel |

---

## 二、14 家分档对比

### 总分布

```
85% ┤  GPT-5.4 (85.7%)
    │  GPT-5.5 (85.7%)
83% ┤
    │  Gemini 3.1 Pro (83.9%)            ← S tier
80% ┴────────────────────────────────────
    │  DeepSeek V4-Pro (78.6%)
    │  MiMo 2.5 Pro (76.8%)              ← A tier
75% ┤
70% ┴────────────────────────────────────
    │  Gemini 3 Flash (69.6%)
    │  Qwen3.6-35B-A3B 5090 (67.9%)
    │  HY3 (62.5%) / MiniMax M2.7 (62.5%) ← B tier
60% ┤  Gemini 3.1 Flash-Lite (60.7%)
    ┴────────────────────────────────────
    │  DS V4-Flash (58.9%)
    │  GLM-5-Turbo (58.9%)               ← C tier
    │  GLM-5.1 (57.1%)
50% ┴────────────────────────────────────
    │  Kimi K2.6 (48.2%)                 ← D tier
```

---

### S 档(≥ 80%)— 国际 Top 3

| 模型 | 总分 | math | phy | chem | bio | longctx | code | med | fin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **GPT-5.4** | 85.7% | 7/7 | 7/7 | **7/7** | 4/7 | 2/7 | 7/7 | 7/7 | 7/7 |
| **GPT-5.5** | 85.7% | 7/7 | 7/7 | **7/7** | 5/7 | 2/7 | 7/7 | 7/7 | 6/7 |
| **Gemini 3.1 Pro** | 83.9% | 7/7 | 7/7 | 4/7 | 5/7 | **3/7** | 7/7 | 7/7 | 7/7 |

**S 档同档对比**:
- **GPT-5.4 / GPT-5.5 vs Gemini 3.1 Pro**:GPT 在 chemistry 7/7 vs Gemini 4/7(GPT 化学统治) — 这一项让 Gemini 落后
- **GPT-5.5 vs GPT-5.4**:5.5 finance 6/7 vs 5.4 7/7(意外 — 新版没全面超越) / 5.5 biology 5/7 vs 5.4 4/7(5.5 略好)
- **Gemini 3.1 Pro 唯一亮点**:longctx 3/7 是全场最高(GPT 都只 2/7),Google 长上下文能力底子好

**S 档失分项(共有)**:
- 🔴 **biology**:三家都不行(4/7-5/7),GPQA Biology 19 题样本太小且偏 niche 研究
- 🔴 **longctx**:三家都 ≤ 3/7,LongBench-V2 跨段推理是当前 LLM 普遍硬上限

---

### A 档(70-80%)— 国产/闭源强者

| 模型 | 总分 | math | phy | chem | bio | longctx | code | med | fin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **DeepSeek V4-Pro** | 78.6% | 5/7 | 7/7 | 6/7 | 3/7 | 3/7 | 6/7 | 7/7 | 7/7 |
| **MiMo 2.5 Pro** ⭐ | 76.8% | 6/7 | 7/7 | 5/7 | 4/7 | 2/7 | 5/7 | 7/7 | 7/7 |

**A 档同档对比**:
- **MiMo vs DS V4-Pro**:MiMo math 6/7 vs DS 5/7(数学小赢)/ MiMo biology 4/7 vs DS 3/7(生物小赢)
- **DS V4-Pro 优势**:longctx 3/7 跟 Gemini 3.1 Pro 并列最高 / chemistry 6/7 比 MiMo 5/7 强
- **DS V4-Pro 弱项**:math 5/7 偏低(同档 MiMo 都 6/7)
- **MiMo 弱项**:code 5/7(同档 DS 6/7,S 档普遍 7/7) / longctx 仅 2/7(差 DS 一档)

**A 档关键意义**:
- **DS V4-Pro = 国产闭源最强**(78.6% 距 S 档仅 5%)
- **MiMo 2.5 Pro 国产之光**:小米 76.8% 仅次于 OpenAI / Google / DeepSeek 三家国际/老牌,**国产新势力独一份**

---

### B 档(60-70%)— 中端 + 开源

| 模型 | 总分 | math | phy | chem | bio | longctx | code | med | fin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **Gemini 3 Flash** | 69.6% | 5/7 | 5/7 | 5/7 | 3/7 | 2/7 | **7/7** | 5/7 | 7/7 |
| **Qwen3.6-35B-A3B (5090)** | 67.9% | 6/7 | 6/7 | 5/7 | 2/7 | **0/7** ¹ | 6/7 | 6/7 | 7/7 |
| HY3 (Hy3-Preview) | 62.5% | 5/7 | 5/7 | 4/7 | 2/7 | 1/7 | 6/7 | 6/7 | 6/7 |
| MiniMax M2.7 | 62.5% | 5/7 | 6/7 | 2/7 | 2/7 | 2/7 | 6/7 | 5/7 | 7/7 |
| Gemini 3.1 Flash-Lite | 60.7% | 5/7 | 4/7 | 1/7 | 3/7 | 1/7 | **7/7** | 6/7 | 7/7 |

¹ 5090 32K ctx 物理装不下 50-200K chars 长题,**非能力问题**

**B 档同档对比**:
- **Gemini 3 Flash vs Qwen3.6-35B-A3B (5090)**:
  - Gemini 3 Flash code 7/7(满分)/ math 5/7,Qwen3.6-35B math 6/7 / code 6/7
  - Gemini 优势 code(Google 编程基因好) / Qwen 优势 math+physics(开源 + thinking 模式)
- **HY3 vs MiniMax M2.7**(并列 62.5%):
  - HY3 chem 4/7 vs MiniMax 2/7(HY3 化学好)/ HY3 medical 6/7 vs MiniMax 5/7
  - MiniMax physics 6/7 vs HY3 5/7 / MiniMax finance 7/7 vs HY3 6/7
- **Gemini 3.1 Flash-Lite (60.7%) vs HY3 (62.5%)**:
  - Flash-Lite code 7/7 vs HY3 6/7 / Flash-Lite biology 3/7 vs HY3 2/7
  - HY3 chemistry 4/7 vs Flash-Lite 1/7(Flash-Lite 化学暴雷)/ HY3 finance 6/7 vs Flash-Lite 7/7

**B 档关键意义**:
- **Qwen3.6-35B-A3B 67.9% = 开源最强**,跟商用 Gemini 3 Flash 几乎并肩(差 1.7%)
- **5090 双卡本地部署**,纯本地推理,无 API 费(月固定服务器成本 ~¥4000)
- **Flash-Lite 60.7% 价格便宜**,适合大批量低难度场景
- **Qwen 弱项**:longctx 0/7(32K ctx)、biology 2/7

---

### C 档(50-60%)— 性价比备选

| 模型 | 总分 | math | phy | chem | bio | longctx | code | med | fin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **DeepSeek V4-Flash** | 58.9% | 5/7 | 5/7 | 4/7 | 2/7 | 1/7 | 6/7 | **3/7** | 7/7 |
| **GLM-5-Turbo** | 58.9% | 5/7 | 6/7 | **1/7** | 2/7 | 1/7 | 4/7 | 7/7 | 7/7 |
| GLM-5.1 | 57.1% | 5/7 | 6/7 | 2/7 | 2/7 | **0/7** | 5/7 | 6/7 | 6/7 |

**C 档同档对比**:
- **DS V4-Flash vs GLM-5-Turbo**(并列 58.9%,但失分项完全不同):
  - DS V4-Flash medical **3/7**(同档其他 6-7/7 — DS Flash 医学专项弱)/ chem 4/7
  - GLM-5-Turbo chemistry **1/7**(同档其他 4-7/7 — GLM-Turbo 化学完全 broken)/ code 4/7 / medical 7/7 满分
  - **互补**:DS Flash 强 medical+code,GLM-5-Turbo 强 medical(7/7)
- **GLM-5.1 vs GLM-5-Turbo**(同家智谱):
  - GLM-5-Turbo medical 7/7 vs 5.1 6/7,Turbo chem 1/7 vs 5.1 2/7(Turbo 化学更弱)
  - 5.1 longctx 0/7 vs Turbo 1/7(差不多都不行)

**C 档关键意义**:
- 综合 ~57-59%,跟 B 档相比差距 5-10%,主要在 chemistry / code / longctx 落后
- **价格便宜**(DS V4-Flash 跟 V4-Pro 同 API,Flash 出 token 便宜),适合大批量任务

---

### D 档(< 50%)— 末位

| 模型 | 总分 | math | phy | chem | bio | longctx | code | med | fin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **Kimi K2.6** | 48.2% | 4/7 | 4/7 | **0/7** | 2/7 | 1/7 | 6/7 | 4/7 | 6/7 |

**D 档失分项**:
- chemistry **0/7** 完全不会(全场最差)
- math 4/7 / physics 4/7(同档 5-7/7)
- medical 4/7(C 档普遍 6-7/7)

**D 档关键意义**:Kimi K2.6 综合 48.2% 末位,化学完全放空,**学术硬题不推荐**(但 V8 中文实战 28/30 = 93.3% 仍合格,适合中文聊天/创作)。

---

## 三、跨档对比 8 维度热力图

每维度满分 7,**🔥** = 满分 / **🔵** = 强(5-6) / **🟡** = 中(3-4) / **🔴** = 弱(0-2)

| 模型 | math | phy | chem | bio | longctx | code | med | fin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| GPT-5.4 | 🔥7 | 🔥7 | 🔥7 | 🟡4 | 🔴2 | 🔥7 | 🔥7 | 🔥7 |
| GPT-5.5 | 🔥7 | 🔥7 | 🔥7 | 🔵5 | 🔴2 | 🔥7 | 🔥7 | 🔵6 |
| Gemini 3.1 Pro | 🔥7 | 🔥7 | 🟡4 | 🔵5 | 🟡3 | 🔥7 | 🔥7 | 🔥7 |
| DS V4-Pro | 🔵5 | 🔥7 | 🔵6 | 🟡3 | 🟡3 | 🔵6 | 🔥7 | 🔥7 |
| MiMo 2.5 Pro | 🔵6 | 🔥7 | 🔵5 | 🟡4 | 🔴2 | 🔵5 | 🔥7 | 🔥7 |
| Gemini 3 Flash | 🔵5 | 🔵5 | 🔵5 | 🟡3 | 🔴2 | 🔥7 | 🔵5 | 🔥7 |
| Qwen3.6-35B-A3B | 🔵6 | 🔵6 | 🔵5 | 🔴2 | 🔴0¹ | 🔵6 | 🔵6 | 🔥7 |
| HY3 | 🔵5 | 🔵5 | 🟡4 | 🔴2 | 🔴1 | 🔵6 | 🔵6 | 🔵6 |
| MiniMax M2.7 | 🔵5 | 🔵6 | 🔴2 | 🔴2 | 🔴2 | 🔵6 | 🔵5 | 🔥7 |
| Gemini 3.1 Flash-Lite | 🔵5 | 🟡4 | 🔴1 | 🟡3 | 🔴1 | 🔥7 | 🔵6 | 🔥7 |
| DS V4-Flash | 🔵5 | 🔵5 | 🟡4 | 🔴2 | 🔴1 | 🔵6 | 🟡3 | 🔥7 |
| GLM-5-Turbo | 🔵5 | 🔵6 | 🔴1 | 🔴2 | 🔴1 | 🟡4 | 🔥7 | 🔥7 |
| GLM-5.1 | 🔵5 | 🔵6 | 🔴2 | 🔴2 | 🔴0 | 🔵5 | 🔵6 | 🔵6 |
| Kimi K2.6 | 🟡4 | 🟡4 | 🔴0 | 🔴2 | 🔴1 | 🔵6 | 🟡4 | 🔵6 |

¹ 5090 32K ctx 物理限制

### 维度档位横向看
- **finance**:9 家 🔥7 满分(头部最饱和)
- **medical**:5 家 🔥7 满分,异常掉档:DS V4-Flash 🟡3 / Kimi 🟡4
- **code_algo**:5 家 🔥7(GPT-5.4/5.5/Gemini 3.x 三家),底部 GLM-5-Turbo 🟡4
- **physics**:5 家 🔥7 满分(头部 + DS V4-Pro / MiMo)
- **math**:三家 🔥7,但有意思的是 Qwen3.6-35B / MiMo 2.5 Pro 也 🔵6,跟 Top 1 差距小
- **chemistry**:**断层最大**,GPT 🔥7 / DS V4-Pro 🔵6 → MiMo 🔵5 → Gemini 3.1 Pro 🟡4 → Kimi 🔴0
- **biology**:**全家弱**,最高 🔵5(GPT-5.5 / Gemini 3.1 Pro 唯二),没满分
- **longctx**:**最弱维度**,最高 🟡3(DS V4-Pro / Gemini 3.1 Pro),所有 GPT 都 🔴2

---

## 四、关键发现 10 条

### 1. 三强鼎立(< 2 分内)
GPT-5.4 / GPT-5.5(并列 85.7%)+ Gemini 3.1 Pro(83.9%),**Google 这一代 Pro preview 真追上 GPT** — 推翻"Gemini 弱于 GPT" 的旧认知。

### 2. 国产之光:MiMo 2.5 Pro
小米 MiMo 2.5 Pro **76.8% 第 5**,仅次于 OpenAI / Google / DeepSeek 三家。**国产新势力独一份**(下面就是 Gemini 3 Flash 和开源 35B-A3B)。

### 3. Qwen3.6-35B-A3B 开源最强
67.9% 第 7,跟 Gemini 3 Flash 几乎并肩(差 1.7%)。**5090 本地部署 = 开源能跑赢商用便宜版**。

### 4. Google 3.x 全家亮眼
- 3.1 Pro 83.9%(Top 3)/ 3 Flash 69.6%(B 档头) / 3.1 Flash-Lite 60.7%(B 档尾)
- **code_algo Gemini 3.x 全家 7/7 满分** — 编程能力有结构性优势

### 5. HY3 推翻旧记录
之前 v9-final.json 历史 HY3 在 Tier C 末位(50%),本次 62.5% 第 8,**比 GLM-5.1 / Kimi 都强**。OpenRouter `:free` 还免费(2026-05-08 截止),性价比之王。

### 6. longctx 是全家死穴
没有任何一家 > 3/7,即使 GPT/Gemini Top 也最多 3/7。**LongBench-V2 多文档跨段推理是 LLM 硬上限,下一代主战场**。

### 7. chemistry 维度断层最大
GPT-5.4/5.5 🔥7/7 满分 → DS V4-Pro 🔵6 → MiMo 🔵5 → Gemini 3.1 Pro 🟡4 → MiniMax 🔴2 → 多家 🔴1 → **Kimi 🔴0/7**(化学完全放空)

### 8. biology 全家阵亡区
最高 🔵5/7(GPT-5.5 / Gemini 3.1 Pro 唯二),其余都 ≤ 4/7。GPQA Biology 题目偏 niche → 所有家都吃力。

### 9. DS V4-Flash medical 异常掉档
DS V4-Flash 多数维度合格,但 medical 仅 🟡3/7(同档其他 🔵6-🔥7) — 医学题专项弱点。

### 10. GLM-5-Turbo chemistry 几乎放空
GLM-5-Turbo medical 满分🔥7/7 但 chemistry 只 🔴1/7,**跨维度极不均衡**。

---

## 五、模型接入方式 + 月度成本

| 模型 | 接入 | 月度成本估算 |
|---|---|---|
| GPT-5.4 / 5.5 | Codex OAuth | **¥0**(走 ChatGPT 订阅) ⭐ |
| Gemini 3.x | Google AI Studio | **¥0**(1500 RPD free) |
| MiMo 2.5 Pro | Token Plan | ¥659/月 1.6 亿 Credits |
| DeepSeek V4-Pro/Flash | DeepSeek API | ¥30-100/月 |
| HY3 | OpenRouter `:free` | **¥0**(2026-05-08 截止) |
| Qwen3.6-35B-A3B | 5090 本地 vLLM | ¥4000/月(服务器固定) |
| MiniMax M2.7 | MiniMax API | ¥50-150/月 |
| GLM-5-Turbo / 5.1 | 智谱 Coding | ¥199/月 |
| Kimi K2.6 | Moonshot Coding | ¥69-199/月 |

**最高性价比组合**(brain 多模型路由):
- 默认 chat:Gemini 3.x via GAS(免费 + 强)
- 推理 / 工具:MiMo 2.5 Pro(国产稳)
- 难题:GPT-5.4 via Codex OAuth(订阅免费,Top 1)
- 创作:DeepSeek V4-Pro(中文好)

---

## 六、数据可信度 + Caveats

### Verifier Bug 修复历史(透明披露)
1. **V9 code_algo numpy 缺失**:HumanEval+ tests 强制 `import numpy`,本机 venv 没装 → 全家 0/3。装 numpy 后重判 18 次 flip。
2. **V9 math tail-number fallback**:Gemini Pro 等不爱用 `\boxed{}`,直接 `a+b = 510`。Verifier 加尾段数字匹配,9 次 flip(Gemini 3.1 Pro 直接进 Top 3)。

### EXCLUDED 模型
- **Qwen3.6-Plus**:DashScope 余额耗尽
- **Step-3.5-Flash**:Star 套餐到期
- **Gemini 2.5 Pro / 2.5 Flash**:Google 模型已有 3.x 系列 3 个 SKU,留新代足够

### 已知不公平因素
- **5090 35B-A3B longctx 0/7**:32K ctx 装不下 50K+ chars 题,物理限制(双 5090 64GB 跑 128K 实测 OOM)
- **V9 sql 3 题**:syntactic verifier 字符串比对 → 全家 0/3 → 排除总分
- **5090 27B-FP8 / 27B-NVFP4**:vLLM 0.20 不支持 LinearAttention 架构 silent crash,等 vLLM 0.21+;**Spark SGLang 跑 27B-NVFP4 后台测试中**,完成后 update 报告到 15 家

---

## 附录:测试规模

- **总推理次数**:14 家 × 59 题 = 826 次
- **数据存储**:`tests/benchmarks/v9-comprehensive/results/batch56-20260505-092305/`
- **harness**:harness_v9.py(Python urllib + 5 verifier)/ harness_v9_gpt5.py(Codex OAuth)/ harness_v9_gemini.py(CLI spawn)/ harness_v9_gemini_api.py(Google AI Studio)
- **复现**:全部 results.json + harness 代码 + verifier 代码已 commit 到仓库

---

**评测署名**:Lynn 项目 / @MerkyorLynn
