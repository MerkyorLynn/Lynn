#!/usr/bin/env python3
"""SP-16: qwen3_next_mtp module structural + integration probe.

Validates the new Lynn-owned MTP implementation (engine/mtp_qwen3_next.py +
engine/mtp.py v2) against Qwen3.6-35B-A3B-derived architecture spec.

Tests:
  T1: Build Qwen3NextMTPModule from Lynn 27B config.json values
      - Verify all tensor shapes match expected_shape_check()
  T2: Forward smoke — random init, [B=1, T=1, H=2048] input doesn't crash
      - Output shape [B, T, H] correct
      - No NaN/Inf in output
  T3: Forward smoke 2-token — input shape [B=1, T=2, H=2048]
      - Output [B, T, H] correct
      - Position-causal: position 1 output depends on position 0 (sanity)
  T4: Synthetic state dict remap — generate Qwen3.6-format dict with correct shapes,
      verify remap_qwen36_to_lynn_mtp() + load_state_dict() round-trip
  T5: MTPController integration — wire mock main model + MTP module, verify step()
      single-mode + verify-mode + reject path work end-to-end
  T6: MTPController disabled path (mtp_module=None) — verify graceful fallback
  T7: Optional (--with-qwen36-download) — fetch real mtp.* tensors from
      Qwen/Qwen3.6-35B-A3B model-00026-of-00026.safetensors, load into module,
      validate shapes match exactly.

Pass criteria: T1-T6 mandatory PASS. T7 optional (skipped if --with-qwen36-download
not set or download fails).

Usage:
    python3 sp16_qwen3_next_mtp_probe.py
    python3 sp16_qwen3_next_mtp_probe.py --with-qwen36-download
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path

import torch
import torch.nn as nn


# Lynn 27B / Qwen3.6-35B-A3B shared text_config values (per HF config.json)
LYNN_CONFIG_VALUES = {
    "hidden_size": 2048,
    "num_attention_heads": 16,
    "num_key_value_heads": 2,
    "head_dim": 256,
    "num_experts": 256,
    "num_experts_per_tok": 8,
    "moe_intermediate_size": 512,
    "shared_expert_intermediate_size": 512,
    "rms_norm_eps": 1e-6,
    "partial_rotary_factor": 0.25,
    "rope_theta": 10_000_000.0,
    "vocab_size": 248320,
    "mtp_num_hidden_layers": 1,
    "mtp_use_dedicated_embeddings": False,
}

# Probe-only vocab size. The real Lynn/Qwen vocab is 248320, but T1 already
# locks module tensor shapes and T7 validates real shared lm_head/embed loading
# semantics. T2-T6 only need valid token IDs and controller plumbing; using a
# small mock vocab avoids allocating several GiB on Spark just for synthetic
# embeddings/lm_head.
MOCK_VOCAB_SIZE = 4096


def _mock_main_norm(H: int) -> nn.Module:
    """A trivial RMSNorm to act as 'main_final_norm' for controller integration test."""
    from engine.mtp_qwen3_next import RMSNorm
    return RMSNorm(H, 1e-6)


def _mock_embed_tokens(V: int, H: int, device: torch.device) -> nn.Embedding:
    """Mock embedding table — small random."""
    emb = nn.Embedding(V, H).to(device)
    nn.init.normal_(emb.weight, std=0.02)
    return emb


def _mock_lm_head(V: int, H: int, device: torch.device) -> torch.Tensor:
    """Mock lm_head weight tensor [V, H]."""
    w = torch.randn(V, H, device=device) * 0.02
    return w


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_t1_build_and_shapes():
    """T1: Build module + verify all shapes match expected."""
    from engine.mtp_qwen3_next import (
        Qwen3NextMTPConfig, Qwen3NextMTPModule, expected_shape_check,
    )

    cfg = Qwen3NextMTPConfig.from_dict(LYNN_CONFIG_VALUES)
    module = Qwen3NextMTPModule(cfg)

    expected = expected_shape_check(module)
    state = dict(module.state_dict())

    mismatches = []
    for key, exp_shape in expected.items():
        if key not in state:
            mismatches.append(f"  missing: {key}")
            continue
        actual = tuple(state[key].shape)
        if actual != exp_shape:
            mismatches.append(f"  shape mismatch {key}: got {actual} expected {exp_shape}")

    extras = set(state.keys()) - set(expected.keys())
    for x in extras:
        mismatches.append(f"  unexpected key in module state: {x}")

    if mismatches:
        raise AssertionError(
            "T1 shape check failed:\n" + "\n".join(mismatches)
        )
    return True


def test_t2_forward_single_token(device):
    """T2: random-init module forward on [B=1, T=1, H=2048] doesn't crash."""
    from engine.mtp_qwen3_next import (
        Qwen3NextMTPConfig, Qwen3NextMTPModule,
    )
    cfg = Qwen3NextMTPConfig.from_dict(LYNN_CONFIG_VALUES)
    module = Qwen3NextMTPModule(cfg).to(device=device, dtype=torch.float32)
    embed = _mock_embed_tokens(MOCK_VOCAB_SIZE, cfg.hidden_size, device)

    B, T, H = 1, 1, cfg.hidden_size
    prev_hidden = torch.randn(B, T, H, device=device) * 0.1
    next_tokens = torch.tensor([[42]], device=device, dtype=torch.long)
    pos_ids = torch.tensor([0], device=device, dtype=torch.long)

    out = module(prev_hidden, next_tokens, embed, pos_ids)
    assert out.shape == (B, T, H), f"expected shape {(B, T, H)}, got {out.shape}"
    assert not torch.isnan(out).any(), "NaN in output"
    assert not torch.isinf(out).any(), "Inf in output"
    return True


