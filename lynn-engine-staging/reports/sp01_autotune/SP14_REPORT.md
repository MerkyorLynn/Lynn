# SP-14 Report — Spark W4A8 FP8×FP8 Mirror: Math Contract PASS, Production Decision = γ (no ship)

**Date**: 2026-05-16
**Branch**: spark/sm121-port (logically — research-only artifact)
**Trigger**: User authorized "立刻验证 gate/up-only FP8 mirror 是否能给 Spark 白捡 15-30% TPS" with explicit constraint that default production must wait for math contract + 6-prompt greedy parity + 16k smoke. R6000 P104/P105 explicitly disallowed as substitute for Spark measurement.
**Outcome**: Math contract PASSED (numerical fidelity recovered). Speed test FAILED hypothesis (39% SLOWER than Triton SP-08, not 15-30% faster). User decision: **γ = Triton SP-08 production default / α = SP-14 W4A8 kernel kept as research-only artifact, not integrated into production code**.

---

## 1. Math Contract Gate (Gate 1 of 3) — **PASSED**

Built a new W4A8 mirror CUDA kernel (FP8 E4M3 activation + E2M1 weight LUT-expanded to FP8 + FP8×FP8 m16n8k32 MMA + per-16 FP32 scale epilogue). Standalone JIT extension; production `engine/spark_fp8.py` module untouched.

Thresholds: cosine ≥ 0.999, rel_l2 ≤ 0.05.

| Distribution | B1 Triton baseline | **B5 W4A8 NEW** | B2 SP-12 W4A4 (failure ref) |
|---|---|---|---|
| gaussian σ=1 | 0.999997 / 0.0023 ✓ | **0.9995 / 0.031 PASS** | 0.928 / 7.92 FAIL |
| wide σ=2.5 | 0.999997 / 0.0023 ✓ | **0.9995 / 0.031 PASS** | 0.945 / 0.54 FAIL |
| outlier 5% heavy-tail | 0.999997 / 0.0024 ✓ | **0.9998 / 0.020 PASS** ⭐ | **0.499 / 1.38 collapse** |

**Critical recovery**: outlier distribution where SP-12 W4A4 collapsed to cos 0.499 (and which mirrors R6000 P105 "layer 16 rel_l2 3.30%") — W4A8 kernel restores it to **cos 0.9998**. FP8 E4M3 dynamic range (±448) vs E2M1 (±6) provides the 75× wider headroom that outlier activations need.

Conclusion: W4A8 FP8×FP8 mirror with E2M1→FP8 LUT weight expansion is **numerically sound on Spark sm_121**. Theoretical strategy is correct.

## 2. Timing Bench — **HYPOTHESIS REFUTED**

200-iter microbench at production shape (HIDDEN=2048, INTERMEDIATE=512, E=256, top_k=8):

| | Time per call (μs) | TPS impact |
|---|---|---|
| B1 Triton SP-08 (production) | **112.49** | 49.37 baseline |
| B5 W4A8 hybrid NEW | 156.77 | **45.4 (-8.1%)** projected |

**W4A8 mirror is 39% SLOWER than Triton SP-08**, not 15-30% faster. Projected TPS uplift if shipped: **NEGATIVE -8%**.

### Why W4A8 is slower on Spark sm_121

1. **Triton SP-08 is heavily optimized via autotune** — SP-01 through SP-08 sessions tuned BF16×FP4 fused gate_up_silu kernel into a tight ~112 μs. This is near-ISA-bound on sm_121 already, not a baseline waiting to be improved.

2. **W4A8 hybrid has Python overhead** — `quantize_fp8_e4m3_per16` Python op + `ext.w4a8_gate_up` kernel launch + Python SiLU + multiply. Triton fuses all of this into a single GPU launch.

3. **LUT decode B-side eats FP8 MMA peak throughput** — sm_121 FP8 MMA is theoretically ~2× faster than BF16, but every weight fragment requires E2M1→FP8 LUT decode (decompress 4 nibbles × 8 rows per inner iteration). LUT decode compute overhead offsets the MMA speed gain.

4. **ISA gap with R6000**: R6000 sm_120a has **native** FP8×FP4 mixed-MMA atoms (P103 finding). Spark sm_121 must use FP8×FP8 + software LUT for weights. The Spark approach is fundamentally a software emulation of R6000's hardware path, which always loses speed comparison even when numerics match.

### Hypothesis attribution

The "15-30% TPS bonus" hypothesis was extrapolated from R6000 P104 v2 timing data + assumption that Spark FP8 MMA throughput beats Triton's BF16×FP4. The Spark-specific ISA constraint (no native FP4 MMA → LUT decode required) breaks this extrapolation. **This is exactly why the user constraint "R6000 P104/P105 不替代 Spark 实测" was essential** — without Spark's own timing measurement we'd have shipped a -8% regression.

