"""Lynn engine MTP-aware incremental generation — wiring stub.

This is the integration point for `engine/mtp.py` MTPController + the
existing decode loop in `engine/full_forward.py:generate_incremental`.

STATUS (2026-05-16):
  - Module is wired but NOT runnable end-to-end yet, because:
    1. A100-trained NEXTN head not delivered (load step will return None)
    2. _decode_layer extension to T=2 not implemented (we use prefill path
       for verify-step as a correct-but-slower fallback)
  - When A100 ships NEXTN head AND production has restart window for
    real-model test, this file becomes the entry point.

NOT imported by production. Server still uses generate_incremental from
full_forward.py until this is verified end-to-end.

Usage:
    from engine.generate_mtp import generate_incremental_mtp
    output_text, ids, stats = generate_incremental_mtp(
        model_dir="/models/lynn-27b-...",
        prompt="...",
        max_new=128,
        mtp_enabled=True,
    )
"""
from __future__ import annotations

import time
from pathlib import Path
import json
from typing import Optional

import torch
import torch.nn.functional as F

from engine.mtp import MTPController, load_nextn_head_weight
from engine.full_forward import (
    _with_inferred_layer_config,
    _prefill_layer,
    _decode_layer,
    _rms_norm,
    load_outside_weights,
)
from engine.loader import load_qwen36_layer
from engine.inference_state import LynnInferenceState, LAYER_TYPES


def _two_token_forward_via_prefill(
    input_ids_2tok: list[int],
    h_prev_state_position: int,
    layer_weights: list,
    layer_cfgs: list,
    outside: dict,
    state: LynnInferenceState,
    embed_weight: torch.Tensor,
    norm_weight: torch.Tensor,
    n_layers: int,
    device: torch.device,
) -> torch.Tensor:
    """Fallback 2-token forward using prefill path.

    For MTP verify step we need to forward 2 tokens together.  The fast path
    would be to extend _decode_layer to T=2, but that's a larger refactor.
    For correctness-first scaffolding, we use _prefill_layer which handles
    arbitrary sequence lengths.

    NOTE: this advances state.seq_len by 2 (state must be in valid
    pre-verify position).
    """
    # Build embedding for 2 tokens
    new_tokens = torch.tensor(input_ids_2tok, device=device, dtype=torch.long).unsqueeze(0)
    h = F.embedding(new_tokens, embed_weight)
    # Position ids for the 2 new tokens
    pos = torch.tensor(
        [h_prev_state_position, h_prev_state_position + 1],
        device=device, dtype=torch.long,
    ).unsqueeze(0)
    # Forward through layers using prefill path (handles T=2)
    for i in range(n_layers):
        h = _prefill_layer(h, pos, LAYER_TYPES[i], layer_weights[i], layer_cfgs[i], state, i)
    state.seq_len += 2
    h_final = _rms_norm(h, norm_weight)
    return h_final  # [1, 2, H]


def _single_token_forward(
    input_id: int,
    layer_weights: list,
    layer_cfgs: list,
    outside: dict,
    state: LynnInferenceState,
    embed_weight: torch.Tensor,
    norm_weight: torch.Tensor,
    n_layers: int,
    device: torch.device,
) -> torch.Tensor:
    """Single-token decode forward (same as production generate_incremental loop)."""
    new_tok = torch.tensor([[input_id]], device=device, dtype=torch.long)
    h = F.embedding(new_tok, embed_weight)
    pos = state.seq_len
    for i in range(n_layers):
        h = _decode_layer(h, pos, LAYER_TYPES[i], layer_weights[i], layer_cfgs[i], state, i)
    state.seq_len += 1
    h_final = _rms_norm(h, norm_weight)
    return h_final  # [1, 1, H]


