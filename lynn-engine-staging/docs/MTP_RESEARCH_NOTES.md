# MTP Research Notes — pre-deployment intel

**Date**: 2026-05-16
**Author**: Claude session, post-staging-commit (4fe7502)
**Purpose**: deep-dive intel for whoever picks up MTP integration after W4A8 stabilizes. Saves rediscovery time when the trained NEXTN head arrives.
**Status**: research only. NOT a deployment doc. CODEX_REVIEW_NOTES.md is the authoritative review state (user-owned).

---

## TL;DR (read first)

1. **A100 NEXTN training recipe target**: λ_mtp = 0.1, joint-with-body if feasible OR frozen-body-from-Qwen3.6-warm-start if A100 cycles are tight. ~500-2000 steps for frozen-body warm-start, ~10-50K steps for joint.
2. **num_speculative_tokens = 2** for production default. n=3 has peak ROI but adds complexity; revisit after n=2 ships and stabilizes.
3. **W4A8 is MTP-safer than W4A4**. W4A4 body has 15pp accuracy degradation on Llama2-70B class models (precedent), and the small per-16 scale group amplifies the issue. The user's "W4A8 first" strategy is correctly aligned with MTP quality preservation.
4. **Frozen-body has a quality ceiling** (verl docs explicit). Joint training is strictly better quality, but ~10x training cost. For Lynn 27B Qwen3.5 derivative, frozen-body warm-start from Qwen3.6 MTP head should be enough to ship; joint training is a v2 optimization.
5. **Spark single-stream uplift is +8.7% empirical** (GB10 Qwen3.6-35B benchmark). Real value at 16+ concurrent (+24.2%). Lynn-engine is single-stream → primary value comes from compounding W4A8 quality + MTP path correctness, not raw TPS.

---

## 1. Training recipe (DeepSeek-V3 official + community deltas)

### Loss scaling (canonical schedule)
```
DeepSeek-V3 pretraining (14.8T tokens total):
  Tokens 0     → 10T:     λ_mtp = 0.3  (boost MTP signal during early adaptation)
  Tokens 10T   → 14.8T:   λ_mtp = 0.1  (taper as base model converges)

NVIDIA Megatron Bridge example config (smaller scale):
  mtp_loss_scaling_factor = 0.1  (constant, single-stage)
```

Implications for Lynn 27B NEXTN training:
- If A100 does **joint training** (Lynn body + MTP together): start λ_mtp = 0.3 for first half of steps, taper to 0.1
- If **frozen-body fine-tune**: λ_mtp = 1.0 (MTP is the only loss target, no body loss to balance against)
- If **joint with body W4A8 simulation**: keep λ_mtp = 0.1 throughout (body is already trained, just adapter alignment)

### Batch + sequence length (Qwen3 main body recipe)
```
sequence_length = 32768
global_batch_size_tokens = 4M  → 122 sequences/batch at 32k seq
optimizer = AdamW (typical, not confirmed from docs)
learning_rate = 3.2e-4 peak, cosine decay over total training
warmup = 1000 steps linear
```

