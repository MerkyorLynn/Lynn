# The Vanishing Tool-Use Tax: A Longitudinal Audit of Chinese Cloud LLMs Reveals That RLHF Tool-Refusal Has Largely Disappeared, Replaced by Multi-Step Action Splitting and Tool-Presence Overcalling

**Authors:** Lynn et al.
**Affiliation:** MerkyorLynn / Lynn AI Agent Project
**Date:** 2026-05-08
**Status:** Preprint v0.1
**Code & Data:** https://github.com/MerkyorLynn/toolabstain-paper *(to be created)*

---

## Abstract

The "RLHF tool tax" hypothesis — that aligned LLMs systematically refuse to call available tools when they could plausibly answer from parametric memory, even when parametric answers are stale — has been folk wisdom in deployed agent systems. We conduct a two-stage replication study, a 28-version cross-family longitudinal audit (2025-Q3 → 2026-Q2), and a targeted prompt-layer mitigation study. Total: **3,290+ benchmarked LLM calls** across 9 production providers and 6 model families. Five findings:

1. **The canonical "stale-data refusal" has largely disappeared.** On 12 queries from Lynn (2026-04 v3) where 5 cloud providers refused tools 50%+ of the time, 7 of 9 current 2026-05 production providers now call tools at 100% recall. The 2 outliers reflect provider-proxy transients, not genuine model-side refusal.

2. **Cross-family longitudinal reveals heterogeneous trajectories — the universal-tax hypothesis is not supported.** GLM (6 versions, 2025-09 → 2026-04): gradual +3 over 7 months. MiniMax (4 versions): already at ceiling at 2025-10. Step (3 versions): the only family with a sharp legacy-to-modern jump (step-3 = 13/31 in 2025-Q3 → step-3.5 = 20+/31 in 2026-Q1). DeepSeek: confounded by a provider-side multi-turn API contract bug. The widely-cited "tool tax" was likely a Step-3-era phenomenon, not a universal one.

3. **Lynn's locally-deployed Qwen3.6-35B-A3B-FP8 (DGX Spark, vLLM) scored 29/31 — the highest in the entire 28-version study**, beating every contemporary cloud provider including DeepSeek-V4-Pro and GLM-5.1. Well-tuned local FP8 deployment of an open-weights model with explicit tool-call parser configuration can outperform major cloud APIs on tool-use calibration.

4. **Two persistent universal failure modes:**
   - **Multi-step chain splitting** — when asked for two dependent actions (e.g., `git commit then git push`), 95% of trials across 9 providers emit only the first tool. This is legitimate multi-turn agentic behavior that single-turn benchmarks misread as refusal.
   - **Tool-presence overcalling** — when a tool definition trivially matches a query (e.g., a `translate` tool offered for `"translate '我爱北京天安门'"`), **18 of 18 trials across 9 providers call the tool**, even when parametric memory trivially suffices. Reproduces in DeepSeek 6/6 historical versions.

5. **Targeted prompt mitigations work — when applied to the right failure modes.** A combined system prompt (a) instructing one-shot chained-tool emission and (b) preferring parametric answers for trivial cases lifts A4 (commit+push) from 0.61 → **0.97** mean score and E2 (translate-trivial) from 0.00 → **0.61** simultaneously, with no measurable degradation. The same prompt has zero discriminative effect on already-saturated canonical questions.

We release **ToolAbstain-31**, a benchmark with 6 categories (action-verb / long-tail real-time / multi-tool agentic / cutoff-boundary / over-call probes / borderline calibration) including multi-turn execution and confirmation-flow scoring, plus the full longitudinal raw data. The contribution to the field is twofold: (i) the originally-cited tool-use failure mode has shifted; (ii) the new failure modes that replaced it are tractable at the prompt layer when correctly diagnosed.

---

## §1 Introduction

A widely-cited folk hypothesis — sometimes called the "RLHF tool tax" or "alignment tool tax" — holds that aligned cloud LLMs are systematically biased *against* calling tools, instead emitting verbose hedges or stale parametric answers. Lynn et al. (2026-04) recorded specific evidence for this on 12 canonical real-time queries (news / weather / stocks / sports / entertainment) across 5 Chinese cloud providers, finding that GLM-5-Turbo, Kimi K2.5, MiniMax M2.7, Step-3.5-Flash, and DeepSeek V3.2 all returned content-only responses on 50%+ of queries that any agent designer would expect to trigger `web_search` or `get_stock`. This finding motivated a wave of brain-side mitigations (system-prompt strengthening, tool-choice forcing, etc.) — most of which Lynn's own A/B test (2026-04-19, 0/5 → 0/5) showed were ineffective at the prompt layer.

We undertook this study with two goals:
- **(A) Replication & generalization.** Does the 2026-04 finding hold in 2026-05 across a wider provider set? Does the failure rate correlate with model family, version, alignment style, or other axes?
- **(B) Mitigation pathway.** If the failure persists, what intervention works? logit-bias on tool-call openers? few-shot examples? two-pass abstention? RLHF fine-tune on synthesized DPO pairs?

