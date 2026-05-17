# Task B: Whole-Decode CUDA Graph — Investigation Verdict

**Date**: 2026-05-17 ~10:30 HKT
**Goal**: Push Spark TPS from 49 (Config D) toward 70 via full-decode graph capture
**Result**: ⚠️ **Existing implementation is per-token strict-slot capture, 5× SLOWER than Config D**. Real win requires REUSE-mode whole-decode graph (architectural refactor, ~1-2 days code).

## Discovery — graph capture infrastructure already exists

`engine/resident_runner.py` has TWO env-toggled graph capture paths:

| Env | Scope | Pattern | Production default | Status |
|---|---|---|---|---|
| `LYNN_LINEAR_BLOCK_GRAPH=1` | linear-attn blocks (10 blocks × 3 linear layers) | Reuse-capable (`_REUSE=1`) | ✅ ON in Config D | works |
| **`LYNN_FULL_TOKEN_GRAPH_SLOT=1`** | **whole 40-layer + lm_head** | **Strict per-position re-capture each step** | ❌ OFF by default | this investigation |

The whole-decode graph IS implemented at `engine/resident_runner.py:_capture_full_token_graph_slot` (line 519-572). It captures the full 40-layer pass + lm_head in one CUDAGraph and replays.

## Per-position strict slot — empirical measurement

Tested by restarting Spark with Config D + `LYNN_FULL_TOKEN_GRAPH_SLOT=1`:

- Per-token decode latency: **95-97 ms** (observed in docker logs `[resident] decode N/200 95ms`)
- Equivalent TPS: **~10 TPS**
- vs Config D (no full-token-graph-slot): ~20 ms = ~49 TPS
- **Net: 5× SLOWER**

Root cause (per code comment at line 519):

> "This is not yet wired into default `generate()`: **future-window graph families drift**, while **current-position graph slots are strict**."

"Strict slot" = re-capture every token because the captured graph references `state.seq_len = N`. Going from token at position N to position N+1 would replay with stale `seq_len`, so each token captures fresh. Capture itself takes ~80 ms (graph construction overhead for 40-layer chain), plus ~10 ms replay, vs ~20 ms eager — net loss.

## Real winning path = REUSE-mode whole-decode graph (NOT implemented)

For full-decode graph to be a TPS win, need REUSE pattern matching what `LINEAR_BLOCK_GRAPH_REUSE=1` does for linear-attn blocks:

1. **Pre-allocate static KV cache slots** to `max_seq_len` (already done — `state.kv_cache` is pre-allocated)
2. **Make seq_len position a graph INPUT** (currently it's captured as a Python int closed over by `graph_body()`)
3. **Static-shape attention** — currently full-attention attends to `[:seq_len]` which is data-dependent slice
4. **In-place KV write at position-indexed slot** — must use scatter via indexed gather/copy, not arbitrary indexing
5. **MoE expert dispatch graph-safe** — current per-token top-k routing is data-dependent → BLOCKER

Items 1-4 are graph-tractable with careful refactoring. Item 5 (MoE) is the actual hard one:
- Either: padded MoE (all experts active, mask out unused) — kills MoE sparsity efficiency
- Or: MoE outside graph (split graph into "before-MoE" + "MoE eager" + "after-MoE" per layer) — has 40 graph→eager→graph transitions per token, may eat the win
- Or: graph per expert combination (combinatorial explosion across 40 × C(256,8) = unworkable)

## Comparison: existing partial graph already captures the easy win

`LYNN_LINEAR_BLOCK_GRAPH=1 + REUSE=1 + PREWARM=1` (Config D's setting) captures:
- 10 linear-attn blocks (3 layers each) into 10 CUDAGraphs
- Each block captured once, replayed across positions (REUSE works because linear-attn recurrent state update is in-place at fixed slot)
- Full-attention layers (~10 total) and MoE run eagerly between graph replays
- This is the SWEET SPOT for Lynn's hybrid architecture

The remaining +43% gap to 70 TPS would have to come from full-attention being graph-captured AND MoE optimized — both nontrivial.

## Realistic ROI assessment (revised vs earlier estimate)

Previously documented in `final_summary.md`:

> Whole-decode CUDA graph: +20-40% → 60-68 TPS, 1-2 days code work

Reality after investigation:
- Strict per-position slot: **5× LOSS** (negative ROI as-is)
- REUSE whole-decode graph requires:
  - Static seq_len graph input — moderate refactor (~1-2 days)
  - PLUS MoE-graph-safety solution — could be days to weeks (MoE is the blocker)
- Realistic gain IF both done: maybe +15-25% (NOT +20-40% — full graph has overhead at this size too)
- **Reaching 70 TPS via whole-decode graph alone: HARDER than initially scoped**

## Alternative paths to 70 TPS

Given whole-decode graph is harder than expected, other levers:

1. **MTP/NEXTN speculation** — when A100 ships the trained head, expected +8-15% (validated cross-platform), so 49 → ~56 TPS. Combined with future whole-decode graph: 56 × 1.15 = ~64 TPS class.
2. **Kernel-level fusion in MoE** — SP-12 work showed Spark sm_121 (no FP4 MMA) can't beat Triton autotune significantly. Limited.
3. **Reduce Python overhead per step** — Python interpreter overhead is ~few ms per step; could fuse `_decode_layer` chain into one Python call → modest gain.
4. **Move serving to R6000** — R6000 sm_120a native FP4 path hits 100+ TPS class per memory. **This is the most direct path to 70+ TPS, but architectural decision, not Spark scope**.

## Verdict

- `LYNN_FULL_TOKEN_GRAPH_SLOT=1` (existing strict slot) is NOT a production win — net 5× slower
- True whole-decode graph (with REUSE) requires architectural refactor of decode loop AND MoE graph-safety — multi-day effort with high risk
- **Production stays at Config D = 49 TPS class decode-only**
- 70 TPS on Spark single-stream requires either (a) significant Lynn engine code work, OR (b) MTP head landing (Codex's A100 task)
- Most pragmatic path to 70 TPS for Spark: **MTP head trained on A100 → Spark uses it via SP-16 staging warm-start mapping (already ready)** + minor decode optimization

Config D remains locked production state. No regression from Task B exploration (server restored).

## Files

- `engine/resident_runner.py:519-572` `_capture_full_token_graph_slot` — existing impl
- `engine/resident_runner.py:908-988` decode loop integration
- Spark observed metric: per-token 95-97ms with FULL_TOKEN_GRAPH_SLOT=1 vs 20ms without