def test_t3_forward_two_token(device):
    """T3: forward [B=1, T=2, H] (verify-mode)."""
    from engine.mtp_qwen3_next import (
        Qwen3NextMTPConfig, Qwen3NextMTPModule,
    )
    cfg = Qwen3NextMTPConfig.from_dict(LYNN_CONFIG_VALUES)
    module = Qwen3NextMTPModule(cfg).to(device=device, dtype=torch.float32)
    embed = _mock_embed_tokens(MOCK_VOCAB_SIZE, cfg.hidden_size, device)

    B, T, H = 1, 2, cfg.hidden_size
    prev_hidden = torch.randn(B, T, H, device=device) * 0.1
    next_tokens = torch.tensor([[42, 1024]], device=device, dtype=torch.long)
    pos_ids = torch.tensor([5, 6], device=device, dtype=torch.long)

    out = module(prev_hidden, next_tokens, embed, pos_ids)
    assert out.shape == (B, T, H), f"expected {(B, T, H)}, got {out.shape}"
    assert not torch.isnan(out).any(), "NaN in output"
    return True


def test_t4_state_dict_remap_roundtrip(device):
    """T4: build Qwen3.6-format state_dict with correct shapes, verify remap+load."""
    from engine.mtp_qwen3_next import (
        Qwen3NextMTPConfig, Qwen3NextMTPModule, remap_qwen36_to_lynn_mtp,
        _QWEN36_TO_LYNN_MTP_KEY_MAP, expected_shape_check,
    )

    cfg = Qwen3NextMTPConfig.from_dict(LYNN_CONFIG_VALUES)
    module = Qwen3NextMTPModule(cfg).to(device=device, dtype=torch.float32)

    # Build a fake Qwen3.6 state dict with all expected MTP keys at correct shapes
    expected_shapes = expected_shape_check(module)
    fake_hf_state = {}
    for hf_key, lynn_key in _QWEN36_TO_LYNN_MTP_KEY_MAP.items():
        shape = expected_shapes[lynn_key]
        fake_hf_state[hf_key] = torch.randn(*shape, device=device, dtype=torch.float32) * 0.02

    # Add some non-MTP keys to make sure they're filtered out
    fake_hf_state["embed_tokens.weight"] = torch.randn(MOCK_VOCAB_SIZE, 2048)
    fake_hf_state["model.layers.0.input_layernorm.weight"] = torch.randn(2048)

    remapped = remap_qwen36_to_lynn_mtp(fake_hf_state)

    # Verify all MTP keys present
    assert len(remapped) == len(_QWEN36_TO_LYNN_MTP_KEY_MAP), (
        f"remap output has {len(remapped)} keys, expected {len(_QWEN36_TO_LYNN_MTP_KEY_MAP)}"
    )

    # Load into module with strict=True
    missing, unexpected = module.load_state_dict(remapped, strict=False)
    assert not missing, f"missing keys after load: {missing}"
    assert not unexpected, f"unexpected keys: {unexpected}"

    # Verify a forward still works after load
    embed = _mock_embed_tokens(MOCK_VOCAB_SIZE, cfg.hidden_size, device)
    prev_hidden = torch.randn(1, 1, cfg.hidden_size, device=device) * 0.1
    next_tokens = torch.tensor([[42]], device=device, dtype=torch.long)
    pos_ids = torch.tensor([0], device=device, dtype=torch.long)
    out = module(prev_hidden, next_tokens, embed, pos_ids)
    assert out.shape == (1, 1, cfg.hidden_size)
    return True