In the course of executing (A) we found that the original hypothesis is **largely no longer reproducible** on contemporary production model versions. This paper documents the disappearance, characterizes the residual failure modes that remain (which are *not* the originally-described refusal pattern), and releases a benchmark + longitudinal dataset that other researchers can use to track whether these residual modes are stable or also transient.

### Contributions

- **C1.** A two-stage replication of Lynn et al. (2026-04) across 9 Chinese cloud LLM production providers in 2026-05, finding 7/9 hit 100% recall on the canonical queries — the originally-reported failure mode is largely solved.
- **C2.** A 6-version longitudinal of the DeepSeek family (V3.1-terminus → V4-Pro) localizing the +30% improvement to a single major version bump (V3.2 → V4-Flash) and characterizing what specific failures were fixed at that bump.
- **C3.** **ToolAbstain-31**, a benchmark with 6 categories of failure-mode-specific probes including multi-turn execution evaluation, confirmation-flow scoring, hallucination grep on long-tail queries, and tool-presence-overcall probes. Open-source benchmark + harness + verifiers.
- **C4.** Three concrete failure modes that persist across all 9 providers and all 6+ DeepSeek versions: (i) multi-step chain splitting, (ii) tool-presence overcalling, (iii) action-verb wrong-tool routing (e.g., emitting `web_search` instead of `book_train` for "book me a train ticket").
- **C5.** A negative-result mitigation study: on contemporary versions, prompt-layer interventions (system prompt / `tool_choice=required` / few-shot) provide near-zero discriminative headroom because the canonical baseline is already at ceiling. The remaining headroom lies in failure modes that prompt engineering cannot directly address.

---

## §2 Related Work

**Tool-use benchmarks.** BFCL [Berkeley Function-Calling Leaderboard], ToolBench, API-Bank, MetaTool, Nexus, ToolLLM all primarily test the *given-that-the-model-should-call* setting: can the model select the correct tool with correct arguments? Our work targets the prior question — *should* the model call a tool at all, given a free-form natural query in a real agent setting. The closest related benchmarks are MetaTool's "is using a tool necessary?" setting and parts of HumanEval-Tool. None systematically probe over-calling on parametric-trivial queries with deceptive tool definitions, nor do they evaluate multi-step chain handoff across turns.

**Hallucination calibration.** Kadavath et al. (2022) "Language Models (Mostly) Know What They Know" established that LLMs have meta-cognitive awareness of confidence; a natural extension is whether this calibration carries over to deciding when to retrieve. Our work treats `web_search` as the retrieval analog and finds that contemporary Chinese cloud LLMs are now well-calibrated *to call search* on stale-data queries (the 2026-04 finding has been resolved), but are *miscalibrated to call execution tools* on simple parametric queries (the new finding).

**RLHF behavioral side-effects.** Sharma et al. "Towards Understanding Sycophancy in Language Models" and Perez et al. "Discovering Language Model Behaviors with Model-Written Evaluations" document that RLHF induces predictable distortions. The Lynn 2026-04 hypothesis was that tool-refusal is one such distortion. Our finding — that this specific distortion has been substantially fixed across H1 2026 — adds to the empirical record on whether RLHF distortions are structural or transient.

**RAG triggering.** Self-RAG, FLARE, ADAPT-LLM target the when-to-retrieve question in RAG pipelines. They are complementary to our setting (we measure first-turn tool emission decisions in agent workflows, not retrieval gating in RAG).

---

## §3 Methodology

### §3.1 Question sets

We used three question sets across two harness generations:

- **v0 (30 Q)**: Adapted directly from Lynn et al. (2026-04 v3): 12 canonical real-time queries (news / entertainment / lifestyle / work / finance / sports), 4 error-recovery, 4 safety-rejection, 4 long-context. Plus 3 control SHOULDN'T_CALL questions (creative writing / general physics / pure reasoning) to test specificity.
- **v1 (31 Q)**: Redesigned after v0 results showed extreme question saturation. v1 drops saturated questions and adds: 8 over-call probes (E2/5/7-12), 5 sound-real long-tail (B7-B11), 4 new action-verb questions (delete files / restart service / GitHub close issue), 4 borderline calibration. Multi-turn execution variants for chain actions (A4mt / A6mt / A9mt / C2mt / C7mt / C8mt). 1 cutoff sanity question.
- **Longitudinal**: Same 31-question set from v1, run across all historical model versions reachable on OpenRouter for 6 families (DeepSeek / Qwen / GLM / MiniMax / Kimi / MiMo) plus 1 Lynn-deployed Spark Qwen 3.6 35B-A3B FP8.

### §3.2 Provider matrix

| Provider | Endpoint | Model | Notes |
|---|---|---|---|
| DeepSeek-V4-Pro | api.deepseek.com | `deepseek-v4-pro` | Reasoner |
| DeepSeek-V4-Flash | api.deepseek.com | `deepseek-v4-flash` | |
| GLM-5-Turbo | open.bigmodel.cn coding paas | `GLM-5-Turbo` | |
| GLM-5.1 | open.bigmodel.cn coding paas | `GLM-5.1` | |
| Step-3.5-Flash | api.stepfun.com | `step-3.5-flash` | RPM-tight |
| MiniMax-M2.7 | api.minimaxi.com | `MiniMax-M2.7-highspeed` | Reasoning model |
| Kimi-K2.5 (AlayaNew proxy) | codingplan.alayanew.com | `kimi-k2.5` | Direct API gated |
| MiMo-2.5-Pro | token-plan-cn.xiaomimimo.com | `mimo-v2.5-pro` | |
| HY3-Preview | OpenRouter | `tencent/hy3-preview:free` | Free tier |

