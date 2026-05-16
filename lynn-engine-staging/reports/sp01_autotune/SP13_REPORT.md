# SP-13 Report — Spark FP8 gate/up isolation probe

**Date**: 2026-05-16
**Branch**: spark/sm121-port
**Trigger**: User requested 2-3h probe whether Spark can mirror R6000 P104 v2 "Phase 1 = gate/up W4A8 runtime first" strategy on existing SP-12 infrastructure, without waiting for W4A8 artifact.
**Result**: AMBER-NEGATIVE — current SP-12 spark_fp8 module is **W4A4 mirror, not W4A8 mirror**; Phase 1 mirror on Spark requires new kernel, not hybridization.
**Scope**: kernel-math only on synthetic data; does NOT answer real-model greedy stability.

---

## 1. Result matrix (5 seeds × 3 distributions, all cells stable σ < 0.04)

| Distribution | B1 Triton baseline | B2 Hybrid gate/up FP8 | B3 Hybrid down FP8 | B4 Full FP8 (=SP-12-F) |
|---|---|---|---|---|
| **gaussian σ=1** | cos **0.999997** / rel_l2 0.23% | cos 0.928 / rel_l2 **791%** | cos 0.997 / rel_l2 8.3% | cos 0.926 / rel_l2 **795%** |
| **wide σ=2.5** | cos **0.999997** / rel_l2 0.23% | cos 0.945 / rel_l2 54.5% | cos 0.997 / rel_l2 7.5% | cos 0.942 / rel_l2 55.3% |
| **outlier** (5% heavy-tail) | cos **0.999997** / rel_l2 0.24% | cos **0.499** / rel_l2 138% | cos 0.997 / rel_l2 7.7% | cos **0.497** / rel_l2 138% |

Reference = BF16 dequant of packed E2M1 weights + BF16 matmul (FP32 accumulator). Cosine 1.0 = perfect agreement.

## 2. Three structural observations

### Observation A: B2 ≈ B4 — gate/up FP8 swap dominates the error

B2 (hybrid gate/up FP8 + Triton down) and B4 (full FP8 = SP-12-F path) produce **statistically identical errors** across all 15 cells. The Triton-down "fix-up" in B2 doesn't recover anything because **the error is already baked in at gate/up's activation quantization**, and propagates linearly through whatever down path follows.

→ **Phase 1 mirror hypothesis (ship gate/up FP8 alone) is dead** on current Spark SP-12 infrastructure.

### Observation B: B3 is mostly clean — down FP8 alone is safer than gate/up FP8 alone

B3 (Triton gate/up keeping BF16 act + spark_fp8 down) maintains cos 0.997 and rel_l2 ~8% even on outlier distribution. This is the **opposite of what the user's Phase 1 strategy assumed**:
- R6000 P104 v2 + user split: gate/up = "easy", down = "hard"
- Spark synthetic kernel data: gate/up = catastrophic, down = OK-ish

The asymmetry is **NOT a property of the projection** — it's a property of where the activation quantization happens.

### Observation C: Outlier distribution causes catastrophic collapse (B2/B4)

Cosine drops to 0.5 — essentially uncorrelated output — when activation has 5% heavy-tail samples. This matches R6000 P105 "layer 16 rel_l2 3.30%" pattern: layers with outlier activations are where the W4A4 mirror breaks worst. Common LLM layers with this pattern: layers around attention pre-norm where unembedding feedback accumulates.

## 3. Root cause: SP-12 is W4A4 mirror, not W4A8 mirror

This was the central misunderstanding in the framing prior to this probe.

| Path | Activation | Weight | MMA | Spark sm_121 support |
|---|---|---|---|---|
| Production current (Triton) | **BF16** | E2M1 (FP4) | mixed BF16×FP4 implemented in Triton | ✓ |
| **R6000 P103/P104 v2 (NEW W4A8)** | **FP8 E4M3** | E2M1 (FP4) | FP8×FP4 mixed (native MMA on sm_120a) | ✗ sm_121 has no FP4 MMA |
| **Spark SP-12 (current spark_fp8)** | **E2M1 (FP4)** | E2M1 (FP4) | E2M1→FP8 LUT expand, FP8×FP8 MMA | ✓ this is what exists today |
| **Real Spark W4A8 mirror (DOES NOT EXIST)** | **FP8 E4M3** | E2M1 (FP4) | E2M1→FP8 LUT expand, FP8×FP8 MMA | ✓ possible but kernel not written |

