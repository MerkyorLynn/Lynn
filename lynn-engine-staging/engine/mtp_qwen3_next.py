"""Qwen3-Next MTP module — Lynn-owned 2048-hidden implementation.

Architecture lifted from Qwen3.6-35B-A3B's `mtp.*` tensors (model-00026-of-00026.safetensors,
HF Qwen/Qwen3.6-35B-A3B, 2026-05-16). Per-tensor names verified against actual checkpoint
index. Same architecture family as Lynn 27B (Qwen3_5MoeForConditionalGeneration), so weights
can be warm-started from Qwen3.6-35B-A3B then frozen-body finetuned on Lynn data.

Architecture (one transformer block + FC combiner + shared embed/lm_head):

    embed_tokens(t_{k+1})            h_k (from Lynn body)
            │                              │
    pre_fc_norm_embedding         pre_fc_norm_hidden
            │                              │
            └─────── concat ────────┘
                          │
                       fc (Linear, 2H -> H)
                          │
                  ┌───────┴───────┐
                  │   1 transformer layer
                  │   ├ input_layernorm
                  │   ├ self_attn (q/k/v/o, q_norm/k_norm, partial RoPE)
                  │   ├ residual
                  │   ├ post_attention_layernorm
                  │   └ mlp (MoE 256 expert + shared expert + gate)
                  └───────┬───────┘
                          │
                       norm (RMSNorm)
                          │
                       lm_head (shared with main model) -> logits -> t_{k+2}

Lynn-vs-Qwen3.6 compatibility:
  hidden_size 2048 = same
  embed_tokens [vocab=248320, hidden=2048] = same
  lm_head [248320, 2048] = same
  MTP's own MoE = independent 256-expert pool (NOT affected by Lynn variable-pruning)
  Main body's hidden output distribution -> Lynn distillation/Recovery LoRA causes
    minor drift vs Qwen3.6; warm-start + frozen-body finetune adapts.

Input contract (verified against vLLM source `vllm/model_executor/models/qwen3_next_mtp.py`,
2026-05-16):
  prev_hidden is the **RAW layer-N output**, i.e., PRE-main-final-norm. The MTP module
  applies its own `pre_fc_norm_hidden` as the first norm seen by that hidden. Main body's
  `model.norm` is applied ONLY on the main lm_head path, NOT on the MTP path.
  → Caller (MTPController) must pass `h_prefinal` to this module's forward,
    NOT `h_final = main_final_norm(h_prefinal)`.

This file is the BF16 reference forward. Lynn-engine optimization (Triton SP-08 MoE,
Spark FP8 path) plugs in later via the same module signature.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class Qwen3NextMTPConfig:
    """Subset of Qwen3.6-35B-A3B text_config needed for MTP head construction."""
    hidden_size: int = 2048
    num_attention_heads: int = 16
    num_key_value_heads: int = 2
    head_dim: int = 256
    num_experts: int = 256
    num_experts_per_tok: int = 8
    moe_intermediate_size: int = 512
    shared_expert_intermediate_size: int = 512
    rms_norm_eps: float = 1e-6
    partial_rotary_factor: float = 0.25
    rope_theta: float = 10_000_000.0
    vocab_size: int = 248320
    mtp_num_hidden_layers: int = 1
    mtp_use_dedicated_embeddings: bool = False

    @classmethod
    def from_dict(cls, cfg: dict) -> "Qwen3NextMTPConfig":
        """Build from a config.json text_config dict."""
        rope_p = cfg.get("rope_parameters", {})
        return cls(
            hidden_size=cfg["hidden_size"],
            num_attention_heads=cfg.get("num_attention_heads", 16),
            num_key_value_heads=cfg.get("num_key_value_heads", 2),
            head_dim=cfg.get("head_dim", 256),
            num_experts=cfg.get("num_experts", 256),
            num_experts_per_tok=cfg.get("num_experts_per_tok", 8),
            moe_intermediate_size=cfg.get("moe_intermediate_size", 512),
            shared_expert_intermediate_size=cfg.get("shared_expert_intermediate_size", 512),
            rms_norm_eps=cfg.get("rms_norm_eps", 1e-6),
            partial_rotary_factor=rope_p.get("partial_rotary_factor",
                                              cfg.get("partial_rotary_factor", 0.25)),
            rope_theta=rope_p.get("rope_theta", cfg.get("rope_theta", 1e7)),
            vocab_size=cfg.get("vocab_size", 248320),
            mtp_num_hidden_layers=cfg.get("mtp_num_hidden_layers", 1),
            mtp_use_dedicated_embeddings=cfg.get("mtp_use_dedicated_embeddings", False),
        )


# ---------------------------------------------------------------------------
# Components
# ---------------------------------------------------------------------------

class RMSNorm(nn.Module):
    def __init__(self, dim: int, eps: float = 1e-6):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(dim))
        self.eps = eps

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        orig_dtype = x.dtype
        x32 = x.to(torch.float32)
        var = x32.pow(2).mean(dim=-1, keepdim=True)
        x32 = x32 * torch.rsqrt(var + self.eps)
        return (x32 * self.weight.to(torch.float32)).to(orig_dtype)


def _build_rope(seq_len: int, head_dim: int, rotary_dim: int, theta: float,
                device: torch.device, dtype: torch.dtype):
    """Standard partial-rotary RoPE cos/sin tables.

    Returns: (cos, sin) each shape [seq_len, rotary_dim]
    """
    half = rotary_dim // 2
    inv_freq = 1.0 / (theta ** (torch.arange(0, half, device=device, dtype=torch.float32) / half))
    positions = torch.arange(seq_len, device=device, dtype=torch.float32)
    freqs = torch.outer(positions, inv_freq)  # [T, half]
    cos = torch.cos(freqs).to(dtype)
    sin = torch.sin(freqs).to(dtype)
    return cos, sin


def _apply_partial_rope(x: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor,
                        rotary_dim: int) -> torch.Tensor:
    """Apply RoPE to first rotary_dim dims of last axis; leave rest unchanged.

    x: [..., T, D] where D = head_dim. cos/sin: [T, rotary_dim/2]
    """
    rot = x[..., :rotary_dim]
    nrot = x[..., rotary_dim:]
    half = rotary_dim // 2
    x1, x2 = rot[..., :half], rot[..., half:]
    # cos/sin broadcast over leading dims and head dim
    while cos.dim() < rot.dim():
        cos = cos.unsqueeze(0)
        sin = sin.unsqueeze(0)
    cos = cos[..., :half]
    sin = sin[..., :half]
    rotated = torch.cat([x1 * cos - x2 * sin, x1 * sin + x2 * cos], dim=-1)
    return torch.cat([rotated, nrot], dim=-1)


class Qwen3NextMTPSelfAttention(nn.Module):
    """Standard multi-head self-attention with Qwen-style q/k norm + partial RoPE.

    Matches tensor layout `mtp.layers.0.self_attn.*` from Qwen3.6-35B-A3B:
      q_proj.weight    : [num_heads * head_dim, hidden_size]   = [16*256, 2048] = [4096, 2048]
      k_proj.weight    : [num_kv_heads * head_dim, hidden_size] = [2*256, 2048] = [512, 2048]
      v_proj.weight    : [num_kv_heads * head_dim, hidden_size] = [512, 2048]
      o_proj.weight    : [hidden_size, num_heads * head_dim]    = [2048, 4096]
      q_norm.weight    : [head_dim] = [256]
      k_norm.weight    : [head_dim] = [256]
    """
    def __init__(self, cfg: Qwen3NextMTPConfig):
        super().__init__()
        self.cfg = cfg
        H = cfg.hidden_size
        self.num_heads = cfg.num_attention_heads
        self.num_kv_heads = cfg.num_key_value_heads
        self.head_dim = cfg.head_dim
        self.rotary_dim = int(self.head_dim * cfg.partial_rotary_factor)

        self.q_proj = nn.Linear(H, self.num_heads * self.head_dim, bias=False)
        self.k_proj = nn.Linear(H, self.num_kv_heads * self.head_dim, bias=False)
        self.v_proj = nn.Linear(H, self.num_kv_heads * self.head_dim, bias=False)
        self.o_proj = nn.Linear(self.num_heads * self.head_dim, H, bias=False)
        self.q_norm = RMSNorm(self.head_dim, cfg.rms_norm_eps)
        self.k_norm = RMSNorm(self.head_dim, cfg.rms_norm_eps)

    def forward(self, h: torch.Tensor, position_ids: torch.Tensor) -> torch.Tensor:
        """Forward.

        h: [B, T, H]
        position_ids: [T] absolute positions (used for RoPE)
        Returns: [B, T, H]
        """
        B, T, _ = h.shape
        q = self.q_proj(h).view(B, T, self.num_heads, self.head_dim)
        k = self.k_proj(h).view(B, T, self.num_kv_heads, self.head_dim)
        v = self.v_proj(h).view(B, T, self.num_kv_heads, self.head_dim)
        q = self.q_norm(q)
        k = self.k_norm(k)

        # RoPE
        seq_len_for_rope = int(position_ids.max().item()) + 1
        cos, sin = _build_rope(seq_len_for_rope, self.head_dim, self.rotary_dim,
                               self.cfg.rope_theta, h.device, h.dtype)
        cos = cos.index_select(0, position_ids.to(h.device).long())  # [T, rotary_dim/2]
        sin = sin.index_select(0, position_ids.to(h.device).long())
        # Reshape to broadcast over heads: [T, half] -> [1, T, 1, half]
        cos = cos.view(1, T, 1, -1)
        sin = sin.view(1, T, 1, -1)
        q = _apply_partial_rope(q, cos, sin, self.rotary_dim)
        k = _apply_partial_rope(k, cos, sin, self.rotary_dim)

        # GQA expand
        if self.num_kv_heads != self.num_heads:
            rep = self.num_heads // self.num_kv_heads
            k = k.repeat_interleave(rep, dim=2)
            v = v.repeat_interleave(rep, dim=2)

        # SDPA — [B, T, H_heads, D] -> [B, H_heads, T, D]
        q = q.transpose(1, 2)
        k = k.transpose(1, 2)
        v = v.transpose(1, 2)

        # Causal mask
        attn_out = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        # [B, H, T, D] -> [B, T, H*D]
        attn_out = attn_out.transpose(1, 2).contiguous().view(B, T, self.num_heads * self.head_dim)
        return self.o_proj(attn_out)


class Qwen3NextMTPMoE(nn.Module):
    """MoE with 256 experts + 1 shared expert + shared_expert_gate.

    Matches tensor layout `mtp.layers.0.mlp.*`:
      gate.weight                   : [num_experts, hidden_size] = [256, 2048]
      shared_expert.gate_proj.weight: [shared_int, hidden_size]  = [512, 2048]
      shared_expert.up_proj.weight  : [shared_int, hidden_size]
      shared_expert.down_proj.weight: [hidden_size, shared_int]  = [2048, 512]
      shared_expert_gate.weight     : [1, hidden_size]           = [1, 2048]
      experts.gate_up_proj          : [num_experts, 2*inter, hidden_size]  = [256, 1024, 2048]
      experts.down_proj             : [num_experts, hidden_size, inter]    = [256, 2048, 512]

    This MoE pool is INDEPENDENT of main body experts. Lynn variable-pruning does
    NOT affect this MTP MoE — Qwen3.6 weights port directly.
    """
    def __init__(self, cfg: Qwen3NextMTPConfig):
        super().__init__()
        self.cfg = cfg
        H = cfg.hidden_size
        I = cfg.moe_intermediate_size
        E = cfg.num_experts
        K = cfg.num_experts_per_tok
        SI = cfg.shared_expert_intermediate_size

        self.gate = nn.Linear(H, E, bias=False)
        # Stacked expert weights (HF format: [E, ...])
        self.experts_gate_up_proj = nn.Parameter(torch.zeros(E, 2 * I, H))
        self.experts_down_proj = nn.Parameter(torch.zeros(E, H, I))

        # Shared expert (standard FFN)
        self.shared_expert_gate_proj = nn.Linear(H, SI, bias=False)
        self.shared_expert_up_proj = nn.Linear(H, SI, bias=False)
        self.shared_expert_down_proj = nn.Linear(SI, H, bias=False)
        self.shared_expert_gate = nn.Linear(H, 1, bias=False)

        self.top_k = K

    def forward(self, h: torch.Tensor) -> torch.Tensor:
        """Forward MoE.

        h: [B, T, H]
        Returns: [B, T, H]
        """
        B, T, H = h.shape
        h_flat = h.reshape(B * T, H)

        # Router
        gate_logits = self.gate(h_flat)  # [B*T, E]
        routing_weights, expert_ids = torch.topk(gate_logits, self.top_k, dim=-1)
        routing_weights = F.softmax(routing_weights, dim=-1, dtype=torch.float32).to(h.dtype)

        # Active expert forward — naive per-token gather (BF16 reference, Lynn-engine
        # Triton SP-08 path replaces this in production after warm-start)
        out = torch.zeros_like(h_flat)
        for slot in range(self.top_k):
            ids = expert_ids[:, slot]                 # [B*T] expert index per token
            w_slot = routing_weights[:, slot:slot+1]  # [B*T, 1]
            # Gather expert weights for each token's expert
            gu = self.experts_gate_up_proj[ids]        # [B*T, 2I, H]
            dp = self.experts_down_proj[ids]           # [B*T, H, I]
            # Per-token: gate_up = h @ gu^T -> [B*T, 2I]; silu+mult; @ dp^T -> [B*T, H]
            gate_up = torch.einsum('th,tih->ti', h_flat, gu)
            I_dim = gate_up.shape[-1] // 2
            gate = gate_up[:, :I_dim]
            up = gate_up[:, I_dim:]
            inter = F.silu(gate) * up                   # [B*T, I]
            slot_out = torch.einsum('ti,thi->th', inter, dp)
            out = out + w_slot * slot_out

        # Shared expert
        sh_gate = self.shared_expert_gate_proj(h_flat)
        sh_up = self.shared_expert_up_proj(h_flat)
        sh_inter = F.silu(sh_gate) * sh_up
        sh_out = self.shared_expert_down_proj(sh_inter)
        sh_gate_val = torch.sigmoid(self.shared_expert_gate(h_flat))  # [B*T, 1]
        out = out + sh_gate_val * sh_out

        return out.reshape(B, T, H)


class Qwen3NextMTPLayer(nn.Module):
    """One MTP transformer block: input_layernorm + self_attn + residual + post_attention_layernorm + MoE + residual."""
    def __init__(self, cfg: Qwen3NextMTPConfig):
        super().__init__()
        H = cfg.hidden_size
        self.input_layernorm = RMSNorm(H, cfg.rms_norm_eps)
        self.post_attention_layernorm = RMSNorm(H, cfg.rms_norm_eps)
        self.self_attn = Qwen3NextMTPSelfAttention(cfg)
        self.mlp = Qwen3NextMTPMoE(cfg)

    def forward(self, h: torch.Tensor, position_ids: torch.Tensor) -> torch.Tensor:
        residual = h
        h = self.input_layernorm(h)
        h = self.self_attn(h, position_ids)
        h = residual + h
        residual = h
        h = self.post_attention_layernorm(h)
        h = self.mlp(h)
        h = residual + h
        return h


class Qwen3NextMTPModule(nn.Module):
    """Lynn-owned qwen3_next_mtp module — 1-layer MTP head.

    Forward(prev_hidden, next_token_ids, embed_tokens) -> mtp_hidden:
      1. embed = embed_tokens(next_token_ids)
      2. norm_e = pre_fc_norm_embedding(embed); norm_h = pre_fc_norm_hidden(prev_hidden)
      3. h = fc(concat([norm_e, norm_h]))
      4. for layer in layers: h = layer(h, position_ids)
      5. return norm(h)

    Caller applies shared lm_head to produce MTP logits.

    Lynn-vs-Qwen3.6: shape-identical. Init weights from Qwen3.6-35B-A3B mtp.* tensors
    via load_qwen36_mtp_state_dict() then frozen-body finetune on Lynn data.
    """
    def __init__(self, cfg: Qwen3NextMTPConfig):
        super().__init__()
        self.cfg = cfg
        H = cfg.hidden_size
        self.pre_fc_norm_embedding = RMSNorm(H, cfg.rms_norm_eps)
        self.pre_fc_norm_hidden = RMSNorm(H, cfg.rms_norm_eps)
        self.fc = nn.Linear(2 * H, H, bias=False)
        self.layers = nn.ModuleList([
            Qwen3NextMTPLayer(cfg) for _ in range(cfg.mtp_num_hidden_layers)
        ])
        self.norm = RMSNorm(H, cfg.rms_norm_eps)

    def forward(
        self,
        prev_hidden: torch.Tensor,
        next_token_ids: torch.Tensor,
        embed_tokens: nn.Embedding,
        position_ids: torch.Tensor,
    ) -> torch.Tensor:
        """Forward MTP module.

        Args:
          prev_hidden: [B, T, H] hidden states from main body final layer (post norm if applicable)
          next_token_ids: [B, T] token IDs of t_{k+1} (predicted by main lm_head, or input fed)
          embed_tokens: nn.Embedding (shared with main body)
          position_ids: [T] absolute positions

        Returns:
          mtp_hidden: [B, T, H] — feed through shared lm_head to get MTP logits for t_{k+2}
        """
        emb = embed_tokens(next_token_ids)              # [B, T, H]
        norm_e = self.pre_fc_norm_embedding(emb)
        norm_h = self.pre_fc_norm_hidden(prev_hidden)
        fc_in = torch.cat([norm_e, norm_h], dim=-1)     # [B, T, 2H]
        h = self.fc(fc_in)                              # [B, T, H]
        for layer in self.layers:
            h = layer(h, position_ids)
        return self.norm(h)


# ---------------------------------------------------------------------------
# Loader: warm-start from Qwen3.6-35B-A3B MTP weights
# ---------------------------------------------------------------------------

# Tensor name map: Qwen3.6 HF format -> our nn.Module attribute path
_QWEN36_TO_LYNN_MTP_KEY_MAP = {
    "mtp.fc.weight":                                              "fc.weight",
    "mtp.norm.weight":                                            "norm.weight",
    "mtp.pre_fc_norm_embedding.weight":                           "pre_fc_norm_embedding.weight",
    "mtp.pre_fc_norm_hidden.weight":                              "pre_fc_norm_hidden.weight",
    "mtp.layers.0.input_layernorm.weight":                        "layers.0.input_layernorm.weight",
    "mtp.layers.0.post_attention_layernorm.weight":               "layers.0.post_attention_layernorm.weight",
    "mtp.layers.0.self_attn.q_proj.weight":                       "layers.0.self_attn.q_proj.weight",
    "mtp.layers.0.self_attn.k_proj.weight":                       "layers.0.self_attn.k_proj.weight",
    "mtp.layers.0.self_attn.v_proj.weight":                       "layers.0.self_attn.v_proj.weight",
    "mtp.layers.0.self_attn.o_proj.weight":                       "layers.0.self_attn.o_proj.weight",
    "mtp.layers.0.self_attn.q_norm.weight":                       "layers.0.self_attn.q_norm.weight",
    "mtp.layers.0.self_attn.k_norm.weight":                       "layers.0.self_attn.k_norm.weight",
    "mtp.layers.0.mlp.gate.weight":                               "layers.0.mlp.gate.weight",
    "mtp.layers.0.mlp.shared_expert.gate_proj.weight":            "layers.0.mlp.shared_expert_gate_proj.weight",
    "mtp.layers.0.mlp.shared_expert.up_proj.weight":              "layers.0.mlp.shared_expert_up_proj.weight",
    "mtp.layers.0.mlp.shared_expert.down_proj.weight":            "layers.0.mlp.shared_expert_down_proj.weight",
    "mtp.layers.0.mlp.shared_expert_gate.weight":                 "layers.0.mlp.shared_expert_gate.weight",
    "mtp.layers.0.mlp.experts.gate_up_proj":                      "layers.0.mlp.experts_gate_up_proj",
    "mtp.layers.0.mlp.experts.down_proj":                         "layers.0.mlp.experts_down_proj",
}


def remap_qwen36_to_lynn_mtp(hf_state_dict: dict) -> dict:
    """Remap Qwen3.6-35B-A3B HF state_dict (mtp.* tensors only) to Lynn MTP module keys.

    Args:
      hf_state_dict: dict of tensor name -> tensor, possibly containing many non-MTP keys.

    Returns:
      Filtered + renamed dict suitable for `Qwen3NextMTPModule.load_state_dict(strict=True)`.
    """
    out = {}
    for hf_key, lynn_key in _QWEN36_TO_LYNN_MTP_KEY_MAP.items():
        if hf_key in hf_state_dict:
            out[lynn_key] = hf_state_dict[hf_key]
    return out


def expected_shape_check(module: Qwen3NextMTPModule) -> dict:
    """Return a dict of expected tensor shapes for sanity-check loading."""
    cfg = module.cfg
    H = cfg.hidden_size
    I = cfg.moe_intermediate_size
    E = cfg.num_experts
    SI = cfg.shared_expert_intermediate_size
    nH = cfg.num_attention_heads
    nKV = cfg.num_key_value_heads
    D = cfg.head_dim
    return {
        "fc.weight": (H, 2 * H),
        "norm.weight": (H,),
        "pre_fc_norm_embedding.weight": (H,),
        "pre_fc_norm_hidden.weight": (H,),
        "layers.0.input_layernorm.weight": (H,),
        "layers.0.post_attention_layernorm.weight": (H,),
        "layers.0.self_attn.q_proj.weight": (nH * D, H),
        "layers.0.self_attn.k_proj.weight": (nKV * D, H),
        "layers.0.self_attn.v_proj.weight": (nKV * D, H),
        "layers.0.self_attn.o_proj.weight": (H, nH * D),
        "layers.0.self_attn.q_norm.weight": (D,),
        "layers.0.self_attn.k_norm.weight": (D,),
        "layers.0.mlp.gate.weight": (E, H),
        "layers.0.mlp.shared_expert_gate_proj.weight": (SI, H),
        "layers.0.mlp.shared_expert_up_proj.weight": (SI, H),
        "layers.0.mlp.shared_expert_down_proj.weight": (H, SI),
        "layers.0.mlp.shared_expert_gate.weight": (1, H),
        "layers.0.mlp.experts_gate_up_proj": (E, 2 * I, H),
        "layers.0.mlp.experts_down_proj": (E, H, I),
    }


__all__ = [
    "Qwen3NextMTPConfig",
    "Qwen3NextMTPModule",
    "Qwen3NextMTPLayer",
    "Qwen3NextMTPSelfAttention",
    "Qwen3NextMTPMoE",
    "RMSNorm",
    "remap_qwen36_to_lynn_mtp",
    "expected_shape_check",
]