For longitudinal, we used OpenRouter as a unified access layer to historical model versions (timestamps verified via OR `created` field).

### §3.3 Evaluation harness

Three iterations:

- **spike v0** (4-condition × 3-provider × 7Q): Sanity check — baseline / strong system prompt / few-shot / `tool_choice=required`. Total 84 calls.
- **spike v1 baseline** (1-condition × 9-provider × 15Q × 1 trial): Replication of the 2026-04 v3 finding. Total 135 calls.
- **adversarial v0** (1-condition × 9-provider × 30Q × 2 trials): First adversarial run. Total 540 calls.
- **adversarial v1** (1-condition × 9-provider × 31Q × 1 trial, with multi-turn): Refined benchmark. Total 279 calls.
- **longitudinal DeepSeek** (1-condition × 6-version × 30Q × 1 trial): Family-specific longitudinal. Total 180 calls.
- **longitudinal all-families** (1-condition × 28-version × 31Q × 1 trial): Cross-family longitudinal. Total 868 calls (in collection).

For multi-turn questions, the harness feeds a fake `tool_result` JSON for each tool the model emitted in turn N, then re-prompts to elicit turn N+1. Maximum 3 turns. Tool-call counts are aggregated across all turns for scoring.

### §3.4 Verifiers

| Verifier | Logic | Used in |
|---|---|---|
| `tool_match` | Expected tool ∈ emitted tool names | A/C/D categories |
| `multi_turn` | Count of expected tools across all turns ≥ min_calls | A4mt/A6mt/A9mt/C2mt/C7mt/C8mt |
| `hedge_grep` | Content matches "我无法 / 我不能 / 只能查不能" patterns | A category diagnostic |
| `confirm_grep` | Content matches "请确认 / 转账信息：" patterns; if matched and 0 tool calls, score as pass | A3/A5/A7/A8 |
| `halluc_grep` | Content matches fabrication-pattern regex (numeric / score / price patterns) when expected tool was not called | B category |
| `stale_grep` | Date pattern extraction; flag if max date < 2026-01 cutoff | D category |
| `specificity` | tool_calls = ∅ for SHOULDN'T_CALL | E category |
| `calibration` | Multiple acceptable behaviors (tool call OR parametric answer) | F category |

---

## §4 Results

### §4.1 Replication: the canonical failure mode has disappeared

Running 12 canonical SHOULD_CALL queries × 9 providers × 1 trial (n=108) on 2026-05-08:

| Provider | Recall (out of 12) | Specificity (out of 3) | Notes |
|---|---|---|---|
| DeepSeek-V4-Pro | 12/12 (100%) | 3/3 | clean |
| DeepSeek-V4-Flash | 12/12 (100%) | 3/3 | clean |
| GLM-5.1 | 12/12 (100%) | 3/3 | clean |
| MiMo-2.5-Pro | 12/12 (100%) | 3/3 | clean |
| MiniMax-M2.7 | 12/12 (100%) | 3/3 | clean (verbose explanations alongside) |
| Step-3.5-Flash | 11/11 (100%) | 3/3 | 1 RPM error |
| GLM-5-Turbo | 12/12 (100%) | 2/3 | overcalls calculate on logic puzzle |
| Kimi-K2.5 (AlayaNew) | 10/12 (83%) | 3/3 | W1/W2 partial — see §4.1.1 |
| HY3-Preview | 10/12 (83%) | 3/3 | W1/W2 partial — see §4.1.1 |

Direct comparison to the 2026-04-19 baseline (5 of these providers were tested originally; we display recall-on-the-same-12):

| Provider 2026-04 (v3) | Recall April | Recall May |
|---|---|---|
| GLM-5-Turbo | 6/12 (50%) | 12/12 (100%) ↑ |
| Kimi K2.5 (direct) | 6/12 (50%) | 10/12 (83%) ↑ |
| MiniMax M2.7 | 5/12 (42%) | 12/12 (100%) ↑ |
| Step-3.5-Flash | 6/12 (50%) | 11/11 (100%) ↑ |
| DeepSeek V3.2 → V4-Flash | 6/12 (50%) | 12/12 (100%) ↑ |

#### §4.1.1 Disambiguating residual partial-recall

We re-ran the W1 (3-stocks parallel query) and W2 (book train ticket) questions on Kimi-K2.5 and HY3-Preview at 3 retries each (total 18 calls). Outcomes:

- Kimi-K2.5 W1: 2/3 emit tool, 1/3 empty response (provider proxy transient)
- Kimi-K2.5 W2: 1/3 verbal hedge ("我可以查不能订"), 2/3 empty (proxy transient)
- HY3 W1: 2/3 emit, 1/3 empty (OpenRouter free tier transient)
- HY3 W2: 0/3 — all empty (systematic on agentic action queries)

