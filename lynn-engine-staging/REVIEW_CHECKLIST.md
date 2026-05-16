# Review Checklist — qwen3_next_mtp v2 (lynn-engine-staging)

Quick pre-deploy review. Each box → ✓ when verified or ✗ + reason.

## Architecture correctness

- [ ] `engine/mtp_qwen3_next.py:Qwen3NextMTPModule.forward` data flow matches the Qwen3.6 reference architecture:
  - [ ] `pre_fc_norm_embedding(embed(t+1))` then `pre_fc_norm_hidden(prev_hidden)` then `cat` along last dim
  - [ ] FC is `Linear(2H → H)` not `Linear(H → 2H)`
  - [ ] After FC, pass through 1 transformer layer
  - [ ] Final `mtp.norm` applied at the END of the module
  - [ ] Caller (MTPController) applies `lm_head` AFTER module output (not inside)

- [ ] `Qwen3NextMTPSelfAttention` matches Qwen3 attention spec:
  - [ ] 16 attention heads, 2 KV heads (GQA), head_dim 256
  - [ ] q_norm + k_norm applied per-head AFTER projection, BEFORE RoPE
  - [ ] Partial RoPE: only first 25% × 256 = 64 dims rotated
  - [ ] Causal SDPA (we use `is_causal=True`)
  - [ ] No bias in q/k/v/o projections

- [ ] `Qwen3NextMTPMoE` matches Qwen3.5 MoE spec:
  - [ ] 256 experts, top-8 routing, +1 shared expert + shared_expert_gate (sigmoid scaling)
  - [ ] `experts_gate_up_proj` and `experts_down_proj` are **stacked** parameters (not ModuleList)
  - [ ] Routing weights via `softmax(top-8)` (float32, cast back to input dtype)
  - [ ] Shared expert is standard SwiGLU FFN (gate + up + down)

## Tensor name mapping (load from Qwen3.6 warm-start)

- [ ] `_QWEN36_TO_LYNN_MTP_KEY_MAP` covers all 19 mtp.* tensors from the Qwen3.6 safetensors index
- [ ] Mapping handles HF nested module path → flat parameter name correctly:
  - `mtp.layers.0.mlp.shared_expert.gate_proj.weight` ↔ `layers.0.mlp.shared_expert_gate_proj.weight` (renames `.` to `_` in nested module path)
- [ ] Loader functions skip non-MTP keys gracefully

## Controller state machine (vs v1)

- [ ] Signature change: `step(h_prefinal, position_ids)` — was `step(h_final)` in v1.
  - Reason: MTP needs raw hidden (before main norm); main norm applied internally to main path only.
- [ ] State machine logic UNCHANGED from v1: pending_draft handling / accept / reject / stats invariants
- [ ] Disabled-mode (mtp_module=None) returns correct 1-token-per-step behavior
- [ ] Stats: `tokens_per_step` formula self-consistent with emitted vs forwards

## SP-16 probe coverage

- [ ] T1 shape verification — catches any architecture spec mismatch at module construction
- [ ] T2/T3 forward smoke — module forward runs without NaN/Inf
- [ ] T4 state_dict remap roundtrip — load-after-remap returns no missing/unexpected keys
- [ ] T5 controller integration — full step() runs through single + verify modes
- [ ] T6 disabled-mode fallback works
- [ ] T7 (optional) downloads real Qwen3.6 MTP weights, loads strict
  - [ ] Downloads both shards containing `mtp.*`: `model-00025-of-00026.safetensors` and `model-00026-of-00026.safetensors`

## Production safety

- [ ] No changes to `engine/full_forward.py` (production decode loop)
- [ ] No changes to `engine/spark_fp8.py` (production active-MoE backend module)
- [ ] No changes to `engine/moe_packed_nvfp4.py` (production dispatch)
- [ ] No changes to `server/openai_http.py` (production server entry)
- [ ] No new env vars affecting production
- [ ] Production server `lynn-27b-nvfp4-server` will continue using `generate_incremental` (not the new MTP path) — confirmed by current server cmdline using no MTP-related flags

## Known gaps (acknowledged, not blocking deploy of THIS code)

- [ ] `engine/generate_mtp.py` v2 not updated for new MTPController signature → opt-in path not yet runnable end-to-end with real model. Documented in README.md.
- [ ] MTP KV cache for self-attn layer not yet plumbed into `LynnInferenceState` → 2-token verify forward currently re-attends to full sequence (O(T) per step). Documented in README.md.
- [ ] MoE forward uses naive einsum BF16 reference — Triton SP-08 path integration deferred until A100 head exists (no value optimizing untrained weights).

## Sign-off

- [ ] User reviewed all files in `lynn-engine-staging/`
- [ ] User approves deploy plan in README.md "Deployment plan" section
- [ ] User commits worktree branch (`claude/zealous-mirzakhani-55611c`) before scp to Spark

After sign-off: scp commands in README.md → Spark, run SP-16 probe inside container, then proceed with A100 contract amendment + main body integration as separate work.