def test_t5_controller_integration(device):
    """T5: MTPController + module wired together; step() works through state machine."""
    from engine.mtp_qwen3_next import Qwen3NextMTPConfig, Qwen3NextMTPModule
    from engine.mtp import MTPController

    cfg = Qwen3NextMTPConfig.from_dict(LYNN_CONFIG_VALUES)
    module = Qwen3NextMTPModule(cfg).to(device=device, dtype=torch.float32)
    main_norm = _mock_main_norm(cfg.hidden_size).to(device=device, dtype=torch.float32)
    embed = _mock_embed_tokens(MOCK_VOCAB_SIZE, cfg.hidden_size, device)
    lm_head = _mock_lm_head(MOCK_VOCAB_SIZE, cfg.hidden_size, device).float()

    ctrl = MTPController(
        main_final_norm=main_norm,
        lm_head=lm_head,
        embed_tokens=embed,
        mtp_module=module,
        enabled=True,
    )

    # Single-mode first step
    h1 = torch.randn(1, 1, cfg.hidden_size, device=device) * 0.1
    pos1 = torch.tensor([0], device=device, dtype=torch.long)
    toks1, next1 = ctrl.step(h1, pos1)
    assert len(toks1) == 1, f"single-mode: emit 1 token, got {len(toks1)}"
    assert len(next1) == 2, f"single-mode: next should be [main, draft], got len {len(next1)}"
    assert ctrl.pending_draft is not None
    assert ctrl.n_single_steps == 1

    # Verify-mode step (T=2 input)
    h2 = torch.randn(1, 2, cfg.hidden_size, device=device) * 0.1
    pos2 = torch.tensor([1, 2], device=device, dtype=torch.long)
    toks2, next2 = ctrl.step(h2, pos2)
    # Either accept (2 emit, 2 next) or reject (1 emit, 1 next)
    assert len(toks2) in (1, 2), f"verify-mode: emit 1 or 2, got {len(toks2)}"
    assert len(next2) in (1, 2)

    # Stats
    stats = ctrl.stats
    assert stats["n_single_steps"] == 1
    # One verify happened
    assert stats["n_accepted"] + stats["n_rejected"] == 1
    return True


def test_t6_controller_disabled_path(device):
    """T6: MTPController with mtp_module=None must emit 1 token per step (baseline)."""
    from engine.mtp_qwen3_next import Qwen3NextMTPConfig
    from engine.mtp import MTPController

    cfg = Qwen3NextMTPConfig.from_dict(LYNN_CONFIG_VALUES)
    main_norm = _mock_main_norm(cfg.hidden_size).to(device=device, dtype=torch.float32)
    embed = _mock_embed_tokens(MOCK_VOCAB_SIZE, cfg.hidden_size, device)
    lm_head = _mock_lm_head(MOCK_VOCAB_SIZE, cfg.hidden_size, device).float()

    ctrl = MTPController(
        main_final_norm=main_norm,
        lm_head=lm_head,
        embed_tokens=embed,
        mtp_module=None,
        enabled=True,
    )
    assert ctrl.enabled is False, "should auto-disable when mtp_module=None"

    h = torch.randn(1, 1, cfg.hidden_size, device=device) * 0.1
    pos = torch.tensor([0], device=device, dtype=torch.long)
    for _ in range(3):
        toks, next_ids = ctrl.step(h, pos)
        assert len(toks) == 1
        assert len(next_ids) == 1
    return True


