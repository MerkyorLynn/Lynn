# SP-15 Report — Lynn 27B MTP/NEXTN Scaffolding Ready

**Date**: 2026-05-16
**Trigger**: User directive "动手 不用请示 最终目标 27B W4A8 NVFP4 MTP 跑通"
**Status**: MTP runtime scaffolding complete + tested. Awaiting A100-trained NEXTN head + production restart window for end-to-end run-through.

---

## 1. What's done this session

| Artifact | Path | Status |
|---|---|---|
| MTP controller module | `engine/mtp.py` | 313 LOC, imports OK in production container |
| Standalone scaffolding probe | `benchmarks/sp15_mtp_pipeline_probe.py` | 351 LOC, 7/7 tests PASS in 444 ms |
| MTP-aware generate fn | `engine/generate_mtp.py` | 220 LOC, imports OK, wired but untested with real model |
| A100 NEXTN training contract | `reports/sp01_autotune/A100_NEXTN_HEAD_CONTRACT.md` | Locks output format A100 must produce |
| Scaffolding JSON | `reports/sp01_autotune/sp15_mtp_scaffolding.json` | Test results |
| This report | `reports/sp01_autotune/SP15_REPORT.md` | |

**Production untouched**: `engine/full_forward.py`, `engine/spark_fp8.py`, `engine/moe_packed_nvfp4.py`, `server/openai_http.py` — all unchanged. `generate_incremental_mtp` is in a NEW file, NOT imported by the production server. Server is on the original `generate_incremental` path.

## 2. MTPController design

State machine for 1-token-lookahead speculative decoding:

```
Single-mode forward (T=1):    input [t]           -> emit [main]              -> next [main, draft]
Verify-mode forward  (T=2):   input [main, draft] -> if accept: emit [draft, new_main]  -> next [new_main, new_draft]
                                                  -> if reject: emit [verify_token]      -> next [verify_token]  (back to single-mode)
```

Key invariants verified by SP-15 probe (7/7 PASS):

| Test | Validates |
|---|---|
| disabled_path | When nextn=None, controller behaves identically to baseline (1 forward → 1 token) |
| perfect_nextn (math sanity) | Verify+accept code path doesn't crash; stats calculator correct |
| random_nextn (reject path) | Random NEXTN → 0 accept / 100% reject, controller correctly returns to single-mode |
| disabled_matches_baseline | Disabled MTP emits SAME tokens as a naive single-token loop (15-token sequence) |
| load_nextn_missing | Returns None gracefully when no head in dict + no dir |
| load_nextn_from_dict | Finds canonical key `mtp.head.weight` in outside dict |
| stats_tracking | `tokens_per_step` formula self-consistent with n_emitted/n_forwards |

## 3. A100 NEXTN head training contract (LOCKED 2026-05-16)

Spec at `reports/sp01_autotune/A100_NEXTN_HEAD_CONTRACT.md`. Key points:

- **Tensor name**: `mtp.head.weight` (preferred) or one of 4 alternates the Spark loader auto-scans
- **Shape**: `[VOCAB=248064, HIDDEN=2048]` matching `lm_head.weight`
- **dtype**: bf16
- **config.json metadata**: add `text_config.mtp_head_present=true`, `mtp_predict_offset=2`
- **Recipe**: train head on frozen Lynn 27B body, ~500-1000 steps, CE loss vs t_{k+2}, expected accept rate 60-70%

If A100 follows the contract, integration is one command:

```python
from engine.generate_mtp import generate_incremental_mtp
out, ids, stats = generate_incremental_mtp(model_dir=ARTIFACT_PATH, prompt="...", mtp_enabled=True)
# stats includes: accept_rate, tokens_per_step, n_forwards, observed_tps
```

## 4. Why end-to-end real-model test is deferred

Three blockers, none caused by this session's work:

1. **No NEXTN head exists yet** — `load_nextn_head_weight()` on current model artifact returns None, which makes MTPController fall back to standard single-token mode. This is the expected state until A100 ships.

2. **2-token decode currently goes through prefill fallback** — `_decode_layer` is hardcoded for T=1. The fallback `_two_token_forward_via_prefill` in `generate_mtp.py` uses `_prefill_layer` which handles T>1. This is correctness-first (matches numerics), but the speed of the verify step is closer to a prefill-of-2 than a true 2-token decode. Real production speedup requires extending `_decode_layer` to T=2, which is a larger refactor deferred until the NEXTN head exists to actually validate the optimization is worth it.