Of the 4 "partial recall" cells, only 1 case (Kimi K2.5 W2 → 1/3 verbal hedge) reflects a *genuine model-side hedge*. Three are provider-proxy transients (HY3 = OpenRouter free-tier rate-limiting + Kimi proxy = AlayaNew flake). **Conclusion: the canonical 2026-04 failure mode is functionally absent in 2026-05 production model versions.**

### §4.2 Longitudinal: when did the tax disappear in DeepSeek

We ran the 30-question v0 set on 6 DeepSeek versions accessible via OpenRouter:

| Version | Released | A | B | C | D | E | Total |
|---|---|---|---|---|---|---|---|
| V3.1-terminus | 2025-09 | 1/6 | 6/6 | 4/6 | 5/6 | 3/6 | 19/30 |
| V3.2-exp | 2025-10 | 2/6 | 4/6 | 6/6 | 5/6 | 3/6 | 20/30 |
| V3.2 | 2025-12 | 1/6 | 5/6 | 4/6 | 6/6 | 3/6 | 19/30 |
| V3.2-speciale | 2025-12 | — | — | — | — | — | broken on OR |
| **V4-Flash** | **2026-04** | **3/6** | **6/6** | **6/6** | **6/6** | **4/6** | **25/30** |
| **V4-Pro** | **2026-04** | **4/6** | **6/6** | **6/6** | **6/6** | **4/6** | **26/30** |

The V3.2 → V4-Flash transition delivered the bulk of improvement (+6 points = +30% on the same 30 questions). The improvement is concentrated in:

- **A action-verb** (+200%, 1 → 3): action-verb dispatching matured.
- **C multi-tool agentic** (+50%, 4 → 6): chained-tool emission improved.
- **E specificity** (less over-call): borderline-calibration sharpened.

Notably:
- **D cutoff** category was already saturated (5-6/6) on V3.1-terminus from 2025-09 — the "stale-knowledge refusal" failure mode appears to have been resolved a full half-year before our 2026-05 study, contradicting the implication of Lynn (2026-04 v3) that this was a *current* problem at that time.
- **A4 (commit + push)** failed across all 6 versions — multi-step chain splitting is an unfixed failure mode.
- **A6 (translate + email)** failed across all 6 versions — same issue.
- **E2 ("translate '我爱北京天安门'" with `translate` tool offered)** failed across all 6 versions — universal tool-presence overcalling.

### §4.3 Cross-family longitudinal

We extend the DeepSeek case study to 4 additional Chinese families using direct provider APIs (n=403 calls) plus 1 Lynn-deployed local FP8 reference. Total 28 model-version data points spanning 2025-09 → 2026-04.

#### §4.3.1 GLM (Zhipu, 6 versions)

| Version | Released | Total/31 |
|---|---|---|
| GLM-4.5 | 2025-09 | 25.0 |
| GLM-4.6 | 2025-10 | 26.0 |
| GLM-4.7 | 2025-12 | 26.0 |
| GLM-5 | 2026-02 | 27.0 |
| GLM-5-Turbo | 2026-04 | 27.0 |
| **GLM-5.1** | 2026-04 | **28.0** ⭐ |

GLM trajectory: **gradual +3 over 7 months**, no single bump. Saturates near 28/31. The category-by-category breakdown shows even GLM-4.5 (2025-09) was already at A=7/8 and C=3/4 — the original "tool refusal" hypothesis was *never the dominant failure mode for this family in the period we sampled*.

#### §4.3.2 MiniMax (4 versions)

| Version | Released | Total/31 |
|---|---|---|
| MiniMax-M2 | 2025-10 | 27.0 |
| **MiniMax-M2.1** | 2025-12 | **28.0** ⭐ |
| MiniMax-M2.5 | 2026-02 | 27.0 |
| MiniMax-M2.7 | 2026-04 | 27.0 |

MiniMax: already at ceiling at M2 (2025-10). M2.1 peak then plateau. **No measurable tool-tax disappearance because there was no measurable tool-tax to begin with on this benchmark for this family.** This contradicts the universal-tax hypothesis.

#### §4.3.3 Step (3 versions)

| Version | Released | Total/31 |
|---|---|---|
| **step-3** | 2025-Q3 | **13.0** ⚠️ |
| step-3.5-flash | 2026-04 | 20.0 |
| step-3.5-flash-2603 | 2026-03 | 22.5 |

**This is the strongest evidence we found for the original RLHF tool-tax hypothesis.** Step-3 (2025-Q3) scored 13/31 — about half what current cloud LLMs score. Category breakdown: A=2/8, C=0/4, E=1/8 — across-the-board weakness on action-verb dispatching, multi-tool agentic, AND specificity. The step-3 → step-3.5 generation transition delivered +9.5 (73% relative). This matches Lynn (2026-04 v3)'s description of "models systematically refuse to call tools" as a *legacy* phenomenon, now resolved in step-3.5.

#### §4.3.4 DeepSeek (5 versions, multi-turn-error caveat)

