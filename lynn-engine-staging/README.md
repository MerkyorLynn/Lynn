# lynn-engine-staging — qwen3_next_mtp v2 implementation

**Status**: code complete, syntax-clean locally, **untested with real model** (needs Spark + Qwen3.6-35B-A3B safetensors download for full validation).
**Date**: 2026-05-16
**Reason for new directory**: lynn-engine on Spark is not a git repo. Worktree branch holds reviewable copy; user scp to Spark when approved.

---

## What changed vs the SP-15 v1 in `/home/merkyor/lynn-engine/engine/mtp.py`

| File | v1 (SP-15, Spark current) | v2 (this staging dir) |
|---|---|---|
| `engine/mtp.py` | Single-Linear NEXTN head, ~313 LOC | qwen3_next_mtp module-driven controller, 346 LOC. Same state machine, different `_predict_next_pair`. |
| `engine/mtp_qwen3_next.py` | (does not exist) | **NEW** 464 LOC — full module: RMSNorm, partial-RoPE attention with q/k norm, MoE (256 experts + shared + gate), FC combiner, loader for Qwen3.6 warm-start. |
| `benchmarks/sp15_mtp_pipeline_probe.py` | Tests with Linear mock NEXTN | (kept on Spark as historical; superseded) |
| `benchmarks/sp16_qwen3_next_mtp_probe.py` | (does not exist) | **NEW** 410 LOC — 7 tests covering shape, forward, state_dict load, controller integration, optional real-Qwen3.6 download. |

**Architectural correction**: v1 was Medusa-style (1 Linear head). v2 matches the actual Qwen3.6-35B-A3B `mtp.*` tensor list extracted from `model.safetensors.index.json` (2026-05-16). Two paths produce DIFFERENT logits — v1 is a no-op approximation, v2 is the real thing.

## What is NOT in this staging dir (gap to ship)

| Gap | Where | Effort |
|---|---|---|
| `engine/generate_mtp.py` v2 to match new `MTPController` signature | needs `prev_hidden` (pre-main-final-norm) exposed from `full_forward._decode_layer` chain | half day, touches `engine/full_forward.py` — non-trivial since production module |
| Lynn-engine optimization (Triton SP-08 MoE replaces naive einsum in MTP MoE) | `engine/mtp_qwen3_next.py:Qwen3NextMTPMoE.forward` — currently BF16 reference impl, 256-expert loop is slow | medium; A100 hasn't trained head yet so not urgent |
| Per-MTP-layer KV cache | MTP layer 0 has its own self-attention with its own KV cache slots (separate from main body 40 layers) | half day, add new state slots in `LynnInferenceState` |
| Real-model integration test on Spark (Gates 2 + 3: 6-prompt greedy + 16k smoke) | requires A100 NEXTN head OR Qwen3.6 warm-start weights | blocked on A100 OR on T7 download |

These are documented for the next session, not done here.

## File tree

```
lynn-engine-staging/
├── README.md                                  ← this file
├── REVIEW_CHECKLIST.md                        ← what to check before approving deploy
├── docs/
│   └── A100_NEXTN_CONTRACT_V2.md              ← (TODO) amended contract spec
├── engine/
│   ├── mtp.py                                 ← MTPController v2 (refactored)
│   └── mtp_qwen3_next.py                      ← NEW module + loader
└── benchmarks/
    └── sp16_qwen3_next_mtp_probe.py           ← 7-test validation gate
```

## Deployment plan (when approved)

