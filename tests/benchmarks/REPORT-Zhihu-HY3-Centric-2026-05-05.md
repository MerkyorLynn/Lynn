# 腾讯混元 Hy3-Preview 横评:免费 OpenRouter 接入,V9 学术硬题第 8,比 GLM-5.1 / Kimi 都强 — 2026-05-08 截止

> Lynn 项目第 10 轮 LLM 测评 · HY3 (Hy3-Preview) 中心专题
> OpenRouter 上 `tencent/hy3-preview:free` — 完全免费(只剩 3 天)
> 题集:V9 56 题学术硬题(8 维度博士级 + 自创金融)

---

## 一、为什么单独写 HY3?

V9 14 家横评里,HY3 (Hy3-Preview) 排第 8,**62.5%**。这个数字本身没什么 — 但有几件事让它值得单独一篇:

1. **完全免费**:OpenRouter `tencent/hy3-preview:free` 不消耗 OR free credit,**纯 0 元用**
2. **2026-05-08 截止**:只剩 3 天就转 paid,想白嫖的赶紧
3. **推翻旧记录**:之前 v9-final.json 历史记录 HY3 在 Tier C 末位(50%),这次 62.5% 直接进 B 档
4. **比 GLM-5.1 / Kimi K2.6 都强**:同价位竞品里 HY3 完胜
5. **腾讯混元 3.0 preview**:Hunyuan 内部代号 "Hy3",Lynn project memory 之前一直误判为"Tier C 末位",**实测推翻**

---

## 二、HY3 横向对比:同档 + 上下档 6 家

| # | 模型 | V9 56 | math | phy | chem | bio | longctx | code | med | fin | 接入 |
|:-:|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| 5 | MiMo 2.5 Pro | 76.8% | 6/7 | 7/7 | 5/7 | 4/7 | 2/7 | 5/7 | 7/7 | 7/7 | Token Plan ¥659/月 |
| 6 | Gemini 3 Flash | 69.6% | 5/7 | 5/7 | 5/7 | 3/7 | 2/7 | 7/7 | 5/7 | 7/7 | GAS 免费 |
| 7 | Qwen3.6-35B-A3B (5090 本地) | 67.9% | 6/7 | 6/7 | 5/7 | 2/7 | 0/7¹ | 6/7 | 6/7 | 7/7 | 5090 ¥4000/月 |
| **8T** | **HY3 (Hy3-Preview)** ⭐ | **62.5%** | **5/7** | **5/7** | **4/7** | **2/7** | **1/7** | **6/7** | **6/7** | **6/7** | **OpenRouter `:free` ¥0** |
| 8T | MiniMax M2.7 | 62.5% | 5/7 | 6/7 | 2/7 | 2/7 | 2/7 | 6/7 | 5/7 | 7/7 | API ¥50-150/月 |
| 10 | Gemini 3.1 Flash-Lite | 60.7% | 5/7 | 4/7 | 1/7 | 3/7 | 1/7 | 7/7 | 6/7 | 7/7 | GAS 免费 |
| 11T | DeepSeek V4-Flash | 58.9% | 5/7 | 5/7 | 4/7 | 2/7 | 1/7 | 6/7 | 3/7 | 7/7 | API 便宜 |
| 11T | GLM-5-Turbo | 58.9% | 5/7 | 6/7 | 1/7 | 2/7 | 1/7 | 4/7 | 7/7 | 7/7 | 智谱 ¥199/月 |
| 13 | GLM-5.1 | 57.1% | 5/7 | 6/7 | 2/7 | 2/7 | 0/7 | 5/7 | 6/7 | 6/7 | 智谱 ¥199/月 |
| 14 | Kimi K2.6 | 48.2% | 4/7 | 4/7 | 0/7 | 2/7 | 1/7 | 6/7 | 4/7 | 6/7 | Moonshot ¥69-199/月 |

¹ 5090 32K ctx 物理装不下 50K+ chars 题

---

## 三、HY3 vs MiniMax M2.7(并列 62.5% 同档对决)

两家分数完全一样,但**得失项完全不同**:

| 维度 | HY3 | MiniMax M2.7 | 谁强 |
|---|:-:|:-:|---|
| math | 5/7 | 5/7 | 平 |
| **physics** | 5/7 | **6/7** | MiniMax 略强 |
| **chemistry** | **4/7** | 2/7 | **HY3 大胜**(MiniMax 化学暴雷) |
| biology | 2/7 | 2/7 | 平 |
| longctx | 1/7 | 2/7 | MiniMax 略强 |
| code | 6/7 | 6/7 | 平 |
| **medical** | **6/7** | 5/7 | **HY3 略强** |
| finance | 6/7 | **7/7** | MiniMax 满分 |