Key insight: **The current SP-12 spark_fp8 module pre-quantizes activation from BF16 to E2M1** via `quantize_fp4_m1_native` (see engine/spark_fp8.py:active_moe_spark_fp8 line ~430). This squashes activation dynamic range from BF16 (±~3.4e38) to E2M1 (±6.0) **before any MMA**, which is what destroys numerical fidelity.

W4A8 mirror would keep activation in FP8 E4M3 (±448 dynamic range, 24× wider than E2M1) — still casts from BF16 but loses far less information.

## 4. Strategic implications

### Phase 1 mirror status: blocked on Spark

The user's R6000 strategy "do gate/up W4A8 runtime first, leave down for A100 lightweight QAT" **cannot be ported to Spark using SP-12-as-is** because the only existing FP8 path on Spark is W4A4 mirror, and gate/up specifically is where the activation quantization happens.

### Three forward options for Spark

**Option α (Build W4A8-on-Spark kernel)** — engineering work, ~1-2 weeks
- Modify spark_fp8 `sparkfp8_gate_up_kernel` (engine/spark_fp8.py CUDA source) to take FP8 E4M3 activation directly instead of expanding E2M1 nibbles via LUT
- Activation prep changes from `quantize_fp4_m1_native` to `act.to(torch.float8_e4m3fn)` — much cheaper
- Weight side stays the same E2M1 → FP8 LUT expansion
- Expected numerical class: cos > 0.999 across all distributions (matching Triton W4A16 baseline closely)
- After this exists: Spark CAN mirror R6000's gate/up-FP8 Phase 1 strategy on production BF16 model

**Option β (Wait for W4A8 artifact, then build kernel)** — sequential
- A100 trains W4A8-aware model first
- Then Spark builds W4A8 mirror kernel
- Test on the new artifact directly
- Lower risk but slower

**Option γ (Stay on Triton SP-08 production, skip W4A8 mirror)** — pragmatic
- Spark current production already = Triton baseline (B1) which is essentially perfect (cos 0.999997 / rel_l2 0.002)
- 49 TPS achieved on production today
- Skip the W4A8 mirror entirely; let R6000 own the W4A8 throughput story
- Spark's value props (long ctx 6.77× / stddev 37× steadier / multi-service / cross-framework oracle) don't require W4A8

### Recommendation

**Default to Option γ unless user explicitly wants to invest in α.** Reasoning:
- R6000 5/24 退租 — Spark becomes long-term main; production stability > kernel ambition
- Phase 1 R6000 ship + Phase 2 A100 lightweight QAT timeline is short; W4A8-on-Spark kernel could miss the artifact
- Option α adds development risk and code surface; current 49 TPS is already enough for Spark's stability+long-ctx role
- W4A4 mirror SP-12 path can stay as research artifact (B4 numerical study) without being a production target

If user later changes mind, Option α is feasible — the kernel change is well-scoped (~50-100 LOC in spark_fp8 CUDA source, activation prep change).

## 5. What this probe did NOT do (next-step gates)

1. **Real-model layer-specific test**: synthetic outlier distribution stressed kernels but doesn't = real Lynn 27B layer 16. To answer the literal user question, need to capture real layer-16 activations and rerun. Cost: stop production server, load model into a second process, capture, restart. ~30 min mem-budget operation.

2. **No W4A8-on-Spark prototype**: not built. The forward fix path is well-understood (replace activation quantization in spark_fp8 module), but writing it was beyond the 2-3h probe scope.

3. **No greedy-token test**: kernel cosine 0.5 doesn't tell us what token output looks like. Greedy parity matters for ship decision.

## 6. Files

- Probe: `/lynn-engine/benchmarks/sp13_gate_up_isolation_probe.py` (359 LOC, syntax-checked, self-contained)
- Smoke run: `/lynn-engine/reports/sp01_autotune/sp13_smoke.json`
- Full run: `/lynn-engine/reports/sp01_autotune/sp13_gate_up_isolation_full.json`
- This report: `/lynn-engine/reports/sp01_autotune/SP13_REPORT.md`

---

**Probe wall-clock**: ~2h including infra exploration + design + code + 17 forward passes.
**Probe did NOT alter production server** — `lynn-27b-nvfp4-server` container kept running throughout.
**Default toggle status**: SP-13 introduces no env vars or production code paths. Per user constraint: probe-only, not default-on.
