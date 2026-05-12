# ToolAbstain: A Longitudinal Audit of Tool-Use Calibration in Chinese Cloud LLMs

> **The "RLHF tool tax" hypothesis was an accurate snapshot of mid-2025 production cloud LLMs. By Q2 2026 the canonical failure mode it described — verbal hedge in place of tool call when training data is stale — has largely disappeared. Two new failure modes have replaced it: multi-step chain splitting and tool-presence overcalling. We document the disappearance, characterize the residuals, and release a benchmark + mitigation prompt that fixes the residuals at the prompt layer.**

📄 **[Read the paper](paper.md)** · 🔢 **[Question set](questions/questions_v1.md)** · 💾 **[Raw data](data/)** · 🛠 **[Reproduction code](code/)**

---

## TL;DR

- **3,290+ benchmarked LLM calls** across 9 Chinese cloud production providers + 28 historical model versions across 6 families (DeepSeek / Qwen / GLM / MiniMax / Kimi / MiMo) + 1 Lynn-deployed local Qwen3.6-35B-A3B-FP8.
- **The "tool refusal" failure mode is largely dead in 2026-05.** 7 of 9 production providers hit 100% recall on the 2026-04 canonical baseline that originally showed 50% recall.
- **Cross-family longitudinal heterogeneity:** GLM = gradual +3 over 7 months. MiniMax = ceiling at 2025-10. Step = the only family with a sharp legacy → modern jump (step-3 13/31 → step-3.5 22.5/31). DeepSeek = confounded by a multi-turn API contract bug.
- **Lynn's local Qwen3.6-35B-A3B-FP8 (DGX Spark, FP8 + qwen3_coder parser) scored 29/31 — top of the entire 28-version leaderboard**, beating every contemporary cloud reasoner.
- **Two universal residuals:** (1) chain splitting: 95% of providers emit only `git_commit` when asked for `commit then push`. (2) tool-presence overcall: 18/18 trials × 9 providers call `translate` for "translate '我爱北京天安门'".
- **Targeted prompt mitigation works** — combined system prompt fixes A4 (commit+push) 0.61 → **0.97** and E2 (translate-trivial overcall) 0.00 → **0.61** simultaneously, no degradation.

## Repository layout

```
toolabstain-paper/
├── README.md                        ← you are here
├── paper.md                         ← full paper draft v0.1
├── code/
│   ├── harness_v1.py                ← 31-question benchmark harness (multi-turn enabled)
│   ├── harness_adversarial_v0.py    ← v0 30-question harness (single-turn)
│   ├── longitudinal_deepseek.py     ← DeepSeek 6-version OR longitudinal
│   ├── longitudinal_all_families.py ← 28-version OR longitudinal (free-tier hits credit)
│   ├── longitudinal_direct.py       ← Direct-API longitudinal (GLM/MiniMax/Step)
│   ├── mitigation_test.py           ← M0/M1/M2/M3 prompt mitigation study
│   ├── spike_v0.py                  ← 4-condition × 3-provider × 7Q sanity spike
│   ├── spike_v1_baseline.py         ← 9-provider × 15Q canonical replication
│   └── retry_suspects.py            ← provider-proxy disambiguation
├── data/
│   ├── longitudinal_all_*.json      ← 28 versions × 31 q via OpenRouter (partial — credit limit)
│   ├── longitudinal_direct_*.json   ← 13 versions × 31 q via direct APIs (clean)
│   └── mitigation_*.json            ← 9 providers × 3 q × 4 conditions × 2 trials
├── questions/
│   ├── questions_v1.md              ← 31-question ToolAbstain-31 spec
│   └── questions_adversarial_v0.md  ← 30-question v0 design
└── figures/                         ← (charts to be added)
```

## How to reproduce

### Prerequisites

```bash
pip install # (no third-party deps required — uses only stdlib)
```

API keys (export before running):

```bash
export DEEPSEEK_API_KEY="sk-..."
export ZHIPU_API_KEY="..."           # GLM via open.bigmodel.cn coding paas
export STEPFUN_API_KEY="..."
export MINIMAX_API_KEY="sk-cp-..."
export ALAYANEW_API_KEY="sk-..."     # Kimi alt endpoint
export MIMO_API_KEY="tp-..."
export OPENROUTER_API_KEY="sk-or-v1-..."
```

### Reproduce the canonical 9-provider baseline (~15 min, ~$1)

