# Codex review notes — qwen3_next_mtp staging

Date: 2026-05-16

## Verdict

Keep this staging path. It is the right architectural direction for Lynn MTP:
Qwen3.6-style `qwen3_next_mtp`, not the older single-Linear/Medusa-style head.

Do not promote to production yet. It is a scaffold for the future A100-trained
MTP head, not an end-to-end serving path.

## Review fixes applied

1. T7 real-weight probe now downloads both Qwen3.6 shards that contain `mtp.*`
   tensors:
   - `model-00025-of-00026.safetensors`
   - `model-00026-of-00026.safetensors`

2. Synthetic SP-16 tests now use `MOCK_VOCAB_SIZE = 4096` for fake
   embeddings/lm_head. The real vocab is still documented as 248320, but the
   synthetic controller tests do not need to allocate multi-GiB mock tables.

3. `MTPController._mtp_predict()` now treats the MTP input token as the next
   absolute position (`position_id + 1`). This matches the vLLM
   `qwen3_next_mtp` forward semantics where `input_ids` and `positions` refer
   to the MTP input token.

4. `next_ids` creation was made batch-shape aware (`[B, 1]`) instead of
   hard-coded `[1, 1]`.

## Validation run

Ran SP-16 T1-T6 on A100 GPU1, no Qwen3.6 download:

```text
=== SP-16 qwen3_next_mtp gate: PASS (6/6) ===
```

Report:

```text
/root/lynn-a100-outputs/mtp_staging_codex_review/sp16_no_download.json
```

## Still blocked before production

- `engine/generate_mtp.py` still needs a v2 integration that exposes the
  pre-final-norm hidden state from the main decode loop.
- MTP self-attention needs its own KV cache in `LynnInferenceState`; current
  module forward is a correctness scaffold, not the optimized serving path.
- MTP MoE is still naive BF16 reference code. That is acceptable before the A100
  MTP head exists, but it is not the final fast runtime.
- T7 real Qwen3.6 strict-load should run after the current A100 -> R6000 NVFP4
  transfer finishes, to avoid stealing transfer bandwidth.

## Recommended next steps

1. Finish NVFP4 v0 R6000 checksum + packed runtime probe.
2. Finish A100 W4A8 structured-v4 Recovery and decide whether it becomes NVFP4
   v1 source.
3. Run SP-16 T7 real Qwen3.6 MTP strict-load.
4. Only after W4A8/NVFP4 stabilizes, wire `generate_mtp.py` v2 and train/adapt
   the MTP head on A100.