**总结**:
- **HY3 强项**:chemistry 4/7(MiniMax 仅 2/7,这一项让 HY3 在化学场景明显占优)+ medical 6/7
- **MiniMax 强项**:physics + finance + longctx

**场景推荐**:
- **化学/医学相关业务** → HY3(免费 + 这两项 4-6/7 同档第一)
- **金融分析/物理工程** → MiniMax M2.7(finance 7/7 满分)

---

## 四、HY3 vs GLM-5.1(向下对比 5 分内)

GLM-5.1 商用 ¥199/月 vs HY3 免费,差距 5.4%:

| 维度 | HY3 (62.5%) | GLM-5.1 (57.1%) | 差距 |
|---|:-:|:-:|---|
| math | 5/7 | 5/7 | 0 |
| physics | 5/7 | 6/7 | GLM +1 |
| chemistry | **4/7** | 2/7 | **HY3 +2** |
| biology | 2/7 | 2/7 | 0 |
| longctx | 1/7 | 0/7 | HY3 +1 |
| code | 6/7 | 5/7 | HY3 +1 |
| medical | **6/7** | 6/7 | 0 |
| finance | 6/7 | 6/7 | 0 |

**HY3 优势**:chemistry(+2)+ code(+1)+ longctx(+1)
**GLM-5.1 优势**:physics(+1)
**净差**:HY3 +3 分

**结论**:**HY3 全面碾压 GLM-5.1**,而且免费 vs ¥199/月。

---

## 五、HY3 vs Kimi K2.6(向下对比 14 分)

Kimi K2.6 末位 48.2%,HY3 大胜 14.3%:

| 维度 | HY3 | Kimi K2.6 | 差距 |
|---|:-:|:-:|---|
| math | 5/7 | 4/7 | HY3 +1 |
| physics | 5/7 | 4/7 | HY3 +1 |
| **chemistry** | 4/7 | **0/7** | **HY3 +4(Kimi 化学完全放空)** |
| biology | 2/7 | 2/7 | 0 |
| longctx | 1/7 | 1/7 | 0 |
| code | 6/7 | 6/7 | 0 |
| medical | 6/7 | 4/7 | HY3 +2 |
| finance | 6/7 | 6/7 | 0 |

**Kimi K2.6 唯一不输的**:code / longctx / biology / finance(都跟 HY3 平)
**HY3 全面优势**:chemistry(+4 决定性差距)+ math + physics + medical

**结论**:Kimi K2.6 学术硬题不行(chemistry 0/7),但 V8 中文实战仍合格(28/30)。HY3 免费 + 学术更全。

---

## 六、HY3 vs Gemini 3.1 Flash-Lite(向上对比 1.8 分)

Flash-Lite 60.7% vs HY3 62.5%(HY3 略强):

| 维度 | HY3 | Flash-Lite | 谁强 |
|---|:-:|:-:|---|
| math | 5/7 | 5/7 | 平 |
| physics | 5/7 | 4/7 | HY3 +1 |
| **chemistry** | **4/7** | 1/7 | **HY3 +3(Flash-Lite 化学暴雷)** |
| biology | 2/7 | 3/7 | Flash-Lite +1 |
| longctx | 1/7 | 1/7 | 0 |
| **code** | 6/7 | **7/7** | **Flash-Lite +1(满分)** |
| medical | 6/7 | 6/7 | 0 |
| finance | 6/7 | 7/7 | Flash-Lite +1 |

**HY3 决定性优势**:chemistry +3(Flash-Lite 化学只 1/7 暴雷)
**Flash-Lite 优势**:code 满分 + finance 满分

**场景推荐**:
- **代码/财务密集场景** → Gemini 3.1 Flash-Lite(GAS 免费)
- **化学/通用学术场景** → HY3(免费,化学 4/7 比 Flash-Lite 1/7 强 3 倍)

---

## 七、HY3 接入方式(实操指南)

### 配置 OpenRouter API

```bash
# 1. 注册 OpenRouter (https://openrouter.ai),拿一个 sk-or- key
export OPENROUTER_KEY=sk-or-v1-...

# 2. 直接用 OpenAI compatible client
curl https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tencent/hy3-preview:free",
    "messages": [{"role": "user", "content": "用一句话介绍北京"}],
    "max_tokens": 100
  }'
```

### Lynn brain 接入(实战范例)

我自己 brain 端的 PROVIDERS 配置(harness_v9.py):