```bash
cd code
python3 spike_v1_baseline.py
```

Output: `spike_v1_baseline_<ts>.json` with per-provider per-question pass/fail.

### Reproduce the 31-question v1 benchmark (~30 min, ~$3)

```bash
N_TRIALS=2 python3 harness_v1.py
```

### Reproduce the cross-family longitudinal via direct APIs (~10 min, ~$1)

```bash
python3 longitudinal_direct.py
```

This covers GLM 6 versions / MiniMax 4 versions / Step 3 versions.

### Reproduce the mitigation study (~10 min, ~$0.50)

```bash
N_TRIALS=2 python3 mitigation_test.py
```

### Including the Spark Qwen 3.6-35B-A3B-FP8 reference

You'll need an OpenAI-compatible endpoint for Qwen 3.6-35B-A3B-FP8 with `qwen3_coder` tool parser and `qwen3` reasoning parser. Our deployment uses NVIDIA vLLM 0.17.1 in Docker on DGX Spark unified memory; full setup notes in `code/longitudinal_all_families.py` comments.

## Headline numbers

### Production leaderboard (ToolAbstain-31, 2026-05-08)

| Rank | Provider | Score | Notes |
|---|---|---|---|
| 1 | **Qwen3.6-35B-A3B-FP8 (Lynn Spark)** | **29/31** | Local FP8 deployment, qwen3_coder parser |
| 2 | GLM-5.1 | 28/31 | Zhipu coding paas |
| 2 | MiniMax-M2.1 | 28/31 | highspeed variant |
| 4 | GLM-5 | 27/31 | |
| 4 | GLM-5-Turbo | 27/31 | |
| 4 | MiniMax-M2.7 | 27/31 | |
| 4 | MiMo-2.5-Pro | 27/31 | |
| 8 | MiniMax-M2 | 27/31 | early ceiling |
| 9 | GLM-4.6 | 26/31 | |
| 9 | GLM-4.7 | 26/31 | |
| 9 | Qwen3-Max | 26/31 | 2025-09 |
| 12 | GLM-4.5 | 25/31 | |
| 13 | step-3.5-flash-2603 | 22.5/31 | |
| 14 | DeepSeek-V4-Pro | 22.0/31 | multi-turn API bug confound |
| 15 | DeepSeek-V4-Flash | 20.0/31 | multi-turn API bug confound |
| 16 | step-3.5-flash | 20.0/31 | |
| 17 | DS-V3.1-terminus | 18.0/31 | 2025-09 |
| 18 | DS-V3.2 | 16.0/31 | 2025-12 (10 errors) |
| 19 | DS-V3.2-exp | 16.0/31 | 2025-10 (11 errors) |
| 20 | **step-3** | **13/31** | **2025-Q3 — only legacy with strong tool tax** |

### Mitigation prompt (M3 combined, deploy in production)

```
你是一个 AI 助手，可以调用工具。两条规则：
1. 多步骤执行型任务（commit+push、translate+email 等）：
   在一次性回复内调用所有需要的工具，不要分回合。
2. 简单 parametric 任务（基础翻译、常识、简单数学）：
   直接给出答案，不要调用工具。
```

Effect on the 3 universal failure questions (n=18 trials each):

| QID | Description | M0 baseline | M3 combined | Δ |
|---|---|---|---|---|
| A4 | git commit + push | 0.61 | **0.97** | +0.36 ⭐ |
| A6 | translate + email | 0.50 | 0.61 | +0.11 |
| E2 | translate "我爱北京天安门" | 0.00 | **0.61** | +0.61 ⭐⭐ |

## Citation

```bibtex
@misc{lynn2026toolabstain,
  author       = {Lynn},
  title        = {ToolAbstain: A Longitudinal Audit of Tool-Use Calibration in Chinese Cloud LLMs Reveals Disappeared RLHF Tool-Refusal and Two New Failure Modes},
  year         = {2026},
  month        = {may},
  howpublished = {Preprint},
  url          = {https://github.com/MerkyorLynn/toolabstain-paper}
}
```

## License

MIT — see [LICENSE](LICENSE)

## Acknowledgments

This work was conducted within the [Lynn AI Agent](https://github.com/MerkyorLynn/Lynn) project. We thank OpenRouter for unified historical model snapshot access (within free-tier credit limits) and the 6 cloud providers for OpenAI-compatible API endpoints that made cross-vendor benchmarking feasible.