```bash
# from worktree
WORKTREE=$(pwd)/lynn-engine-staging

# 1. Backup current Spark MTP files (just in case)
ssh dgx-via-n5 'cp -r /home/merkyor/lynn-engine/engine/mtp.py \
                      /home/merkyor/lynn-engine/engine/mtp.py.v1-backup-$(date +%Y%m%d-%H%M%S)'

# 2. Upload new files
scp $WORKTREE/engine/mtp.py             dgx-via-n5:/home/merkyor/lynn-engine/engine/mtp.py
scp $WORKTREE/engine/mtp_qwen3_next.py  dgx-via-n5:/home/merkyor/lynn-engine/engine/mtp_qwen3_next.py
scp $WORKTREE/benchmarks/sp16_qwen3_next_mtp_probe.py \
                                         dgx-via-n5:/home/merkyor/lynn-engine/benchmarks/sp16_qwen3_next_mtp_probe.py

# 3. Run SP-16 inside production container (no production impact — separate path)
ssh dgx-via-n5 'docker exec lynn-27b-nvfp4-server python3 /lynn-engine/benchmarks/sp16_qwen3_next_mtp_probe.py'

# 4. (optional) Run T7 with real Qwen3.6-35B-A3B MTP weights download
#    (note: MTP tensors span model-00025-of-00026 and model-00026-of-00026)
ssh dgx-via-n5 'docker exec lynn-27b-nvfp4-server pip install huggingface_hub'
ssh dgx-via-n5 'docker exec lynn-27b-nvfp4-server python3 /lynn-engine/benchmarks/sp16_qwen3_next_mtp_probe.py --with-qwen36-download'
```

Production server (`generate_incremental`) is **unaffected** by this code — the new module is only imported by `engine.generate_mtp` (TBD v2) and the SP-16 probe, neither of which the server calls.

## Module shape sanity (compile-time check, no model needed)

```
fc.weight                                      → (2048, 4096)
norm.weight                                    → (2048,)
pre_fc_norm_embedding.weight                   → (2048,)
pre_fc_norm_hidden.weight                      → (2048,)
layers.0.input_layernorm.weight                → (2048,)
layers.0.post_attention_layernorm.weight       → (2048,)
layers.0.self_attn.q_proj.weight               → (4096, 2048)   # 16 heads × 256 head_dim
layers.0.self_attn.k_proj.weight               → (512, 2048)    # 2 KV heads × 256 (GQA)
layers.0.self_attn.v_proj.weight               → (512, 2048)
layers.0.self_attn.o_proj.weight               → (2048, 4096)
layers.0.self_attn.q_norm.weight               → (256,)         # over head_dim
layers.0.self_attn.k_norm.weight               → (256,)
layers.0.mlp.gate.weight                       → (256, 2048)    # 256-way router
layers.0.mlp.shared_expert_gate_proj.weight    → (512, 2048)
layers.0.mlp.shared_expert_up_proj.weight      → (512, 2048)
layers.0.mlp.shared_expert_down_proj.weight    → (2048, 512)
layers.0.mlp.shared_expert_gate.weight         → (1, 2048)
layers.0.mlp.experts_gate_up_proj              → (256, 1024, 2048)   # 256 expert × 2*INTER × HIDDEN
layers.0.mlp.experts_down_proj                 → (256, 2048, 512)    # 256 expert × HIDDEN × INTER
```

All shapes are LOCKED against Qwen3.6-35B-A3B safetensors index. Warm-start load_state_dict should be lossless.

## Memory budget (per Spark GB10 benchmark reference)

- MTP module parameters (BF16): ~0.79 GB measured on Qwen3.6-35B-A3B (same arch, 2048 hidden, 256 expert, 512 INTER)
  - shared embedding (~0.5 GB Lynn 27B uses same 248320×2048) is REUSED, not duplicated
  - lm_head (~0.5 GB) is REUSED, not duplicated
- Per-stream MTP KV cache: ~10-15% overhead on top of main KV (GB10 measured: 360k → 323k tokens capacity)
- Total Spark unified mem impact for MTP-enabled production: **+0.8-1.0 GB** vs current 80G usage → ~81G, still within 119G budget.

## Architecture references

- Qwen3.6-35B-A3B HF — same model family as Lynn 27B base
  https://huggingface.co/Qwen/Qwen3.6-35B-A3B
- Tensor list verified via safetensors index 2026-05-16
  https://huggingface.co/Qwen/Qwen3.6-35B-A3B/raw/main/model.safetensors.index.json
- Spark GB10 same-hardware benchmark: 50.51 → 54.92 TPS single-stream, +24.2% at 16-concurrent, accept 72.53%
  https://docai.hu/en/blog/qwen36-mtp-gb10
