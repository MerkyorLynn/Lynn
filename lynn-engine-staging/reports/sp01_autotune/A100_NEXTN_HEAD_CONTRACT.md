# A100 NEXTN Head Training Contract — Lynn 27B MTP

**Purpose**: Specify the output artifact format A100 must produce so that
Spark Lynn-engine can consume the trained NEXTN head with zero adaptation.
Locks the contract NOW so training run does not need re-do later.

**Recipient**: A100 W4A8+MTP training pipeline (Codex side)
**Originator**: Spark Lynn-engine runtime (this side; SP-15 scaffolding 2026-05-16)
**Status**: contract draft v1, locked subject to feedback

---

## 1. What is the NEXTN head?

A single Linear layer that maps Lynn 27B's final-layer hidden state to
vocabulary logits, predicting the token at offset +2 from the input token.

```
forward pass at input token t_k -> final hidden h_k -> 
  main lm_head(h_k) -> t_{k+1}    (standard)
  NEXTN head(h_k)   -> t_{k+2}    (new, 1-step lookahead)
```

The pair of predictions enables speculative decoding: feed [t_{k+1},
t'_{k+2}] in next forward, position 0 verifies the draft, position 1
continues if accepted.

## 2. Tensor specification

```
Name (REQUIRED, in canonical order of preference):
  Primary:        mtp.head.weight
  Alternate 1:    model.mtp.head.weight
  Alternate 2:    mtp_predict_layers.0.weight       (Deepseek-V3 style)
  Alternate 3:    model.mtp_predict_layers.0.weight
  Alternate 4:    lm_head.mtp.weight

Shape:           [VOCAB_SIZE, HIDDEN_SIZE]
                 = [248064, 2048] for Lynn 27B 
                 (must match lm_head.weight shape exactly)

dtype:           bfloat16 (matches lm_head)
                 If quantized to FP8/INT8 on A100 side, ship as bfloat16 with
                 scales merged. Lynn-engine current runtime expects raw bf16.

Sparsity:        none expected
No bias term     (NEXTN heads conventionally have no bias)
```

## 3. config.json metadata (REQUIRED if NEXTN head present)

Add the following fields to `text_config` block:

```json
{
  "text_config": {
    ...existing...
    "mtp_head_present": true,
    "mtp_predict_offset": 2,
    "mtp_head_dtype": "bfloat16",
    "mtp_training_acceptance_rate_estimate": 0.65
  }
}
```

These fields let Spark loader skip the safetensors scan and validate the
head is present.

## 4. Vocabulary alignment

`mtp.head.weight` MUST share the SAME tokenizer vocabulary as `lm_head.weight`.
Re-encoding tokens during NEXTN training is NOT permitted; if A100 finds
the head benefits from a smaller / specialized vocab, that requires a
separate runtime path (this contract does not cover that).

If tied with lm_head (parameter sharing): set `mtp.head.weight` to point
to the same tensor — Spark loader handles both tied and untied cases.

## 5. Training recipe constraints (recommended, not contract)

These don't affect the loader but affect runtime acceptance rate which
determines the speedup:

- Train NEXTN head on top of frozen Lynn 27B body (small head, ~1 small
  matmul, ~500-1000 step fine-tune typically sufficient).
- Loss: cross-entropy of NEXTN(h_k) vs t_{k+2}.
- Expected accept rate after training: 60-70% with this recipe.
- Validation: check NEXTN(h_k).argmax() top-1 matches t_{k+2} on a held-out
  set. Should reach ≥60% on natural text.

## 6. Combination with W4A8 weights (Phase 1 strategy)

If A100 is producing W4A8 27B + MTP combined artifact:

- Save the full bundle as a single directory containing:
  - `model.safetensors` (or sharded `model-NNNN-of-MMMM.safetensors`) with
    NVFP4-packed E2M1 weights for all 40 layers, lm_head, AND mtp.head
  - `model.safetensors.index.json` updated with mtp.head entry
  - `config.json` with `mtp_head_present: true` and other MTP metadata
  - `tokenizer*.json`, `chat_template.jinja` — unchanged from base
  - `lynn_quant_manifest.json` updated to include mtp.head quant metadata

- Naming convention: `Lynn-V4-Distill-Qwen-27B-A3B-W4A8-MTP` (proposed)

- Spark side will keep MTP head in bfloat16 even if other weights are NVFP4 —
  the head is small (~1 GB) so no compression value, and bf16 keeps the
  loader simple.

## 7. Loading verification (Spark side will run)

When the artifact lands, Spark will run:

```python
from engine.mtp import load_nextn_head_weight

# Test 1: head loads from outside dict
outside = load_outside_weights(model_dir, device, dtype=torch.bfloat16)
nextn = load_nextn_head_weight(outside, model_dir)
assert nextn is not None, "NEXTN head not found"
assert nextn.shape == (VOCAB, HIDDEN), f"shape mismatch: {nextn.shape}"
assert nextn.dtype == torch.bfloat16, f"dtype: {nextn.dtype}"

# Test 2: dual-head produces sane tokens
h = prefill(some_prompt)
main_t, draft_t = mtp.MTPController(lm_head, nextn)._dual_head(h_final)
assert main_t != draft_t or some_accept_test_passes  # not strict, just sanity
```

If any test fails, contact A100 team with the specific failure.

## 8. Expected throughput math (independent of W4A8)

```
Single-token baseline (current Spark Triton SP-08):  49.37 TPS
With MTP (no W4A8):
  accept rate     | tokens/step | TPS uplift
  -----------------------------------------------------------------
  50%             | 1.50        | 49.37 * 1.50 = 74.0 TPS
  65% (typical)   | 1.65        | 49.37 * 1.65 = 81.5 TPS  <-- expected
  75% (optimistic)| 1.75        | 49.37 * 1.75 = 86.4 TPS
```

Note: actual single-forward latency may increase slightly due to extra
NEXTN head matmul (~0.1 ms added per step). Effect on net TPS is < 1%
within rounding.

If W4A8 path becomes viable (α revisit on Spark, or W4A8 artifact arrives
and is used via Triton path on Spark), MTP speedup compounds:
```
W4A8 (γ Triton baseline) ≈ 49 TPS (same as today, since W4A8 doesn't speed
                                    up Triton path on Spark — confirmed SP-14)
MTP + W4A8 = 49 * 1.65 = 81 TPS (same as MTP alone, no compound win on Spark)
```

The compound win is on R6000 where W4A8 native kernel is faster:
R6000 (W4A8 native ~150 TPS) × MTP 1.65 = 247 TPS class.

## 9. Acceptance criteria for Spark integration (after artifact landed)

Same 3-gate framework as the prior W4A8 work:

- **Gate 1: math + load** — head loads, shape OK, single-step parity vs no-MTP
- **Gate 2: 6-prompt greedy parity** — for short greedy outputs, MTP path
  produces same tokens as no-MTP path (correctness, not speed)
- **Gate 3: 16k long-ctx smoke** — long-context inference still coherent
  with MTP enabled

If Gate 1-3 pass: opt-in via `LYNN_MTP_ENABLED=1` env var. Production
default stays off until further verification (multi-stream, multi-batch
stability, etc.).

## 10. Open questions for A100 team

1. **Multi-step NEXTN?** Should we plan for 2-token NEXTN (predict t_{k+2}
   AND t_{k+3} in single head)? Higher speedup ceiling (~2× vs 1.65×) but
   complex pipeline. Current contract is 1-token NEXTN. Confirm 1-token is
   the choice.

2. **Training data overlap?** Should NEXTN training use same SFT/distill
   data as Lynn 27B body training, or fresh held-out? Implementation
   detail but affects accept rate.

3. **Tie or untie with lm_head?** If tied (NEXTN.weight = lm_head.weight),
   no extra storage but training procedure differs. Confirm.

4. **Artifact naming + delivery channel?** HF private repo? Direct scp to
   Spark? Where does the Spark side wait for it?

---

**Lock date**: 2026-05-16 by Spark side. A100 team should ack within their
training planning loop. Any contract change after lock → re-coordination
required to avoid runtime/training mismatch.