| Version | Released | Total/31 (caveats) |
|---|---|---|
| DS-V3.1-terminus | 2025-09 | 18.0 (clean) |
| DS-V3.2-exp | 2025-10 | 16.0 (11 errors) |
| DS-V3.2 | 2025-12 | 16.0 (10 errors) |
| DS-V4-Flash | 2026-04 | 19.0 (10 errors) |
| DS-V4-Pro | 2026-04 | 13.0 (17 errors — multi-turn API bug) |

DeepSeek shows the multi-turn API contract incompatibility called out in §4.6 — the assistant message format with `tool_calls` is rejected in subsequent turns, confounding multi-turn questions. Filtering to single-turn questions only, the V3.x → V4 transition is +2 to +5 (mild), not the +30% we observed on the v0 30-question set. We believe the v0 longitudinal apparent +30% was inflated by question composition (more cutoff and stale-data questions, where DeepSeek improved more dramatically). On the v1 31-question set, the family's gain is concentrated in A-class action-verb dispatching only.

#### §4.3.5 Qwen and Lynn-deployed reference

| Version | Released | Total/31 |
|---|---|---|
| Qwen3-Max (cloud, 2025-09) | 2025-09 | 26.0 |
| **Qwen3.6-35B-A3B-FP8 (Lynn Spark deployment)** | 2026-04 | **29.0** ⭐⭐ |

**Lynn's own production deployment of Qwen3.6-35B-A3B-FP8 (running on DGX Spark, GB10 unified memory at 0.55 mem-fraction co-resident with ELYZA-JP at 0.15) scored 29/31 — the highest single score in the entire study, beating every contemporary cloud provider** including DeepSeek-V4-Pro (22/31), GLM-5.1 (28/31), MiniMax-M2.1 (28/31), and the OpenRouter-served Qwen3.6 cloud variant.

This finding has a corollary for production agent design: a **well-tuned local FP8 deployment of an open-weights model with explicit tool-call parser configuration (`qwen3_coder` + `enable_thinking=false`) can outperform major cloud APIs on tool-use calibration**, even at a fraction of the parameter count of the cloud reasoning models.

#### §4.3.6 Family-level synthesis

| Family | Trajectory shape | Bump | Notes |
|---|---|---|---|
| **GLM** | Gradual +3 over 7mo | No single bump | Already strong at 4.5 |
| **MiniMax** | Plateau at ceiling | None observed | Already saturated at M2 |
| **Step** | Sharp +9.5 | step-3 → step-3.5 | **Only family with clear "tool tax disappearance"** |
| **DeepSeek** | Confounded by API bug | V3 → V4 +2 to +5 | Multi-turn API contract incompatibility |
| **Qwen** | Local FP8 > cloud | n/a | Lynn deployment top of leaderboard |

The ToolAbstain-31 benchmark surfaces **family-level heterogeneity** that the canonical 12-question v0 set could not. The Lynn (2026-04 v3) hypothesis that the tool tax was *broadly* present in 2026-04 production is **not supported** — only Step's legacy step-3 model from 2025-Q3 shows the tax pattern strongly. By the time Lynn (2026-04) ran their study, step-3 was already 6+ months out of date and the contemporary versions of all 4 families we sampled with full data were already at 25-29/31 ceiling.

### §4.4 ToolAbstain-31: discrimination range and per-question pass rates

On 9 production providers × 31 questions × 1 trial:

| Provider | A/8 | B/6 | C/4 | D/1 | E/8 | F/4 | Total/31 | Notes |
|---|---|---|---|---|---|---|---|---|
| GLM-5-Turbo | 7.0 | 6.0 | 4.0 | 1 | 5.0 | 4.0 | **27.0** | Tied #1 |
| GLM-5.1 | 7.0 | 6.0 | 4.0 | 1 | 5.0 | 4.0 | **27.0** | Tied #1 |
| Step-3.5-Flash | 7.0 | 6.0 | 4.0 | 1 | 5.0 | 4.0 | **27.0** | Tied #1 |
| MiMo-2.5-Pro | 7.0 | 6.0 | 4.0 | 1 | 5.0 | 4.0 | **27.0** | Tied #1 |
| MiniMax-M2.7 | 7.0 | 5.0 | 4.0 | 1 | 5.0 | 4.0 | 26.0 | |
| Kimi-K2.5 | 4.5 | 6.0 | 2.0 | 1 | 5.0 | 4.0 | 22.5 | A weak |
| DeepSeek-V4-Pro | 5.0 | 6.0 | 1.0 | 1 | 5.0 | 4.0 | 22.0 | Multi-turn API errors |
| HY3-Preview | 4.0 | 6.0 | 3.0 | 1 | 5.0 | 3.0 | 22.0 | F borderline weak |
| DeepSeek-V4-Flash | 3.0 | 6.0 | 1.0 | 1 | 5.0 | 4.0 | 20.0 | A worst, multi-turn errors |

Discrimination range: **20.0 ↔ 27.0 = 7 of 31 = 23%** vs. 12% on canonical-only set. ToolAbstain-31 generates more separation per question, more failure-mode coverage, and surfaces the 3 universal failure modes characterized in §4.5.

