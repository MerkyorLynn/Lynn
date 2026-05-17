# Task C: Spark Loader v2 Compatibility — GREEN VERDICT

**Date**: 2026-05-17 10:00 HKT

## Question

V2 NVFP4 artifact uses different tensor naming than v0 (`.packed` vs `.weight_packed` etc).
Can Spark `engine/loader.py` load v2 without code changes?

## Investigation

Spark `engine/loader.py:_load_qwen36_layer_lynn_variable_nvfp4` is **manifest-driven**:
- Reads `lynn_quant_manifest.json["quantized_tensors"][key]["packed_key"]` etc.
- Does NOT hard-code `.weight_packed` suffixes
- Treats keys as opaque pointers into safetensors index

## V2 vs V0 manifest comparison

For `model.language_model.layers.0.linear_attn.in_proj_a.weight`:
- v0 manifest packed_key: `...in_proj_a.weight_packed` (underscore)
- v2 manifest packed_key: `...in_proj_a.weight.packed` (dot)

For `model.language_model.layers.0.mlp.experts.down_proj`:
- v0 manifest packed_key: `...down_proj.weight_packed`
- v2 manifest packed_key: `...down_proj.packed` (no weight_ prefix on experts)

**Both manifests correctly self-describe their actual safetensors keys.**

Cross-ref test: all 542 v2 manifest packed/scale/global_scale keys are present in v2's
safetensors index. No orphan/missing entries.

## Real load smoke test

`docker exec lynn-27b-nvfp4-server python3 /lynn-engine/benchmarks/loader_v2_smoke.py`:

```
v0 layer 0: 18 tensors / 1.67 GB / 7.2s
v2 layer 0: 18 tensors / 1.67 GB / 3.5s
config: {num_experts: 254, shared_intermediate: 512, expert_intermediate: 512}  [match]
sample shapes: identical
```

→ Same shapes, same dtypes, same per-layer config.

## Verdict

**TASK C GREEN: Spark loader handles v2 transparently. No code changes needed.**

This confirms Codex's R6000 "loader smoke 已通过" finding from the overnight handoff.
SP-17 T7 topology diff that flagged 240 tensor name differences was a false-positive
at the topology-comparison level; the loader doesn't care about names directly, only
about manifest pointers (which v2 correctly produces).

## Implication for production swap

When/if production is to be swapped from v0 to v2:
- Loader: COMPATIBLE
- BUT v2 is W4A8-only artifact (alpha-folded weights only work correctly with FP8
  activation inference, not BF16). Spark current Triton path uses BF16 activations.
- Therefore production swap to v2 is STILL blocked on building W4A8 inference path,
  even though loading file metadata works.

## Files

- `/home/merkyor/lynn-engine/benchmarks/loader_v2_smoke.py` — reusable v0/v2 load test
- `/home/merkyor/lynn-engine/benchmarks/manifest_expert_check.py` — manifest comparison
- `/lynn-engine/reports/overnight_optim_20260517/TASK_C_LOADER_V2_GREEN.md` — this report