For MTP-only fine-tune (frozen body), much smaller batch is fine (the head is tiny vs body):
- Suggested: global batch 1M tokens / 32 seq × 32k
- LR: 1e-4 (lower than main pretraining; MTP head doesn't need to learn world knowledge, just alignment)
- Warmup: 100 steps
- Total steps: 500-2000 for frozen warm-start, 10-50K for joint

### Training data composition
Public DeepSeek-V3 + Eagle-3 suggest:
- 50-70% high-quality web (the same data as main body pretraining)
- 20-30% conversation data (ShareGPT, UltraChat-style, ~530K examples — see Eagle-3)
- 10-20% domain-specific (code, math, etc.) if downstream emphasizes those

For Lynn 27B (already distilled and Recovery-LoRA'd toward Lynn's persona):
- **CRITICAL**: include Lynn's self-distillation generations in MTP training data, otherwise MTP head learns generic Qwen distribution which doesn't match Lynn's actual production behavior
- Suggested mix: 50% Lynn self-distill + 30% ShareGPT + 20% Lynn-domain (assistant tasks, agent flows)

---

## 2. Known training pitfalls (community-reported)

### Pitfall A: Frozen-body quality ceiling
- verl docs (RL training): "When integrating MTP heads into frozen LLMs, hidden layers are strongly specialized for NTP (next-token prediction), making adaptation non-trivial. Joint training improves but cannot fully overcome this barrier."
- Manifests as: accept rate plateaus at 55-65% with frozen body, vs 72-80% achievable with joint training
- Mitigation: ship frozen-body MTP first, plan v2 joint training after data confirms uplift is worth A100 cycles

### Pitfall B: Vocab mismatch
- If A100 changes vocabulary during training (e.g., new domain tokens), MTP head trained on old vocab will produce garbage for new tokens
- Lynn 27B tokenizer = Qwen 248320 vocab. Frozen during A100 NEXTN training.
- Validation: T7 in SP-16 probe verifies shape `[248320, 2048]` matches exactly. Mismatch → fail strict load.

### Pitfall C: Accept rate evaluation bias
- Greedy decoding accept rate ≠ sampled decoding accept rate
- DeepSeek reports 85% greedy accept; sampling drops to 60-65% in practice
- Lynn 27B production default is greedy (verified server cmdline); MTP training should optimize for greedy alignment specifically

### Pitfall D: Dead experts in MTP MoE
- MTP MoE has its own 256-expert pool. If training data has narrow distribution, some experts never activate → "dead experts" reduce MTP capacity
- Symptom: accept rate stagnates around 50% even after 5K steps; routing histogram shows < 100 experts with > 0.1% activation
- Mitigation: include router auxiliary loss `router_aux_loss_coef = 0.001` (Qwen3.5 config default) to spread routing

### Pitfall E: MTP overshooting → distribution drift
- Joint training with high λ_mtp can cause main body's representations to drift toward "easy MTP predictions" (high-frequency tokens) at the cost of NTP quality
- Mitigation: tapered λ schedule (0.3 → 0.1), monitor main body PPL on held-out

### Pitfall F: Test-time / train-time mismatch (Eagle-3 motivation)
- During training, MTP sees gold previous token; at inference, MTP sees its own draft as input
- Causes accept rate to drop with each speculation position (pos1 96% → pos3 67%)
- Eagle-3 solves this via "training-time test" technique; DeepSeek-V3 NEXTN does not, accepts the drop
- For Lynn 27B at n=2, this is the bigger contributor to pos2 accept rate (63% vs pos1 81%)

---

## 3. num_speculative_tokens tuning (empirical from public benches)

| n_spec | Qwen3.6-27B TPS | mean_accept_len | per-pos accept | Verdict |
|---|---|---|---|---|
| 1 | 54.6/59.0 | 1.9 | 96% | Safe minimum |
| **2** | **61.0/69.7** | 2.4 | 82% / 56% | **Production default** |
| 3 | 63.8/79.7 | 3.4 | 92% / 81% / 67% | Peak ROI consumer hw |
| 4 | 65 (code only) | 3.5 | 92 / 81 / 67 / **21%** | Pos-4 wasted compute |
| 5+ | minimal gain | < 3.6 | < 60% on later pos | Not recommended |

For Lynn 27B on Spark GB10 (sm_121), start `num_speculative_tokens=2` matching:
- Qwen3.6 GB10 same-hw benchmark used n=2 → +24.2% at 16 concurrent
- n=3 not yet validated on GB10; defer to v2

---

## 4. W4A8 × MTP interaction (the user's main strategic question)

### Why W4A8 is the right body precision for MTP
- W4A4 introduces up to **15pp accuracy degradation** on Llama2-70B class models (per 2026 quantization survey)
- NVFP4's per-16 microscaling provably neutralizes traditional outlier mitigation (recent ICLR paper) — quality recovery is hard
- MTP head's accept rate is **sensitive to body hidden distribution drift**: if W4A4 shifts h enough, MTP's calibration breaks (predicting wrong probability ordering)
- W4A8 keeps activations in FP8 E4M3 (±448 range, 75× wider than E2M1 ±6) → preserves the variance signature that MTP head trained to read

### MTP head training relative to body precision
- **Option 1 (recommended)**: Train MTP head with **W4A8-simulated body activations** during A100 training. This makes MTP head robust to W4A8 inference quirks from day 1.
- **Option 2**: Train MTP head with **BF16 body**, deploy with W4A8 body. Risk: accept rate drops 5-10pp due to distribution shift. Acceptable if A100 doesn't have time for QAT-MTP joint.
- **Option 3 (worst)**: Train MTP head with **W4A4 body**. Hidden distribution is most distorted; MTP accept rate likely plateaus at 50-60%.

Lynn user's stated plan: **W4A8 first as production**, W4A4 long-term. Strongly supports Option 1 with W4A8 body during MTP training.

### MTP head precision itself
- Spark GB10 benchmark shipped MTP head in BF16, not quantized. Memory cost +0.79 GB → acceptable on 119 GB unified
- Don't quantize MTP head until/unless inference memory becomes the bottleneck (which it isn't on Spark)
- If memory pressure later: FP8 W4A4 MTP head adds 4× compression but is highest-risk quantize because head's argmax decision is sensitive to small logit perturbations

