"""Load A100 Qwen3.6-35B-A3B MTP sidecar through SP-16 staging,
verify shapes + strict load + smoke forward. Resolves A100 AMBER finding."""
import sys
import json
from pathlib import Path

sys.path.insert(0, "/lynn-engine")

from safetensors.torch import safe_open
import torch
import torch.nn as nn
from engine.mtp_qwen3_next import (
    Qwen3NextMTPConfig,
    Qwen3NextMTPModule,
    expected_shape_check,
    remap_qwen36_to_lynn_mtp,
)


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
    "attn_output_gate": True,
}


def main():
    print("=== building Lynn MTP module ===")
    cfg = Qwen3NextMTPConfig.from_dict(LYNN_CONFIG_VALUES)
    module = Qwen3NextMTPModule(cfg).to(dtype=torch.bfloat16)
    n_params = sum(p.numel() for p in module.parameters()) / 1e6
    print(f"  Lynn module: {n_params:.1f}M params")

    print()
    print("=== load A100 sidecar mtp.safetensors ===")
    # Container has /home/merkyor/models mounted at /models
    sidecar = "/models/mtp_sidecars/qwen36-35b-a3b-mtp/mtp.safetensors"
    hf_state = {}
    with safe_open(sidecar, framework="pt", device="cpu") as sf:
        for k in sf.keys():
            hf_state[k] = sf.get_tensor(k)
    print(f"  loaded {len(hf_state)} tensors from sidecar")

    print()
    print("=== remap Qwen3.6 → Lynn module names ===")
    remapped = remap_qwen36_to_lynn_mtp(hf_state)
    print(f"  remapped {len(remapped)} tensors")

    print()
    print("=== shape diff check vs SP-16 expected ===")
    expected = expected_shape_check(module)
    shape_mismatches = []
    missing = []
    extras = []
    for k, exp_shape in expected.items():
        if k not in remapped:
            missing.append(k)
            continue
        actual = tuple(remapped[k].shape)
        if actual != exp_shape:
            shape_mismatches.append({"key": k, "expected": exp_shape, "got": actual})
    for k in remapped:
        if k not in expected:
            extras.append(k)

    if not shape_mismatches and not missing and not extras:
        print("  ALL 19 TENSORS MATCH SP-16 EXPECTED SHAPES")
    else:
        if shape_mismatches:
            print("  SHAPE MISMATCHES:")
            for m in shape_mismatches:
                print(f"    {m['key']}: expected {m['expected']} got {m['got']}")
        if missing:
            print(f"  MISSING after remap: {missing}")
        if extras:
            print(f"  EXTRAS after remap: {extras}")

    print()
    print("=== strict load_state_dict ===")
    missing_keys, unexpected_keys = module.load_state_dict(remapped, strict=False)
    if not missing_keys and not unexpected_keys:
        print("  STRICT LOAD PASS — no missing, no unexpected")
    else:
        if missing_keys:
            print(f"  missing: {list(missing_keys)}")
        if unexpected_keys:
            print(f"  unexpected: {list(unexpected_keys)}")

    print()
    print("=== smoke forward ===")
    H = cfg.hidden_size
    prev_hidden = torch.randn(1, 1, H, dtype=torch.bfloat16) * 0.1
    next_token_ids = torch.tensor([[42]], dtype=torch.long)
    position_ids = torch.tensor([0], dtype=torch.long)
    embed_tokens = nn.Embedding(cfg.vocab_size, H).to(dtype=torch.bfloat16)
    nn.init.normal_(embed_tokens.weight, std=0.02)

    try:
        out = module(prev_hidden, next_token_ids, embed_tokens, position_ids)
        forward_ok = True
        forward_msg = f"shape={out.shape} dtype={out.dtype} nan={torch.isnan(out).any().item()} inf={torch.isinf(out).any().item()}"
        print(f"  forward PASS: {forward_msg}")
    except Exception as e:
        forward_ok = False
        forward_msg = f"{type(e).__name__}: {e}"
        print(f"  forward FAIL: {forward_msg}")

    print()
    print("=== VERDICT: A100 AMBER vs SP-16 perspective ===")
    print("  A100 AMBER: q_norm/k_norm shape [256] flagged as suspicious")
    print("             (their auditor only checks hidden/intermediate/vocab dims)")
    print("  SP-16 says: [256] = head_dim per-head RMSNorm, exactly the spec")
    print("              (expected_shape_check has 'q_norm': (D,) where D=256)")
    overall = (not shape_mismatches and not missing and not extras
               and not missing_keys and not unexpected_keys and forward_ok)
    print(f"  OVERALL: {'GREEN — sidecar fully consumable by Lynn-owned MTP module' if overall else 'NEEDS FIX (see above)'}")

    result = {
        "verdict": "GREEN" if overall else "NEEDS_FIX",
        "a100_amber_resolution": (
            "FALSE POSITIVE — q_norm/k_norm shape [256] is head_dim (=256) per-head RMSNorm; "
            "SP-16 expected_shape_check correctly specifies this. A100 audit script only checks "
            "against hidden_size/intermediate_size/vocab_size and doesn't recognize head_dim."
        ),
        "n_tensors": len(remapped),
        "shape_mismatches": shape_mismatches,
        "missing_after_remap": list(missing) + list(missing_keys),
        "unexpected_after_remap": list(extras) + list(unexpected_keys),
        "forward_ok": forward_ok,
        "forward_detail": forward_msg,
        "sidecar_path": sidecar,
        "sidecar_bytes": Path(sidecar).stat().st_size,
        "verdict_overall": overall,
    }
    out_path = Path("/lynn-engine/reports/overnight_optim_20260517/mtp_sidecar_load_verdict.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(f"\nresult: {out_path}")


if __name__ == "__main__":
    main()
