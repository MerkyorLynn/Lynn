"""Lynn MTP runtime — qwen3_next_mtp-compatible controller.

REVISION 2 (2026-05-16): Refactored from SP-15 v1 to match actual Qwen3.6-35B-A3B
MTP architecture. SP-15 v1 incorrectly assumed a single Linear NEXTN head (Medusa
style). Real qwen3_next_mtp uses a full transformer block + FC combiner + shared
embed/lm_head. v2 wires `engine.mtp_qwen3_next.Qwen3NextMTPModule` for the actual
prediction.

State machine (unchanged from v1, only `_predict_next_pair` implementation differs):
  Single-mode forward:   input [t_k]              → emit [main]              → next [main, draft]
  Verify-mode forward:   input [main, draft]      → accept: emit [draft, new_main]
                                                  → reject: emit [verify]   → back to single

The controller is forward-agnostic — caller runs the model forward and supplies
`prev_hidden` (pre-final-norm hidden state at predicted positions). Controller owns:
  - dual-head computation: main_lm_head(final_norm(prev_hidden)) + MTP_module(prev_hidden, t)
  - acceptance decision (greedy: verify_token == pending_draft)
  - pending_draft state across steps
  - stats (n_accepted / n_rejected / accept_rate / tokens_per_step)

Lynn-engine integration via `engine.generate_mtp` — production server stays on
`engine.full_forward.generate_incremental` (single-stream non-MTP) until validated.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F


# Convention: order matters. Earlier names win if multiple present.
# (Used for cases where MTP module is delivered as a state_dict; the prefix differs
# across A100 training pipelines. Loader strips the prefix before passing to module.)
NEXTN_HEAD_KEY_PREFIXES = [
    "mtp.",                       # Qwen3.6-35B-A3B canonical (per safetensors index)
    "model.mtp.",
    "mtp_predict_layers.0.",      # Deepseek-V3 style
    "model.mtp_predict_layers.0.",
]


def detect_mtp_head_in_state_dict(state_dict: dict) -> Optional[str]:
    """Return the matching prefix if any NEXTN tensors are present, else None."""
    for prefix in NEXTN_HEAD_KEY_PREFIXES:
        for key in state_dict.keys():
            if key.startswith(prefix):
                return prefix
    return None


class MTPController:
    """State machine for 1-token-lookahead qwen3_next_mtp speculative decoding.

    The controller is forward-agnostic: caller supplies hidden states (pre-final-norm)
    and the controller computes main + MTP logits using the supplied modules.

    Wire-up (caller's responsibility):
        ctrl = MTPController(
            main_final_norm=outside_model_norm,  # nn.Module (main body's final RMSNorm)
            lm_head=outside_lm_head_weight,       # tensor [V, H] (shared between main + MTP)
            embed_tokens=outside_embed_tokens,    # nn.Embedding (shared)
            mtp_module=lynn_mtp_module,           # Qwen3NextMTPModule, or None to disable
        )

    Then in the decode loop:
        h_prefinal = run_forward(input_ids)       # [B, T, H] pre-main-final-norm
        position_ids = ...                         # [T] absolute positions for RoPE
        tokens_emit, next_input_ids = ctrl.step(h_prefinal, position_ids)

    For non-MTP fallback (`mtp_module is None`), the controller emits 1 token per step
    using only the main lm_head, behaving identically to a baseline greedy loop.
    """

    def __init__(
        self,
        main_final_norm: nn.Module,
        lm_head: torch.Tensor,
        embed_tokens: nn.Embedding,
        mtp_module: Optional[nn.Module] = None,
        enabled: bool = True,
    ):
        self.main_final_norm = main_final_norm
        self.lm_head = lm_head
        self.embed_tokens = embed_tokens
        self.mtp_module = mtp_module
        self.enabled = enabled and (mtp_module is not None)

        # State
        self.pending_draft: Optional[int] = None
        # Stats
        self.n_accepted = 0
        self.n_rejected = 0
        self.n_single_steps = 0

    # ---------------- internal heads ----------------

    def _main_predict(self, h_prefinal_pos: torch.Tensor) -> int:
        """Main lm_head greedy prediction from a single position.

        h_prefinal_pos: [B, H] pre-final-norm hidden at one position.
        Returns: int — predicted next token id.
        """
        h_final = self.main_final_norm(h_prefinal_pos)
        logits = F.linear(h_final, self.lm_head)
        return int(logits[0].argmax().item())

    def _mtp_predict(
        self,
        h_prefinal_pos: torch.Tensor,
        next_token_id: int,
        position_id: torch.Tensor,
    ) -> int:
        """MTP draft prediction.

        Runs MTP module: takes raw pre-final-norm hidden + next token's embedding,
        produces MTP hidden which is then sent through shared lm_head (NOT through
        main_final_norm — MTP module has its own internal norm).

        h_prefinal_pos: [B, H]
        next_token_id: int — the token predicted by main_lm_head
        position_id: scalar tensor — absolute position of h_prefinal_pos.
                     The MTP input token is `next_token_id`, so its RoPE
                     position is `position_id + 1`.

        Returns: int draft token id.
        """
        assert self.mtp_module is not None, "_mtp_predict called with no MTP module"
        # MTP module expects [B, T, H] with T=1
        B = h_prefinal_pos.shape[0]
        h_in = h_prefinal_pos.unsqueeze(1)                       # [B, 1, H]
        next_ids = torch.full((B, 1), next_token_id,
                              device=h_prefinal_pos.device,
                              dtype=torch.long)                  # [B, 1]
        # vLLM's qwen3_next_mtp forward receives input_ids and positions for
        # the MTP input token. Here that input is the main-predicted next token,
        # one absolute position after the hidden state that produced it.
        pos_ids = position_id.view(-1).long() + 1                # [T=1]
        mtp_hidden = self.mtp_module(h_in, next_ids, self.embed_tokens, pos_ids)  # [B, 1, H]
        # Apply shared lm_head directly (MTP module's own norm already inside)
        mtp_logits = F.linear(mtp_hidden[:, -1, :], self.lm_head)  # [B, V]
        return int(mtp_logits[0].argmax().item())

    def _predict_next_pair(
        self,
        h_prefinal_pos: torch.Tensor,
        position_id: torch.Tensor,
    ) -> tuple[int, int]:
        """Compute (main, draft) for one position."""
        main_t = self._main_predict(h_prefinal_pos)
        draft_t = self._mtp_predict(h_prefinal_pos, main_t, position_id)
        return main_t, draft_t

    # ---------------- public step ----------------

    def step(
        self,
        h_prefinal: torch.Tensor,
        position_ids: torch.Tensor,
    ) -> tuple[list[int], list[int]]:
        """One step of MTP-aware decode.

        Args:
          h_prefinal: [B, T, H] pre-final-norm hidden state from main body forward.
                      T=1 if previous step was single-mode (no pending draft).
                      T=2 if previous step left a pending draft (verify-mode).
          position_ids: [T] absolute positions matching h_prefinal sequence axis.

        Returns:
          (tokens_to_emit, next_input_ids):
            tokens_to_emit: list of int — emit these to output
            next_input_ids: list of int — feed these in next forward
        """
        if h_prefinal.dim() == 2:
            h_prefinal = h_prefinal.unsqueeze(1)
        B, T, H = h_prefinal.shape
        assert position_ids.numel() == T, (
            f"position_ids shape mismatch: got {position_ids.shape}, expected ({T},)"
        )

        # Branch 1: MTP disabled — single-token mode behaves like baseline
        if not self.enabled:
            assert T == 1, f"non-MTP path expects T=1, got T={T}"
            tok = self._main_predict(h_prefinal[:, 0, :])
            return [tok], [tok]

        # Branch 2: MTP enabled, single-token forward (first step / after reject)
        if self.pending_draft is None:
            assert T == 1, f"MTP single-mode expects T=1, got T={T}"
            self.n_single_steps += 1
            main_t, draft_t = self._predict_next_pair(h_prefinal[:, 0, :], position_ids[0:1])
            self.pending_draft = draft_t
            return [main_t], [main_t, draft_t]

        # Branch 3: MTP enabled, 2-token verify forward
        assert T == 2, f"MTP verify-mode expects T=2, got T={T}"
        verify_token = self._main_predict(h_prefinal[:, 0, :])
        accept = (verify_token == self.pending_draft)

        if accept:
            self.n_accepted += 1
            # Draft was right. Use position-1 hidden to compute next pair.
            new_main_t, new_draft_t = self._predict_next_pair(h_prefinal[:, 1, :], position_ids[1:2])
            tokens_emit = [self.pending_draft, new_main_t]
            self.pending_draft = new_draft_t
            return tokens_emit, [new_main_t, new_draft_t]

        # Reject
        self.n_rejected += 1
        self.pending_draft = None
        return [verify_token], [verify_token]

    @property
    def stats(self) -> dict:
        total_verify = self.n_accepted + self.n_rejected
        accept_rate = self.n_accepted / total_verify if total_verify > 0 else 0.0
        total_decoded = self.n_single_steps + total_verify
        tokens_per_step = (
            self.n_single_steps + 2 * self.n_accepted + self.n_rejected
        ) / max(1, total_decoded)
        return {
            "n_accepted": self.n_accepted,
            "n_rejected": self.n_rejected,
            "n_single_steps": self.n_single_steps,
            "accept_rate": accept_rate,
            "tokens_per_step": tokens_per_step,
            "throughput_multiplier_vs_no_mtp": tokens_per_step,
        }


# ---------------------------------------------------------------------------
# Module construction + loading helpers
# ---------------------------------------------------------------------------

def build_mtp_module_from_config(model_config_path: str, device: torch.device,
                                  dtype: torch.dtype = torch.bfloat16) -> Optional[nn.Module]:
    """Build a Qwen3NextMTPModule from a config.json on disk.

    Returns None if config.json doesn't declare an MTP head (`mtp_num_hidden_layers`
    missing or 0).
    """
    from .mtp_qwen3_next import Qwen3NextMTPConfig, Qwen3NextMTPModule

    with open(model_config_path) as f:
        config_full = json.load(f)
    text_cfg = config_full.get("text_config", config_full)

    if text_cfg.get("mtp_num_hidden_layers", 0) < 1:
        return None

    mtp_cfg = Qwen3NextMTPConfig.from_dict(text_cfg)
    module = Qwen3NextMTPModule(mtp_cfg)
    module = module.to(device=device, dtype=dtype)
    return module


def load_mtp_module_from_state_dict(
    module: nn.Module,
    state_dict: dict,
    strict: bool = True,
) -> nn.Module:
    """Populate an MTP module from a state dict (Qwen3.6-format) using key remapping.

    Args:
      module: a Qwen3NextMTPModule (already constructed).
      state_dict: dict potentially containing `mtp.*` keys (Qwen3.6 canonical form).
      strict: if True, raise on missing or unexpected keys after remap.

    Returns: the module (mutated in place).
    """
    from .mtp_qwen3_next import remap_qwen36_to_lynn_mtp

    prefix = detect_mtp_head_in_state_dict(state_dict)
    if prefix is None:
        if strict:
            raise KeyError("no MTP-prefixed tensors found in state_dict")
        return module

    # Normalize prefix to `mtp.` (canonical) before remap
    if prefix != "mtp.":
        normalized = {}
        for k, v in state_dict.items():
            if k.startswith(prefix):
                normalized["mtp." + k[len(prefix):]] = v
            else:
                normalized[k] = v
        state_dict = normalized

    remapped = remap_qwen36_to_lynn_mtp(state_dict)
    missing, unexpected = module.load_state_dict(remapped, strict=False)
    if strict:
        if missing:
            raise KeyError(f"MTP module missing keys after remap: {missing}")
        if unexpected:
            raise KeyError(f"MTP module unexpected keys: {unexpected}")
    return module


def load_mtp_module_from_safetensors_dir(
    module: nn.Module,
    model_dir: str,
    strict: bool = True,
) -> nn.Module:
    """Scan a HF model directory for safetensors shards containing mtp.* tensors
    and load them into the module.

    Args:
      module: a Qwen3NextMTPModule.
      model_dir: HF model directory path.
      strict: if True, raise on missing/unexpected keys.

    Returns: the module (mutated in place).
    """
    from safetensors.torch import safe_open

    state_dict = {}
    model_path = Path(model_dir)
    if not model_path.exists():
        raise FileNotFoundError(f"model_dir not found: {model_dir}")

    # Try common shard locations
    candidates = list(sorted(model_path.glob("*.safetensors"))) + \
                 list(sorted(model_path.glob("tensors/*.safetensors")))
    for st_path in candidates:
        try:
            with safe_open(str(st_path), framework="pt", device="cpu") as sf:
                for key in sf.keys():
                    if any(key.startswith(p) for p in NEXTN_HEAD_KEY_PREFIXES):
                        state_dict[key] = sf.get_tensor(key)
        except Exception as exc:
            print(f"[mtp] WARN scanning {st_path}: {type(exc).__name__}: {exc}")

    if not state_dict:
        if strict:
            raise KeyError(f"no MTP tensors found under {model_dir}")
        return module

    return load_mtp_module_from_state_dict(module, state_dict, strict=strict)


__all__ = [
    "MTPController",
    "NEXTN_HEAD_KEY_PREFIXES",
    "detect_mtp_head_in_state_dict",
    "build_mtp_module_from_config",
    "load_mtp_module_from_state_dict",
    "load_mtp_module_from_safetensors_dir",
]