---

## 5. Frozen-body warm-start procedure (if A100 skips full joint training)

When A100 ships Lynn-27B-W4A8 without bundled MTP training:

```
Step 1: Extract Qwen3.6-35B-A3B MTP weights
  download model-{00025,00026}-of-00026.safetensors
  extract 19 mtp.* tensors (SP-16 T7 validates this)

Step 2: Init Lynn MTP module from Qwen3.6 weights
  module = Qwen3NextMTPModule(Qwen3NextMTPConfig.from_dict(lynn_27b_config))
  state_dict = remap_qwen36_to_lynn_mtp(qwen36_state_dict)
  module.load_state_dict(state_dict, strict=True)

Step 3: Frozen-body fine-tune on Lynn data (A100, ~2-4 hours)
  freeze: all Lynn 27B body params (40 layer + embed + lm_head + main norm)
  train: MTP module only (~0.79 GB parameters)
  data: 50% Lynn self-distill + 50% ShareGPT/UltraChat
  hyperparams:
    lr = 1e-4
    batch = 1M tokens (32 seq × 32k)
    warmup = 100 steps
    total = 1000-2000 steps
    optimizer = AdamW (β₁=0.9, β₂=0.95)
    weight_decay = 0.01

Step 4: Save Lynn-trained MTP head as `mtp.*` tensors
  same naming as Qwen3.6 (so Lynn engine loader picks it up via existing remap)
  merge into model.safetensors.index.json under new shard

Step 5: SP-16 T7 + 6-prompt greedy parity gate
  T7 strict load passes ✓ (shape match)
  greedy parity test: with MTP disabled vs enabled, same first N tokens
  16k smoke: long-context coherence preserved
```

Estimated ROI: accept rate 60-70% achievable in 2-4 hours A100 work. Adequate to ship +8% single-stream / +20% concurrent uplift.

---

## 6. Continuous batching interaction (the bigger picture)

MTP's TPS uplift is **concurrency-dependent** per Spark GB10 benchmark:
- 1-stream: +8.7% (baseline 50 → 55 TPS)
- 4-stream prefill-bound: **−7.2%** (MTP HURTS)
- 16-stream stress: **+24.2%** (baseline 214 → 266 TPS)

Lynn-engine is **single-stream only**. Implications:
- Without continuous batching, MTP gives only the +8.7% single-stream uplift
- Lynn's "single user assistant" use case → +8.7% is small absolute improvement (49 → 53 TPS)
- For brain-side multi-user serving, would need either (a) Lynn-engine continuous batching refactor, or (b) Switch to vLLM/SGLang backend for multi-user paths

This is a strategic separator: MTP ships value mainly when continuous batching is also added. Until then, MTP is "correct path proven, modest uplift" not "game changer".

---

## 7. Code paths to wire when artifact arrives (gap list from this staging commit)

When A100 ships `Lynn-V4-Distill-Qwen-27B-A3B-W4A8-MTP/`:

1. **SP-16 T7** strict load against real artifact — first verification
2. **`engine/generate_mtp.py` v2** — refactor to match `MTPController.step(h_prefinal, position_ids)` signature
   - Touch: `engine/full_forward.py` to expose `h_prefinal` (current `_decode_layer` chain returns post-norm `h_final`)
3. **`LynnInferenceState` extension** — add MTP self-attn KV cache slot (currently MTP self-attn re-attends to full sequence each step)
4. **Triton SP-08 MoE replacement in MTP MoE forward** — `engine/mtp_qwen3_next.py:Qwen3NextMTPMoE.forward` currently uses naive einsum, replace with `triton_kernels/nvfp4_moe.py` autotuned path once Lynn-MTP weights NVFP4-packed
5. **6-prompt greedy parity gate** — disabled vs enabled MTP path, same prompt, same first N tokens (deterministic greedy)
6. **16k long-ctx smoke** — verify MTP doesn't degrade long-context coherence
7. **`server/openai_http.py` opt-in flag** — `LYNN_MTP_ENABLED=1` env var routes to `generate_incremental_mtp` instead of `generate_incremental`. Default off until validated.

Estimated effort (assuming clean artifact + no surprises): **1-2 days** Lynn-engine work, after artifact arrives.

---

## 8. Open questions for A100 team (decide BEFORE training, not after)

1. **Joint training vs frozen warm-start?** Joint = better quality, ~5-10× cost. Frozen = faster ship, quality ceiling. **Recommendation**: frozen warm-start first (ship value fast), joint as v2.
2. **MTP loss scale schedule?** Constant λ=0.1 vs DeepSeek's 0.3→0.1 taper. **Recommendation**: constant 0.1 for frozen warm-start (only target is MTP loss); taper for joint.
3. **MTP head dtype?** BF16 always, FP8 quantized never (per Spark GB10 reference). **Recommendation**: bf16.
4. **Vocab freeze?** YES, do not change tokenizer during MTP training. Confirmed Lynn 248320 == Qwen3.6 248320.
5. **`num_speculative_tokens` at serving?** **Recommendation**: 2 default, expose env var for experimentation.
6. **Self-distill data inclusion?** **Recommendation**: YES, include Lynn's own generation in training data (distribution alignment).

---

## 9. Sources

- DeepSeek-V3 Tech Report: https://arxiv.org/html/2412.19437v1 (MTP loss schedule 0.3/0.1)
- NVIDIA Megatron Bridge DeepSeek-V3: https://docs.nvidia.com/nemo/megatron-bridge/0.2.0/models/llm/deepseek-v3.html (mtp_loss_scaling_factor reference)
- Multi-Token Prediction Megatron Bridge: https://docs.nvidia.com/nemo/megatron-bridge/latest/training/multi-token-prediction.html
- Qwen3 Tech Report: https://arxiv.org/pdf/2505.09388 (Qwen3 training hyperparameters)
- verl MTP guide: https://verl.readthedocs.io/en/latest/advance/mtp.html (frozen-body ceiling)
- Spec decoding MTP benchmarks Qwen3.6: https://dasroot.net/posts/2026/05/speculative-decoding-mtp-standard-qwen3-6-35b-a3b/ (num_speculative_tokens tuning)
- Qwen3.6 MTP on GB10 Spark: https://docai.hu/en/blog/qwen36-mtp-gb10 (same-hardware reference numbers)
- ICLR 2026 NVFP4 microscaling: https://arxiv.org/html/2509.23202v2 (W4A4 quantization quality issue)
- NVIDIA NVFP4 QAD: https://research.nvidia.com/labs/nemotron/files/NVFP4-QAD-Report.pdf (recovery techniques)
- EAGLE-3 paper: https://arxiv.org/html/2503.01840v1 (training-time test, accept rate position drop)
- Qwen3.6-35B-A3B safetensors index: https://huggingface.co/Qwen/Qwen3.6-35B-A3B/raw/main/model.safetensors.index.json (19 mtp.* tensors verified 2026-05-16)