## 3. Decision Matrix

| Option | Description | Spark TPS impact | Effort | User decision |
|---|---|---|---|---|
| **γ (Production default)** | Stay on Triton SP-08 autotune | 49.37 (baseline) | 0 | ✓ **Selected** |
| **α (Research artifact)** | SP-14 W4A8 kernel kept in `/lynn-engine/benchmarks/sp14_*.py` as research code, NOT integrated into production. Documented as proof-of-concept "W4A8 numerically sound on sm_121, awaiting W4A8 trained artifact to validate full chain". | unchanged | already done (this session) | ✓ **Selected** |
| β (Optimize W4A8 to beat Triton) | Fuse SiLU into kernel + persistent warps + reduce Python overhead | unknown, requires 1-2 days work | not pursued | rejected |
| δ (Continue Gate 2/3 anyway) | Run 6-prompt greedy + 16k smoke on production restart window despite -8% TPS | -8% production regression | ~2-3h + production downtime | not pursued |

User's reasoning (logged): "Spark 不要硬追 R6000 的 FP4 主线,但可以写真 W4A8 FP8×FP8 mirror 做验证,不要碰 production"

## 4. Strategic Position Lock — Spark Long-term Role

Spark sm_121's value props remain:
- Long ctx 6.77× SGLang (architecture advantage)
- Stddev 37× steadier than SGLang FP8+MTP (autotune + tighter scheduling)
- Multi-service unified memory 119G (cannot be done on 96G discrete-GPU R6000)
- Long-term main repo + SGLang oracle + HF/MS publishing host
- 49 TPS class production single-stream

Single-stream TPS racing is NOT in Spark's competitive position. R6000 sm_120a owns the W4A8 throughput story (155-200 TPS class). After R6000 退租 2026-05-24, Spark serves as production stability + long-context + multi-service + cross-framework oracle. W4A8 throughput on Spark would require:
- Either a model trained with FP8 activations (Spark could then drop the LUT and benefit from FP8 act caching)
- Or hardware refresh to a sm_120a+ device with native FP4 MMA

Neither is the current bet.

## 5. Files (research-only, NOT in production path)

| File | Purpose |
|---|---|
| `/lynn-engine/benchmarks/sp13_gate_up_isolation_probe.py` | 4-backend × 3-dist matrix probe (initial finding: SP-12 is W4A4 not W4A8) |
| `/lynn-engine/benchmarks/sp14_w4a8_math_contract_probe.py` | W4A8 CUDA kernel + math contract gate |
| `/lynn-engine/benchmarks/sp14_timing_bench.py` | Timing comparison B1 vs B5 |
| `/lynn-engine/reports/sp01_autotune/SP13_REPORT.md` | SP-13 report |
| `/lynn-engine/reports/sp01_autotune/SP14_REPORT.md` | This report |
| `/lynn-engine/reports/sp01_autotune/sp13_*.json` / `sp14_*.json` | Raw probe data |

Production assets untouched:
- `engine/spark_fp8.py` — unchanged
- `engine/moe_packed_nvfp4.py` — unchanged
- `server/openai_http.py` — unchanged
- Production container env — unchanged (`LYNN_NATIVE_ACTIVE_MOE_BACKEND` not set, defaults to Triton path)
- Production server `lynn-27b-nvfp4-server` — ran uninterrupted throughout probe session

## 6. Future Triggers — When to Revisit α

The SP-14 W4A8 kernel is dormant code, not abandoned code. Revisit if any of these conditions become true:

1. **A100 produces a W4A8-aware trained artifact** — model with FP8-activation-aware weights eliminates the LUT-decode penalty on the weight side because activations would be FP8 from training. Spark mirror could then make sense.
2. **Spark gets a hardware refresh** to sm_120a+ device with native FP4 MMA support.
3. **An alternate Spark kernel architecture proves > Triton SP-08** at gate/up specifically (e.g., fused-silu W4A8 with persistent CTA scheduling).

None of the three are on the near roadmap. Phase 2 of user's R6000 strategy ("down activation delegated to A100 lightweight QAT") will produce the W4A8-aware artifact in time — that's the natural revisit trigger.

---

**Session wall-clock**: ~2h 40min from "可以立刻验证" to this report.
**Production downtime**: 0 seconds.
**Probe-only constraint satisfied**: no env vars added, no module imports rerouted, no default-on toggles introduced.
**User's "Spark 实测" constraint satisfied**: timing measured on Spark sm_121 with synthetic data at production shapes; R6000 P104/P105 numbers were NOT used as proxy.