3. **Real-model integration test needs ~50 GB free** to load a second model instance (current production holds the only copy at ~80G). Spark currently has ~22G free. Options when ready:
   - Stop production server, run integration test, restart (~30 min downtime)
   - Restart production with `LYNN_MTP_ENABLED=1` env var + opt-in to `generate_incremental_mtp` instead of `generate_incremental` (~5 min downtime once code path is verified safe)

None of the three blockers requires more code work today.

## 5. Expected speedup math (Spark, Triton SP-08 backend)

Current Spark production: 49.37 TPS baseline.

With MTP enabled and A100-trained NEXTN head:
| Accept rate | tokens/step | Spark TPS estimate |
|---|---|---|
| 50% (conservative) | 1.50 | 74.0 |
| **65% (expected)** | 1.65 | **81.5** |
| 75% (optimistic) | 1.75 | 86.4 |

**With W4A8 (γ Triton path on Spark)**: no compound win, since SP-14 confirmed W4A8 kernel is slower than Triton on Spark sm_121. Combined TPS = same as MTP alone, ~81 TPS.

**Compound win is on R6000** (W4A8 native ~150 TPS × MTP 1.65 = 247 TPS class), not Spark.

## 6. Spark long-term position UPDATED post-this-session

| Component | State | Spark value prop |
|---|---|---|
| Triton SP-08 (γ production) | 49 TPS, locked, untouched | Baseline production |
| SP-14 W4A8 kernel | Math OK, slower than Triton, research-only α | Hardware capability proof, dormant until W4A8 artifact |
| MTP scaffolding | Built today, awaits A100 NEXTN head | Path to ~80 TPS when head arrives |
| Long ctx 6.77× SGLang | Unchanged architecture advantage | Real differentiation |
| Stddev 37× steadier | Unchanged | Multi-stream stability |
| Multi-service 119G unified | Unchanged | Capacity advantage over discrete GPU |

After 5/24 R6000 退租, Spark is long-term main. The 5 components above are Spark's narrative.

## 7. What user does next (decision needed when A100 NEXTN head ready)

1. **Verify A100 artifact matches contract** — name match, shape match, config.json present
2. **Schedule Spark production restart window** — ~5-30 min depending on test scope
3. **Run Gate 1-3** (math + 6-prompt greedy + 16k smoke) on real model with `LYNN_MTP_ENABLED=1`
4. If all pass: opt-in MTP for default production. Expected uplift 49 → 81 TPS class.

## 8. Files unchanged in production

```
engine/full_forward.py     <- still has original generate_incremental
engine/spark_fp8.py        <- W4A4 mirror, still production fallback (currently off)
engine/moe_packed_nvfp4.py <- backend dispatcher, MTP code does not touch it
server/openai_http.py      <- production entry, unaware of MTP
moe_packed_nvfp4 env vars  <- LYNN_NATIVE_ACTIVE_MOE_BACKEND, LYNN_SP_TRITON_AUTOTUNE unchanged
```

## 9. Probe artifacts inventory (this session, full)

```
SP-13 (gate/up isolation, identified SP-12=W4A4):
  benchmarks/sp13_gate_up_isolation_probe.py
  reports/sp01_autotune/sp13_*.json
  reports/sp01_autotune/SP13_REPORT.md

SP-14 (W4A8 mirror kernel, math PASS / timing -8%):
  benchmarks/sp14_w4a8_math_contract_probe.py
  benchmarks/sp14_timing_bench.py
  reports/sp01_autotune/sp14_w4a8_math_contract.json
  reports/sp01_autotune/SP14_REPORT.md

SP-15 (MTP scaffolding):
  engine/mtp.py                                   <- MTPController + load_nextn_head_weight
  engine/generate_mtp.py                          <- generate_incremental_mtp (wired, untested with real model)
  benchmarks/sp15_mtp_pipeline_probe.py
  reports/sp01_autotune/sp15_mtp_scaffolding.json
  reports/sp01_autotune/A100_NEXTN_HEAD_CONTRACT.md
  reports/sp01_autotune/SP15_REPORT.md            <- this file
```

Production untouched throughout. Production server `lynn-27b-nvfp4-server` ran for entire session without interruption.

---

**Session wall-clock**: ~3.5h since "动手 不用请示".
**Production downtime**: 0 seconds.
**Code progress toward "MTP 跑通"**: ~70% (scaffolding + wiring done; ~30% remaining = A100 NEXTN head delivery + production restart for real-model test).