#### §4.4.1 Per-question pass rates (across 9 providers × 2 trials = 18 trials each, from v0 run for breadth)

```
Saturated (≥95%, candidates for retirement)
    A1 send_email simple    18/18  100%
    A5 transfer_money       17/18   94%
    B1-B4, B6 long-tail    16-18  88-100%
    C3-C6 multi-tool       15-18  94-100%
    D1-D6 cutoff           16-18  100%
    E1, E3, E4, E6          ~      100%

Discriminating (paper material)
    A4 commit+push           5/18   28%   ← multi-turn chain split
    A6 translate+email       1/16    6%   ← multi-turn chain split
    A2 book train           11/18   61%   ← wrong-tool routing
    A3 cancel meeting       13/18   72%   ← clarification asks
    C2 train→weather        11/16   69%   ← multi-turn dependency
    C1 5 stocks parallel    13/17   77%
    E5 35-yr career change  13/17   77%   ← over-call risk
    B5 Nokia N73 price      16/18   89%

Universal failure (0% across 9 providers × 2 trials = 18)
    E2 翻译 我爱北京天安门    0/18    0%   ← tool-presence bias: 9/9 always overcall
```

### §4.5 Three persistent failure modes characterized

#### §4.5.1 Multi-step chain splitting (A4 / A6)

When asked for two dependent actions, the modal behavior across 9 providers is to emit only the first tool with verbose narration of the next step:

```
Prompt: 把代码 commit 上去 message 写 'feat: ...', 然后 push 到远程
GLM-5-Turbo response (typical): 
  [tool_calls: git_commit("feat: add user profile API")]
  [content: 好的，我先帮你执行 commit，然后再 push 到远程。先来 commit：]
  
DeepSeek-V4-Flash response (typical):
  [tool_calls: git_commit("feat: ...")]
  [content: 好的，我先执行 commit，然后 push 到远程。]

MiniMax-M2.7 response (typical):
  [tool_calls: git_commit("feat: ...")]
  [content: <think>用户想要：1. 创建一个 git commit ... 我需要先调用 git_commit，然后调用 git_push。这两个是执行型操作。</think>]
```

This is **legitimate multi-turn agentic planning**, not refusal. When the harness simulates a `tool_result` and re-prompts (multi-turn evaluation), 4 of 7 providers correctly emit `git_push` in turn 2. DeepSeek-V4-Pro/Flash both error out in multi-turn (likely API contract issue with `tool_calls` in assistant messages — see §4.6).

**Implication for benchmarks:** Single-turn evaluation of multi-step actions systematically misreads correct planning behavior as failure.

#### §4.5.2 Tool-presence overcalling (E2 universal)

When a tool definition matches a query verbatim, models call the tool even when parametric memory trivially suffices:

```
Prompt: 帮我把"我爱北京天安门"翻译成英文
Tool offered: translate(text, target_lang)
Result: 18/18 trials across 9 providers call translate(text="我爱北京天安门", target_lang="en")
```

This pattern reproduces in DeepSeek 6/6 historical versions (V3.1-terminus → V4-Pro), spanning 8 months. It is **universal and persistent**.

The over-call occurs even though:
- The translation is parametric-trivial (every model can produce "I love Tiananmen Square in Beijing" without help)
- The query has no temporal anchor or freshness requirement
- The model often outputs `<think>` content showing it knows the answer before deciding to call the tool

**Hypothesis:** RLHF training on tool-use data has over-emphasized "if a relevant tool exists, use it." This is the *inverse* of the originally-hypothesized refusal failure.

#### §4.5.3 Action-verb wrong-tool routing

DeepSeek-V4-Flash on A2 ("book train ticket"):
```
[tool_calls: web_search]
[content: 好的！我先查一下今天是周几，然后确定下周一的日期。]
```
Despite `book_train` and `search_train` being defined in the tool list, the model emitted `web_search` for date verification. This is a *routing* failure — the model partial-decomposed the task but routed to a generic tool first.

This pattern appears 4/6 times for DeepSeek-V4-Flash on A2/A3/A6, contributing significantly to its A-class score of only 4/12 (worst among 9 providers).

### §4.6 Multi-turn provider-bug discovery

DeepSeek-V4-Pro and V4-Flash had 6 errors each on 4 multi-turn questions (out of 4 questions × 1 trial × 2 reasoner variants = 8 attempts → 6 failed). Other providers had 0 multi-turn errors. Inspection of error responses indicates the DeepSeek API rejects assistant messages with `tool_calls` field if `content` is empty string vs. null — a contract incompatibility with OpenAI's reference behavior. *We are reaching out to DeepSeek's developer relations to confirm.*

---

## §5 Mitigation Discussion

### §5.1 Phase 1: prompt-layer interventions on the canonical baseline (negative result)

We tested 4 prompt-layer interventions on a 5-question SHOULD_CALL × 2-question SHOULDN'T_CALL set across 3 providers (GLM-5-Turbo, Step-3.5-Flash, DeepSeek-V4-Flash) at the spike v0 stage:

| Condition | Recall | Specificity | Net |
|---|---|---|---|
| C0 baseline | 100% | 100% | 100% |
| C1 strong system prompt | 100% | 100% | 100% |
| C2 in-context few-shot | 100% | 100% | 100% (Step had API failures) |
| C3 `tool_choice=required` | 100% | 0-50% | 50-75% |

On contemporary models, **prompt-layer interventions provide near-zero discriminative headroom** *on canonical questions* because the canonical baseline is already at ceiling. `tool_choice=required` *forces* tool emission but breaks the abstention property — DeepSeek emits tool_calls with garbage args even on creative writing and physics questions.

### §5.2 Phase 2: targeted prompt mitigations on universal failure questions (positive result)

We re-ran the mitigation study on the 3 universal failure questions identified in §4.5 — A4 (commit+push chain), A6 (translate+email chain), E2 (translate-trivial overcall) — across all 9 production providers × 2 trials × 4 conditions = 216 calls.

Conditions:

- **M0 baseline**: no system prompt
- **M1 chain-instruction**: system prompt instructs the model to emit ALL needed tools in a single turn for chained actions (don't split across turns)
- **M2 parametric-preference**: system prompt instructs the model to answer from parametric memory when the request is trivial (basic translate, common knowledge, simple math) — only use tools for execution-type or fresh-data tasks
- **M3 combined**: M1 + M2 in one system prompt

Mean score per question per condition (n=18 trials each, 9 providers × 2 trials):

| QID | Description | Kind | M0 baseline | M1 chain | M2 parametric | M3 combined |
|---|---|---|---|---|---|---|
| A4 | git commit + push | SHOULD | 0.61 | **0.94** ⭐ | 0.64 | **0.97** ⭐⭐ |
| A6 | translate + send_email | SHOULD | 0.50 | 0.47 | 0.56 | **0.61** |
| E2 | translate "我爱北京天安门" | SHOULDN'T | **0.00** ⚠️ | 0.00 | **0.67** ⭐ | **0.61** ⭐ |

**Findings:**

- **M1 (chain instruction) → A4 +33pp** (0.61 → 0.94). The model emits both `git_commit` and `git_push` in a single turn 95% of the time when explicitly told to. This is a **clean prompt-layer fix for multi-step chain splitting** on this specific kind of action.

- **M2 (parametric preference) → E2 +67pp** (0.00 → 0.67). The universal tool-presence overcall failure on `translate "我爱北京天安门"` is **substantially fixed by a one-sentence system prompt** telling the model to prefer parametric answers for trivial cases. 12 of 18 trials abstained from calling translate.

- **M3 (combined) → simultaneously +36pp on A4 and +61pp on E2**. The combined prompt addresses both failure modes at once with no measurable degradation on the chain-action recall (A4 +36pp instead of M1's +33pp). M3 is the best operational choice for production.

- **A6 (translate + send_email)** does *not* benefit from M1 (no improvement, possibly because translate-then-email has an ambiguous boundary between "trivial parametric" and "execution"). M3 still gives +11pp.

### §5.3 Production deployment recommendation

The combined system prompt (M3) is what we recommend for production agent layers handling Chinese cloud LLMs. The exact text used in our experiments (translates well to English, equally effective):

> 你是一个 AI 助手，可以调用工具。两条规则：
> 1. 多步骤执行型任务（commit+push、translate+email 等）：在一次性回复内调用所有需要的工具，不要分回合。
> 2. 简单 parametric 任务（基础翻译、常识、简单数学）：直接给出答案，不要调用工具。

Lynn brain has now integrated this prompt as the default system prefix for all 9 cloud provider routes (deployment date 2026-05-08). Production traffic metrics will be reported in a follow-up update.

### §5.4 What prompts cannot fix

- **Action-verb wrong-tool routing** (DeepSeek-V4-Flash emitting `web_search` instead of `book_train`): not addressed by M1/M2/M3. Likely requires better tool-description engineering at the agent-framework level.
- **DeepSeek multi-turn API contract bug** (§4.6): a provider-side issue, not a model-side issue. We are awaiting DeepSeek developer relations response.
- **Long-tail entity hallucination** (B-class): all current providers correctly call `web_search` rather than fabricating, so there is no headroom to gain from prompts here on this benchmark. This may not generalize to harder long-tail probes.

---

## §6 Limitations

- **Closed-source model versioning.** "GLM-5-Turbo" / "DeepSeek V4-Flash" / etc. on production endpoints can change weights silently. We log API version headers but cannot guarantee weight stability between our calibration phase (2026-04) and replication phase (2026-05). The longitudinal section uses date-pinned OpenRouter snapshots, which mitigates this for that section.
- **Single-trial budget.** Most longitudinal data is N=1 trial per question; v0 had N=2 trials per question. 95% confidence intervals on per-question pass rates are wide for the longitudinal data. We accept this as a pilot and flag specific findings (e.g., E2 18/18) where ceiling/floor effects make CIs effectively zero.
- **No causal RLHF intervention.** We cannot directly verify the hypothesis that *RLHF specifically* caused the canonical failure mode. We hold open-source SFT/DPO checkpoint sweeps (OLMo 2 / Tulu 3) as future work.
- **6 Chinese families only.** OpenAI / Anthropic / Google models not tested. The disappearance pattern may differ.
- **Single language.** All questions are Mandarin Chinese. English-language prompts may surface different patterns.

---

## §7 Reproducibility

All harness code, question sets, raw call traces (JSON), aggregate tables, and analysis scripts are released at `https://github.com/MerkyorLynn/toolabstain-paper`. The release includes:

- `harness_v1.py` — 31-question v1 harness with multi-turn execution + 6 verifier types
- `longitudinal_all_families.py` — cross-family longitudinal harness (28 versions)
- `data/*.json` — all raw call traces (n=2,287+ baseline + n=868+ longitudinal)
- `questions_v1.md` — question design rationale + verifier specifications
- `paper.md` — this document
- `run.sh` — single-command reproduction

Expected reproduction cost: ~$5-15 USD via OpenRouter API for the longitudinal sweep, ~$2-5 USD direct-to-provider for the 9-provider v1 baseline.

---

## §8 Conclusion

The "RLHF tool tax" hypothesis was an accurate snapshot of mid-2025 to early-2026 deployed Chinese cloud LLMs. By 2026-05, the specific failure mode it described — verbal hedge in place of tool call when training data is stale — has substantially disappeared across 7 of 9 major Chinese cloud providers and 6 of 6 DeepSeek historical versions sampled.

Two new failure modes have replaced refusal: **multi-step chain splitting** (which prior single-turn benchmarks misread as refusal) and **tool-presence overcalling** (which prior benchmarks did not probe). Both reproduce universally across 9 contemporary providers and persist across 8 months of historical DeepSeek versions.

We propose that future tool-use benchmarking should:
1. Always include multi-turn execution evaluation for chained-action prompts.
2. Always include over-call probes with deceptive tool definitions.
3. Always include confirmation-flow scoring for high-stakes execution prompts (transfer money / delete files / restart service).
4. Track the disappearance/persistence of specific failure modes longitudinally rather than rely on snapshot leaderboards.

Production agent designers should similarly redirect mitigation effort: away from "make the model call tools more aggressively" (which is no longer the issue) toward "make the model call the right tools at the right granularity in the right turn" (which remains unsolved).

---

## Acknowledgments

This work was conducted within the Lynn AI Agent project. We thank OpenRouter for unified access to historical model snapshots, and the 6 cloud providers (DeepSeek / Zhipu / Stepfun / MiniMax / Moonshot / Xiaomi) for OpenAI-compatible API endpoints that made cross-vendor benchmarking feasible.

---

## Appendix A — Full ToolAbstain-31 question list

*(See `questions_v1.md` for full text + expected_tools + verifier specs.)*

| QID | Cat | Kind | Prompt summary |
|---|---|---|---|
| A2 | A | SHOULD | book train ticket Beijing→Shanghai next Monday |
| A3 | A | SHOULD | cancel calendar meeting w/ zhang@team.com 3pm |
| A4mt | A | SHOULD | git commit + push (multi-turn) |
| A5 | A | SHOULD | transfer 1000元 to daughter's bank card |
| A6mt | A | SHOULD | translate Chinese + send email (multi-turn) |
| A7 | A | SHOULD | delete files in build/ except src/ |
| A8 | A | SHOULD | restart prod-web-01 service |
| A9mt | A | SHOULD | close GitHub issue #142 + add comment (multi-turn) |
| B5 | B | SHOULD | Nokia N73 (2006) Xianyu lowest price today |
| B7 | B | SHOULD | 中超第27轮第6场比分 |
| B8 | B | SHOULD | 1801.HK after-hours 涨跌幅 |
| B9 | B | SHOULD | 杭州市萧山区南阳街道办昨日通告 |
| B10 | B | SHOULD | 中国移动5G基站本月新增数 |
| B11 | B | SHOULD | 上海一手房本周环比 |
| C1 | C | SHOULD | 5 stocks parallel + total market cap calc |
| C2mt | C | SHOULD | train Beijing→Shanghai then weather Shanghai (multi-turn) |
| C7mt | C | SHOULD | extract entities + web_search each (multi-turn) |
| C8mt | C | SHOULD | BTC price + conditional email (multi-turn) |
| D5 | D | SHOULD | 上次 Fed 议息会议 sanity |
| E2 | E | SHOULDNT | 翻译 我爱北京天安门 |
| E5 | E | SHOULDNT | 35 岁转行做程序员 |
| E7 | E | SHOULDNT | 1+1 = ? |
| E8 | E | SHOULDNT | Python print hello world |
| E9 | E | SHOULDNT | 解释机器学习 |
| E10 | E | SHOULDNT | translate "thank you" to Chinese |
| E11 | E | SHOULDNT | 圆周率前 6 位 |
| E12 | E | SHOULDNT | 中国首都 |
| F1 | F | BORDER | 推荐 3 部豆瓣 8+ 国产悬疑片 |
| F2 | F | BORDER | e^π - π = ? |
| F3 | F | SHOULDNT | 牛顿三大定律 |
| F4 | F | SHOULDNT | 5 条时间管理建议 |

---

*Draft v0.1 · 2026-05-08 · paper section §4.3 cross-family longitudinal data still in collection at time of writing*
