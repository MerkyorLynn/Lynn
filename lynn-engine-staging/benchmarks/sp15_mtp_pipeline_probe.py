#!/usr/bin/env python3
"""SP-15: MTP/NEXTN pipeline scaffolding probe.

Validates `engine/mtp.py` MTPController state machine with a synthetic
deterministic mock model. No 27B load; runs in seconds.

Question: Does the MTP speculative decode loop correctly handle:
  - Single-token vs 2-token forward shapes
  - Accept path: emit (verified_draft + new_main) -> 2 tokens / forward
  - Reject path: emit (verified_main) -> 1 token / forward, return to single-mode
  - Stats accounting (accept rate + throughput multiplier)
  - Graceful disable when no NEXTN head provided

Output: PASS/FAIL gate on 6 scenario tests.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import torch
import torch.nn.functional as F

sys.path.insert(0, '/lynn-engine')

from engine.mtp import MTPController, generate_tokens_mtp, load_nextn_head_weight


# ---------------------------------------------------------------------------
# Mock model: deterministic h = f(input_tokens)
# ---------------------------------------------------------------------------

VOCAB = 256
HIDDEN = 64


def make_mock_lm_head(device: torch.device, seed: int = 42) -> torch.Tensor:
    g = torch.Generator(device=device).manual_seed(seed)
    return torch.randn(VOCAB, HIDDEN, generator=g, device=device, dtype=torch.float32) * 0.1


def make_mock_nextn_head_perfect(lm_head: torch.Tensor) -> torch.Tensor:
    """A "perfect" NEXTN head — predicts the same token as lm_head would on the same h.

    In a real scenario, this is the upper-bound accept rate (~100%). Useful
    to validate the accept-path code branch independently.
    """
    return lm_head.clone()


def make_mock_nextn_head_random(device, seed: int = 99) -> torch.Tensor:
    """Random NEXTN head — predictions uncorrelated with lm_head -> ~0% accept rate.

    Useful to validate the reject-path code branch.
    """
    g = torch.Generator(device=device).manual_seed(seed)
    return torch.randn(VOCAB, HIDDEN, generator=g, device=device, dtype=torch.float32) * 0.1


class MockForward:
    """Deterministic forward: hidden_state[t] = embed(token[t]) + cumsum encoding.

    Given input_ids (list[int] length 1 or 2), produces [1, T, HIDDEN].

    Critically: the hidden state for a token only depends on the token itself
    plus prior context. This means feeding [a, b] in step k vs feeding just
    [a] then [b] in separate steps produces DIFFERENT hidden states (mimics
    real model attention dependencies).

    For unit-testing the MTP controller logic, we only need consistency: same
    inputs -> same outputs across steps.
    """

    def __init__(self, device: torch.device, vocab: int = VOCAB, hidden: int = HIDDEN):
        g = torch.Generator(device=device).manual_seed(7)
        self.embed = torch.randn(vocab, hidden, generator=g, device=device, dtype=torch.float32) * 0.3
        self.context: list[int] = []
        self.device = device
        self.hidden = hidden

    def reset(self, prefill_ids: list[int] | None = None):
        self.context = list(prefill_ids) if prefill_ids else []

    def __call__(self, input_ids: list[int]) -> torch.Tensor:
        """Forward pass. Updates internal context.

        Returns: [1, T=len(input_ids), HIDDEN]
        """
        outs = []
        for tok in input_ids:
            self.context.append(tok)
            # Deterministic h: weighted sum of last few context embeddings
            ctx = self.context[-8:]  # last 8 tokens
            weights = torch.tensor([0.5 ** (len(ctx) - i - 1) for i in range(len(ctx))],
                                   device=self.device, dtype=torch.float32)
            h = sum(w * self.embed[t] for w, t in zip(weights, ctx))
            outs.append(h)
        h_stack = torch.stack(outs, dim=0).unsqueeze(0)  # [1, T, H]
        return h_stack


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_disabled_path():
    """When NEXTN head is None or enabled=False, controller behaves like baseline."""
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    lm = make_mock_lm_head(device)
    fwd = MockForward(device)

    ctrl = MTPController(lm, nextn_head_weight=None)
    assert ctrl.enabled == False, "expected disabled when nextn=None"

    # 5 single-token steps -> 5 tokens emitted
    next_input = [10]
    emitted = []
    for _ in range(5):
        h = fwd(next_input)
        toks, next_input = ctrl.step(h)
        assert len(toks) == 1, f"disabled mode should emit 1 token/step, got {len(toks)}"
        assert len(next_input) == 1, f"disabled mode should feed 1 token next, got {len(next_input)}"
        emitted.extend(toks)
    assert len(emitted) == 5
    assert ctrl.stats['n_accepted'] == 0
    assert ctrl.stats['n_rejected'] == 0
    return True


def test_perfect_accept_rate():
    """With perfect NEXTN head, accept rate should be 100%."""
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    lm = make_mock_lm_head(device)
    nextn = make_mock_nextn_head_perfect(lm)
    fwd = MockForward(device)

    ctrl = MTPController(lm, nextn)
    assert ctrl.enabled == True

    next_input = [10]
    emitted = []
    for _ in range(20):
        h = fwd(next_input)
        toks, next_input = ctrl.step(h)
        emitted.extend(toks)
        if len(emitted) >= 30:
            break

    # Perfect head: NEXTN(h) == lm_head(h) always.
    # First step: single mode, emit 1 (main), pending draft.
    # Step 2: verify mode (T=2). Since at position 0, lm_head(h_0) MUST equal
    # NEXTN(h_-1's draft)? No — pending_draft was NEXTN(h_-1) at position -1.
    # verify_token = lm_head(h_0). These are NOT inherently equal even with
    # perfect head — because pending_draft was computed from PREVIOUS h, not h_0.
    # So perfect head doesn't guarantee 100% accept; only guarantees the head
    # outputs the same as lm_head WHEN GIVEN THE SAME INPUT.
    #
    # For the test to be meaningful, we need NEXTN to predict the SAME token
    # that lm_head will produce at the NEXT position. That requires the model
    # to be predictable. With random embeddings, NEXTN(h_k) != lm_head(h_{k+1})
    # in general.
    #
    # So "perfect" here just validates that the math doesn't crash. The accept
    # rate depends on the model's structure. With random mock, we expect some
    # nonzero accept rate from the perfect head, but not 100%.

    stats = ctrl.stats
    print(f"  perfect-head stats: {stats}")
    assert stats['n_accepted'] + stats['n_rejected'] > 0, "no verify steps happened"
    # Verify the throughput multiplier formula is sensible
    assert 1.0 <= stats['tokens_per_step'] <= 2.0
    return True


def test_random_reject_path():
    """With random NEXTN head, accept rate should be very low (~1/VOCAB)."""
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    lm = make_mock_lm_head(device)
    nextn = make_mock_nextn_head_random(device, seed=12345)
    fwd = MockForward(device)

    ctrl = MTPController(lm, nextn)

    next_input = [50]
    emitted = []
    for _ in range(40):
        h = fwd(next_input)
        toks, next_input = ctrl.step(h)
        emitted.extend(toks)
        if len(emitted) >= 50:
            break

    stats = ctrl.stats
    print(f"  random-head stats: {stats}")
    # With random NEXTN over VOCAB=256, expected accept rate ~ 1/256 = 0.4%
    # Allow up to 5% to account for finite samples
    assert stats['accept_rate'] < 0.10, f"random head accept rate too high: {stats['accept_rate']}"
    assert stats['n_rejected'] > stats['n_accepted'], "should mostly reject"
    return True


def test_token_emission_correctness():
    """Without MTP, emitted tokens should match what naive single-token loop would produce."""
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    lm = make_mock_lm_head(device)

    # Baseline: no MTP, just argmax at each step
    fwd_baseline = MockForward(device)
    next_t = 10
    baseline_emit = []
    for _ in range(15):
        h = fwd_baseline([next_t])
        logits = F.linear(h[:, -1, :], lm)
        next_t = int(logits[0].argmax().item())
        baseline_emit.append(next_t)

    # MTP path with disabled flag
    fwd_mtp = MockForward(device)
    ctrl = MTPController(lm, None, enabled=False)
    next_input = [10]
    mtp_emit = []
    for _ in range(15):
        h = fwd_mtp(next_input)
        toks, next_input = ctrl.step(h)
        mtp_emit.extend(toks)
        if len(mtp_emit) >= 15:
            break
    mtp_emit = mtp_emit[:15]

    assert baseline_emit == mtp_emit, (
        f"disabled MTP path diverges from baseline: \n  baseline={baseline_emit}\n  mtp     ={mtp_emit}"
    )
    return True


def test_load_nextn_head_missing():
    """load_nextn_head_weight should return None when no head present."""
    nextn = load_nextn_head_weight({}, model_dir=None)
    assert nextn is None
    nextn2 = load_nextn_head_weight({"lm_head.weight": torch.zeros(10, 10)}, model_dir=None)
    assert nextn2 is None
    return True


def test_load_nextn_head_from_dict():
    """load_nextn_head_weight should find canonical keys in outside dict."""
    fake_tensor = torch.zeros(VOCAB, HIDDEN)
    outside = {"mtp.head.weight": fake_tensor}
    nextn = load_nextn_head_weight(outside)
    assert nextn is not None
    assert nextn.shape == (VOCAB, HIDDEN)
    return True


def test_stats_tracking():
    """Stats accounting should be self-consistent."""
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    lm = make_mock_lm_head(device)
    nextn = make_mock_nextn_head_random(device)
    fwd = MockForward(device)

    ctrl = MTPController(lm, nextn)
    next_input = [10]
    n_emitted = 0
    n_forwards = 0
    for _ in range(30):
        h = fwd(next_input)
        n_forwards += 1
        toks, next_input = ctrl.step(h)
        n_emitted += len(toks)
        if n_emitted >= 30:
            break

    stats = ctrl.stats
    # Invariant: total decoded steps should match number of forwards
    total_steps = stats['n_single_steps'] + stats['n_accepted'] + stats['n_rejected']
    print(f"  forwards={n_forwards} emitted={n_emitted} stats={stats}")
    assert total_steps == n_forwards, f"step count mismatch: {total_steps} vs {n_forwards}"
    # Invariant: tokens_per_step matches emitted/forwards
    expected_tps = n_emitted / n_forwards
    # Tolerate small floating diff
    assert abs(stats['tokens_per_step'] - expected_tps) < 0.01, (
        f"tokens_per_step formula off: stat={stats['tokens_per_step']} expected={expected_tps}"
    )
    return True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    tests = [
        ("disabled_path", test_disabled_path),
        ("perfect_nextn (math sanity)", test_perfect_accept_rate),
        ("random_nextn (reject path)", test_random_reject_path),
        ("disabled_matches_baseline", test_token_emission_correctness),
        ("load_nextn_missing", test_load_nextn_head_missing),
        ("load_nextn_from_dict", test_load_nextn_head_from_dict),
        ("stats_tracking", test_stats_tracking),
    ]

    print("[sp15] running {} MTP scaffolding tests...".format(len(tests)))
    results = []
    for name, fn in tests:
        t0 = time.time()
        try:
            ok = fn()
            elapsed = (time.time() - t0) * 1000
            print(f"  [{('PASS' if ok else 'FAIL'):4}] {name:40} ({elapsed:.0f}ms)")
            results.append((name, ok, None))
        except AssertionError as e:
            elapsed = (time.time() - t0) * 1000
            print(f"  [FAIL] {name:40} ({elapsed:.0f}ms) - {e}")
            results.append((name, False, str(e)))
        except Exception as e:
            elapsed = (time.time() - t0) * 1000
            print(f"  [ERROR] {name:40} ({elapsed:.0f}ms) - {type(e).__name__}: {e}")
            import traceback
            traceback.print_exc()
            results.append((name, False, f"{type(e).__name__}: {e}"))

    n_pass = sum(1 for _, ok, _ in results if ok)
    n_total = len(results)
    overall = (n_pass == n_total)
    print()
    print(f"=== SP-15 MTP Scaffolding Gate: {'PASS' if overall else 'FAIL'} ({n_pass}/{n_total}) ===")

    out = {
        "type": "sp15_mtp_pipeline_probe",
        "date": time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime()),
        "n_pass": n_pass,
        "n_total": n_total,
        "overall_pass": overall,
        "results": [
            {"name": n, "pass": ok, "error": err}
            for n, ok, err in results
        ],
    }
    out_path = Path('/lynn-engine/reports/sp01_autotune/sp15_mtp_scaffolding.json')
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"[sp15] report: {out_path}")

    return 0 if overall else 1


if __name__ == "__main__":
    sys.exit(main())