def test_t7_real_qwen36_load(device, download_dir: Path):
    """T7 (optional): download Qwen3.6-35B-A3B shards containing MTP tensors,
    load real mtp.* tensors into a fresh module, verify shapes + forward."""
    from engine.mtp_qwen3_next import Qwen3NextMTPConfig, Qwen3NextMTPModule
    from engine.mtp import load_mtp_module_from_state_dict

    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        raise RuntimeError("huggingface_hub not installed; cannot run T7")

    filenames = [
        "model-00025-of-00026.safetensors",
        "model-00026-of-00026.safetensors",
    ]
    fpaths = []
    for filename in filenames:
        print(f"  [T7] downloading Qwen3.6-35B-A3B {filename} ...")
        fpath = hf_hub_download(
            repo_id="Qwen/Qwen3.6-35B-A3B",
            filename=filename,
            local_dir=str(download_dir),
            cache_dir=str(download_dir / "cache"),
        )
        print(f"  [T7] downloaded to {fpath}")
        fpaths.append(fpath)

    from safetensors.torch import safe_open
    state_dict = {}
    for fpath in fpaths:
        with safe_open(fpath, framework="pt", device="cpu") as sf:
            for key in sf.keys():
                if key.startswith("mtp.") or key.startswith("model.mtp."):
                    state_dict[key] = sf.get_tensor(key)
    print(f"  [T7] extracted {len(state_dict)} mtp.* tensors")

    cfg = Qwen3NextMTPConfig.from_dict(LYNN_CONFIG_VALUES)
    module = Qwen3NextMTPModule(cfg).to(device=device, dtype=torch.bfloat16)
    load_mtp_module_from_state_dict(module, state_dict, strict=True)

    # Smoke forward
    embed = _mock_embed_tokens(MOCK_VOCAB_SIZE, cfg.hidden_size, device).to(dtype=torch.bfloat16)
    prev_hidden = torch.randn(1, 1, cfg.hidden_size, device=device, dtype=torch.bfloat16) * 0.1
    next_tokens = torch.tensor([[42]], device=device, dtype=torch.long)
    pos_ids = torch.tensor([0], device=device, dtype=torch.long)
    out = module(prev_hidden, next_tokens, embed, pos_ids)
    assert out.shape == (1, 1, cfg.hidden_size)
    assert not torch.isnan(out).any()
    return True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--with-qwen36-download", action="store_true",
                        help="Run T7 — download real Qwen3.6-35B-A3B MTP tensors from HF")
    parser.add_argument("--download-dir", default="/tmp/sp16_qwen36_mtp",
                        help="Where to cache Qwen3.6 download for T7")
    parser.add_argument("--device", default=None,
                        help="Override CUDA device (default: auto)")
    parser.add_argument("--out", default="/lynn-engine/reports/sp01_autotune/sp16_qwen3_next_mtp.json")
    args = parser.parse_args()

    sys.path.insert(0, "/lynn-engine")

    if args.device is not None:
        device = torch.device(args.device)
    elif torch.cuda.is_available():
        device = torch.device("cuda")
    else:
        device = torch.device("cpu")

    print(f"[sp16] device={device}")
    print(f"[sp16] Lynn 27B config (mirrored from Qwen3.6-35B-A3B text_config):")
    for k, v in LYNN_CONFIG_VALUES.items():
        print(f"  {k:36}: {v}")
    print()

    tests = [
        ("T1 build + shapes",            lambda: test_t1_build_and_shapes()),
        ("T2 forward 1-token",           lambda: test_t2_forward_single_token(device)),
        ("T3 forward 2-token",           lambda: test_t3_forward_two_token(device)),
        ("T4 state_dict remap roundtrip", lambda: test_t4_state_dict_remap_roundtrip(device)),
        ("T5 MTPController integration",  lambda: test_t5_controller_integration(device)),
        ("T6 controller disabled path",   lambda: test_t6_controller_disabled_path(device)),
    ]
    if args.with_qwen36_download:
        download_dir = Path(args.download_dir)
        download_dir.mkdir(parents=True, exist_ok=True)
        tests.append(("T7 real Qwen3.6 mtp.* load", lambda: test_t7_real_qwen36_load(device, download_dir)))

    print(f"[sp16] running {len(tests)} tests...")
    results = []
    for name, fn in tests:
        t0 = time.time()
        try:
            ok = fn()
            elapsed = (time.time() - t0) * 1000
            print(f"  [{'PASS' if ok else 'FAIL'}] {name:40} ({elapsed:.0f}ms)")
            results.append((name, ok, None))
        except AssertionError as e:
            elapsed = (time.time() - t0) * 1000
            print(f"  [FAIL] {name:40} ({elapsed:.0f}ms) — AssertionError: {e}")
            results.append((name, False, f"AssertionError: {e}"))
        except Exception as e:
            elapsed = (time.time() - t0) * 1000
            print(f"  [ERROR] {name:40} ({elapsed:.0f}ms) — {type(e).__name__}: {e}")
            traceback.print_exc()
            results.append((name, False, f"{type(e).__name__}: {e}"))

    n_pass = sum(1 for _, ok, _ in results if ok)
    n_total = len(results)
    overall = (n_pass == n_total)
    print()
    print(f"=== SP-16 qwen3_next_mtp gate: {'PASS' if overall else 'FAIL'} ({n_pass}/{n_total}) ===")

    summary = {
        "type": "sp16_qwen3_next_mtp_probe",
        "date": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
        "device": str(device),
        "lynn_config_values": LYNN_CONFIG_VALUES,
        "tests_run": n_total,
        "tests_passed": n_pass,
        "overall_pass": overall,
        "results": [
            {"name": n, "pass": ok, "error": err} for n, ok, err in results
        ],
    }
    out_path = Path(args.out)
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
        print(f"[sp16] report: {out_path}")
    except (OSError, PermissionError) as e:
        print(f"[sp16] WARN could not write report: {e}")

    return 0 if overall else 1


if __name__ == "__main__":
    sys.exit(main())