```python
{
    "name": "HY3 (Hy3-Preview)",
    "url": (os.environ.get("OPENROUTER_BASE") or "https://openrouter.ai/api/v1") + "/chat/completions",
    "key": os.environ.get("OPENROUTER_KEY"),
    "model": "tencent/hy3-preview:free",
    "max_tokens": 16384,
    "headers_extra": {"HTTP-Referer": "https://github.com/MerkyorLynn/Lynn", "X-Title": "Lynn"},
}
```

**注意**:`tencent/hy3-preview:free` 后缀 `:free` 是关键 — 免费版不消耗 OR credit。**OR free tier account 也能调**(我的 OR 是 free 账户,本次评测全程不花钱)。

---

## 八、HY3 的真实定位 + 何时应该用

### 优势场景
- ✅ **免费 + 实测 V9 62.5% 第 8(B 档头部)** — 性价比之王
- ✅ **chemistry 4/7 同档第一**(MiniMax 2/7,Flash-Lite 1/7)
- ✅ **medical 6/7**(同档普遍 5-6/7,HY3 在 top)
- ✅ **腾讯混元 3.0 preview** — 大厂背书,稳定性高

### 劣势场景
- ❌ **longctx 1/7**:50K+ chars 长文档不行(全家都不行,但 HY3 在中下)
- ❌ **biology 2/7 + finance 6/7**:不算 top
- ❌ **2026-05-08 截止 free** — 转 paid 后性价比就没了

### 我的 brain 路由建议

把 HY3 放在 chatOrder 第 4-5 位作为 **fallback 链中下游**:

```
brain chatOrder:
  1. Gemini 3 Flash (GAS, 免费, B 档头, code 满分)
  2. MiMo 2.5 Pro (Token Plan, ¥659/月, A 档第二, 国产稳)
  3. DeepSeek V4-Pro (API, 中文好, 全维度均衡)
  4. HY3 (OpenRouter :free, 免费, B 档,化学医学优势)  ← HY3 here
  5. Qwen3.6-35B-A3B 5090 (本地兜底,网络抖时用)
  6. GLM-5-Turbo (智谱 ¥199/月,medical 满分备选)
  ...
```

5-08 截止后 HY3 转 paid,可能从第 4 位降到第 7-8 位(看 paid 价格定)。

---

## 九、为什么 v9-final.json 历史记录 HY3 是 Tier C 末位 50%?

memory 里 Lynn 项目之前测评数据:
> "Hy3-Preview V9 完整 27 题已测 12/24=50% rank 9-10 跟 Kimi K2.6 并列 Tier C 末位"

本次 V9 56 题(扩到 56 题后)HY3 35/56 = 62.5%。两次差距:
- 旧:24 题,12/24 = 50%
- 新:56 题(扩 32 题),35/56 = 62.5%

**真正原因 — verifier 修复**:
1. 旧 verifier numpy 缺失 → code_algo 全家 0/3,**HY3 同样吃亏**
2. 旧 verifier math 不接受自然语言尾段 → AIME 题 HY3 写"答案是 17"会被判 fail
3. 我修了 18+9 次 flip 后,HY3 真分浮出 — 62.5%

所以 "HY3 50%" 的旧标签是 **verifier bug 误判**,不是 HY3 真实能力。**这次 14 家 verifier 都修好了,HY3 真位 = B 档第 8**(并列 MiniMax,比 GLM/Kimi 强)。

---

## 十、总结:5-08 之前的免费窗口

| | |
|---|---|
| **截止日期** | **2026-05-08**(只剩 3 天) |
| **接入** | OpenRouter `tencent/hy3-preview:free` |
| **成本** | ¥0(OR free tier 也能调) |
| **V9 实测** | 35/56 = **62.5%(B 档第 8)** |
| **碾压对象** | GLM-5.1(57.1%,¥199/月)/ Kimi K2.6(48.2%,¥69-199/月) |
| **打平对象** | MiniMax M2.7(¥50-150/月)/ Gemini 3.1 Flash-Lite |
| **被超对象** | Qwen3.6-35B-A3B(本地 ¥4000/月)/ Gemini 3 Flash(GAS 免费但 GFW) |
| **强项** | chemistry 4/7 同档第一,medical 6/7 |
| **弱项** | longctx 1/7,biology 2/7 |

5-08 之后转 paid,我会重新评估它的性价比定位。但**这 3 天不用白不用**。

---

**评测署名**:Lynn 项目 / @MerkyorLynn
**主稿**(14 家完整横评):见 `REPORT-Zhihu-V9-Main-2026-05-05.md`
**仓库**:https://github.com/MerkyorLynn/Lynn