def generate_incremental_mtp(
    model_dir: str,
    prompt: str,
    max_new: int = 64,
    device: str = "cuda",
    dtype=torch.bfloat16,
    verbose: bool = True,
    max_seq_len: int = 4096,
    mtp_enabled: bool = True,
) -> tuple[str, list[int], dict]:
    """MTP-aware incremental decode. Returns (full_text, new_token_ids, stats)."""

    with open(Path(model_dir) / "config.json") as f:
        full_cfg = json.load(f)
    tc = full_cfg["text_config"]
    rope_p = tc.get("rope_parameters", {})
    cfg = {
        "hidden_size": tc["hidden_size"],
        "num_attention_heads": tc["num_attention_heads"],
        "num_key_value_heads": tc["num_key_value_heads"],
        "head_dim": tc["head_dim"],
        "num_experts": tc["num_experts"],
        "num_experts_per_tok": tc["num_experts_per_tok"],
        "rope_theta": rope_p.get("rope_theta", tc.get("rope_theta", 1e6)),
        "partial_rotary_factor": rope_p.get("partial_rotary_factor", 1.0),
    }
    n_layers = tc["num_hidden_layers"]
    assert LAYER_TYPES == tc["layer_types"], "layer_types config mismatch"

    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(model_dir)
    ids = tok(prompt, return_tensors="pt").input_ids.to(device)
    T_prefill = ids.shape[1]
    eos_token = tc.get("eos_token_id", None)

    if verbose:
        print(f"prompt: {prompt!r}, T={T_prefill}, max_new={max_new}", flush=True)

    # Load outside weights + per-layer
    outside = load_outside_weights(model_dir, device, dtype)
    layer_weights = []
    layer_cfgs = []
    for i in range(n_layers):
        w, inferred = load_qwen36_layer(model_dir, i, num_experts=cfg["num_experts"],
                                        device=device, dequant_dtype=dtype)
        layer_weights.append(w)
        layer_cfgs.append(_with_inferred_layer_config(cfg, inferred))

    # MTP head — may be None
    nextn_head = load_nextn_head_weight(outside, model_dir, device=torch.device(device))
    if verbose:
        if nextn_head is None:
            print("MTP head: NOT FOUND — falling back to single-token mode", flush=True)
        else:
            print(f"MTP head: loaded shape={tuple(nextn_head.shape)} dtype={nextn_head.dtype}",
                  flush=True)

    lm_head = outside["lm_head.weight"]
    norm_weight = outside["model.language_model.norm.weight"]
    embed_weight = outside["model.language_model.embed_tokens.weight"]

    # State + prefill (standard)
    state = LynnInferenceState(batch=1, max_seq_len=max_seq_len, device=device, dtype=dtype)
    h = F.embedding(ids, embed_weight)
    pos = torch.arange(T_prefill, device=device, dtype=torch.long).unsqueeze(0)
    for i in range(n_layers):
        h = _prefill_layer(h, pos, LAYER_TYPES[i], layer_weights[i], layer_cfgs[i], state, i)
    state.seq_len = T_prefill

    # Sample first token from prefill's last position via lm_head
    h_final = _rms_norm(h, norm_weight)
    first_logits = F.linear(h_final[:, -1, :], lm_head)
    first_tok = int(first_logits[0].argmax().item())

    # === MTP-aware decode loop ===
    ctrl = MTPController(lm_head, nextn_head, enabled=mtp_enabled)
    new_ids: list[int] = [first_tok]
    next_input = [first_tok]
    t_decode_start = time.time()
    n_forwards = 0

    while len(new_ids) < max_new:
        # Decide forward shape: 1-token or 2-token based on input length
        if len(next_input) == 1:
            h_final = _single_token_forward(
                next_input[0], layer_weights, layer_cfgs, outside, state,
                embed_weight, norm_weight, n_layers, device,
            )
        elif len(next_input) == 2:
            # Verify-mode: 2-token forward via prefill fallback path
            # state.seq_len is currently pointing at position where main_prev will land.
            h_final = _two_token_forward_via_prefill(
                next_input,
                h_prev_state_position=state.seq_len,
                layer_weights=layer_weights, layer_cfgs=layer_cfgs,
                outside=outside, state=state,
                embed_weight=embed_weight, norm_weight=norm_weight,
                n_layers=n_layers, device=device,
            )
        else:
            raise ValueError(f"unexpected next_input length {len(next_input)}")
        n_forwards += 1
        if device.startswith("cuda"):
            torch.cuda.synchronize()

        tokens_emit, next_input = ctrl.step(h_final)
        for tok in tokens_emit:
            new_ids.append(tok)
            if eos_token is not None and tok == eos_token:
                break
            if len(new_ids) >= max_new:
                break
        if eos_token is not None and new_ids[-1] == eos_token:
            break

    decode_time = time.time() - t_decode_start
    stats = ctrl.stats
    stats["n_new_tokens"] = len(new_ids)
    stats["n_forwards"] = n_forwards
    stats["decode_time_s"] = decode_time
    stats["tps_observed"] = (len(new_ids) - 1) / decode_time if decode_time > 0 else float('inf')
    if verbose:
        print(f"\n=== MTP decode stats ===", flush=True)
        for k, v in stats.items():
            print(f"  {k}: {v}", flush=True)

    full_ids = ids[0].tolist() + new_ids
    full_text = tok.decode(full_ids)
    return full_text, new_ids, stats


__all__ = ["generate_incremental_mtp"]
