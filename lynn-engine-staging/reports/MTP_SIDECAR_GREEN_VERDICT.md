# MTP Sidecar GREEN Verdict — A100 AMBER Resolved (2026-05-17 09:35 HKT)

## TL;DR

Codex's A100 MTP sidecar audit returned **AMBER** with `suspicious_shape_count: 2`. Spark-side SP-16 staging verification shows this is a **FALSE POSITIVE** — the 2 "suspicious" tensors are per-head RMSNorm weights with shape `[head_dim=256]`, which my SP-16 spec correctly anticipates.

**Lynn 2048-hidden MTP warm-start is GREEN-locked.** The real Qwen3.6-35B-A3B sidecar (1.69 GB, 19 mtp.* tensors) loads strict into Lynn-owned `Qwen3NextMTPModule` with zero missing/unexpected keys; bf16 forward runs clean (no NaN/Inf).

## A100 AMBER reason (Codex audit JSON)

From `/home/merkyor/reports/mtp_a100_audit/a100_qwen36_a3b_mtp_sidecar_shape_audit_20260517_010500.json`:

```json
{
  "decision": "AMBER",
  "reason": "some sidecar tensors have dimensions not present in base config",
  "suspicious_shape_count": 2,
  "suspicious_shapes": [
    {"key": "mtp.layers.0.self_attn.k_norm.weight", "shape": [256], ...},
    {"key": "mtp.layers.0.self_attn.q_norm.weight", "shape": [256], ...}
  ],
  "base_config": {
    "hidden_size": 2048,
    "intermediate_size": null,
    "num_hidden_layers": 40,
    "vocab_size": 248320,
    "mtp_num_hidden_layers": 1
  }
}
```

The A100 audit script only validates tensor shapes against `hidden_size` (2048), `intermediate_size`, and `vocab_size` (248320). The 256 dimension on q_norm/k_norm doesn't match any of those, so flagged AMBER.

## Spark SP-16 GREEN verification

256 is the model's `head_dim` (per-head Q/K dim in Qwen3-Next gated attention with `num_attention_heads=16` × `head_dim=256` = 4096 effective; q_proj doubled to 8192 by gating). Per-head RMSNorm operates over head_dim, so [256] is the correct shape.

SP-16 staging's `expected_shape_check` (engine/mtp_qwen3_next.py:264) has been written with head_dim awareness from day 1:

```python
"layers.0.self_attn.q_norm.weight": (D,),    # D = head_dim = 256
"layers.0.self_attn.k_norm.weight": (D,),
```

### Real-weight load verification (Spark, in production container)

Ran `/lynn-engine/benchmarks/sp16_load_a100_sidecar.py`:

```
=== building Lynn MTP module ===
  Lynn module: 844.6M params

=== load A100 sidecar mtp.safetensors ===
  loaded 19 tensors from sidecar (1.69 GB)

=== remap Qwen3.6 → Lynn module names ===
  remapped 19 tensors

=== shape diff check vs SP-16 expected ===
  ALL 19 TENSORS MATCH SP-16 EXPECTED SHAPES ✓

=== strict load_state_dict ===
  STRICT LOAD PASS — no missing, no unexpected ✓

=== smoke forward ===
  forward PASS: shape=torch.Size([1, 1, 2048]) dtype=torch.bfloat16 nan=False inf=False ✓

OVERALL: GREEN
```

## What this unlocks

**Codex's overnight ROI task #3** was: "基于已抽出的 mtp.safetensors,开始做 Lynn 2048-hidden MTP warm-start 映射/shape 对齐脚本"

Spark side has this DONE:
- `engine/mtp_qwen3_next.py` (472 LOC) — Lynn-owned `Qwen3NextMTPModule` with correct 19-tensor schema
- `engine/mtp_qwen3_next.py:remap_qwen36_to_lynn_mtp()` — name remap function (sidecar → Lynn module attribute paths)
- `engine/mtp.py:load_mtp_module_from_state_dict()` — strict-mode loader
- `engine/mtp_qwen3_next.py:expected_shape_check()` — shape validator
- Plus `benchmarks/sp16_qwen3_next_mtp_probe.py` (430 LOC) — 7-test gate, all PASS on real Qwen3.6 weights

**A100 next step (Codex's domain, not Spark's)**: take the Qwen3.6 sidecar weights as warm-start init, then frozen-body fine-tune on Lynn 27B body (Lynn-distilled, Recovery-LoRA-shifted hidden distribution). The training adapts the head to Lynn's specific output distribution; the architecture-level mapping/shape work is already done.

## Files

| Path | Purpose |
|---|---|
| `/home/merkyor/models/mtp_sidecars/qwen36-35b-a3b-mtp/mtp.safetensors` | A100 Qwen3.6 sidecar, 1.69 GB, on Spark disk |
| `/home/merkyor/reports/mtp_a100_audit/a100_qwen36_a3b_mtp_sidecar_shape_audit_20260517_010500.json` | A100 AMBER audit (source) |
| `/lynn-engine/reports/overnight_optim_20260517/mtp_sidecar_load_verdict.json` | Spark SP-16 GREEN verdict (this verification) |
| `/lynn-engine/benchmarks/sp16_load_a100_sidecar.py` | Reusable verification script |
| `/lynn-engine/engine/mtp_qwen3_next.py` | Lynn MTP module + remap + expected_shape_check |
| `/lynn-engine/engine/mtp.py` | MTPController + load helpers |

## Recommended Codex action

1. ✅ Update A100 audit script to recognize `head_dim` as a valid base-config dimension (so it doesn't flag q_norm/k_norm AMBER on future sidecars)
2. ✅ Stop blocking on AMBER — warm-start mapping is verified done
3. → Proceed to **Lynn 27B body frozen-body MTP fine-tune** (this is the actual training step that adapts the Qwen3.6 warm-start to Lynn's distribution)
   - Recipe in `lynn-engine-staging/docs/MTP_RESEARCH_NOTES.md` § 5 "Frozen-body warm-start procedure"
   - Estimated A100 cost: 2-4h (per Medusa-1 frozen-body literature for adapter-class fine-tunes)
