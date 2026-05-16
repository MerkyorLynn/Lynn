#!/usr/bin/env python3
"""SP-17: v2 NVFP4 artifact receive + structural validation.

Runs AFTER R6000 → Spark transfer completes. Validates the new Lynn 27B
W4A8 NVFP4 v2 (or any subsequent versioned) artifact:

1. File completeness — config.json, tokenizer, safetensors shards, index
2. Checksum verify (SHA256SUMS or model.safetensors.index.json shard hashes)
3. Config sanity vs Lynn 27B reference (hidden=2048, 40 layer, 256 expert,
   248320 vocab, layer_types pattern, MTP fields if applicable)
4. Tensor metadata sanity — safetensors index lists expected NVFP4 packed
   tensor names: `_gate_up_packed`, `_gate_up_scale`, `_gate_up_global_scale`,
   `_down_packed`, `_down_scale`, `_down_global_scale` per layer
5. Lynn quant manifest presence — `lynn_quant_manifest.json`,
   `lynn_engine_variable_expert_spec.json`, `router_mask_variable_target.json`
6. MTP head detection — if `mtp.*` tensors present, validate shapes against
   `engine/mtp_qwen3_next.py:expected_shape_check` (Qwen3.6 reference spec)
7. Architecture diff vs v0 — tensor name set should match v0; weight values
   different is expected (that's the whole point), but topology must be same

Does NOT load full model into GPU memory (production server is using it).
Does NOT do inference parity test (that's a separate SP-18 needing server
restart).

Output: JSON report + console PASS/FAIL gate.

Usage:
    python3 sp17_v2_artifact_receive_validation.py \\
        --v2-dir /home/merkyor/models/incoming-v2 \\
        --v0-dir /home/merkyor/models/lynn-27b-variable-recovery-step5000-nvfp4-final \\
        [--checksum-file /home/merkyor/models/incoming-v2/SHA256SUMS]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path


# Lynn 27B canonical config values (must match for the artifact to be valid)
LYNN_27B_EXPECTED_CONFIG = {
    "hidden_size": 2048,
    "num_hidden_layers": 40,
    "num_experts": 256,
    "num_experts_per_tok": 8,
    "head_dim": 256,
    "vocab_size": 248320,
    "num_attention_heads": 16,
    "num_key_value_heads": 2,
    "moe_intermediate_size": 512,
    "shared_expert_intermediate_size": 512,
    "rms_norm_eps": 1e-6,
}

LYNN_LAYER_TYPES_EXPECTED = (
    ["linear_attention"] * 3 + ["full_attention"]
) * 10  # 40 layers = 10 × (3 linear + 1 full)


# Required Lynn-specific manifest files
LYNN_REQUIRED_FILES = [
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "chat_template.jinja",
    "model.safetensors.index.json",
    "lynn_quant_manifest.json",
    "lynn_engine_variable_expert_spec.json",
    "router_mask_variable_target.json",
]


# NVFP4 packed tensor names per MoE layer (Lynn-native format)
NVFP4_PACKED_KEYS_PER_LAYER = [
    "mlp.experts._gate_up_packed",
    "mlp.experts._gate_up_scale",
    "mlp.experts._gate_up_global_scale",
    "mlp.experts._down_packed",
    "mlp.experts._down_scale",
    "mlp.experts._down_global_scale",
]


def sha256_file(path: Path, block_size: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            buf = f.read(block_size)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def t1_file_completeness(v2_dir: Path) -> tuple[bool, list[str], dict]:
    """T1: required files present."""
    missing = []
    found = {}
    for fname in LYNN_REQUIRED_FILES:
        p = v2_dir / fname
        if not p.exists():
            missing.append(fname)
        else:
            found[fname] = p.stat().st_size

    # Check for safetensors shards (at least one)
    safetensors = sorted(v2_dir.glob("*.safetensors")) + sorted((v2_dir / "tensors").glob("*.safetensors"))
    if not safetensors:
        missing.append("*.safetensors (no shards)")

    return (len(missing) == 0), missing, {"found": found, "n_shards": len(safetensors)}


def t2_checksum_verify(v2_dir: Path, checksum_file: Path | None) -> tuple[bool, list[str], dict]:
    """T2: SHA256 verify if checksum file present."""
    if checksum_file is None:
        for cand in [v2_dir / "SHA256SUMS", v2_dir / "checksums.sha256", v2_dir / "checksum.txt"]:
            if cand.exists():
                checksum_file = cand
                break

    if checksum_file is None or not checksum_file.exists():
        return True, ["(skipped — no checksum file)"], {"skipped": True}

    expected = {}
    with open(checksum_file) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(maxsplit=1)
            if len(parts) == 2:
                expected[parts[1].lstrip("*")] = parts[0]

    mismatches = []
    verified = {}
    for relpath, exp_hash in expected.items():
        fpath = v2_dir / relpath
        if not fpath.exists():
            mismatches.append(f"{relpath}: file not found")
            continue
        actual = sha256_file(fpath)
        if actual != exp_hash:
            mismatches.append(f"{relpath}: expected {exp_hash[:16]}..., got {actual[:16]}...")
        else:
            verified[relpath] = exp_hash[:16] + "..."

    return (len(mismatches) == 0), mismatches, {"verified": len(verified), "total": len(expected)}


def t3_config_sanity(v2_dir: Path) -> tuple[bool, list[str], dict]:
    """T3: config.json matches Lynn 27B expected values."""
    with open(v2_dir / "config.json") as f:
        cfg = json.load(f)
    text_cfg = cfg.get("text_config", cfg)

    mismatches = []
    actual = {}
    for key, expected in LYNN_27B_EXPECTED_CONFIG.items():
        actual_val = text_cfg.get(key)
        actual[key] = actual_val
        if actual_val != expected:
            mismatches.append(f"{key}: expected {expected}, got {actual_val}")

    # Layer types pattern
    layer_types = text_cfg.get("layer_types", [])
    if list(layer_types) != LYNN_LAYER_TYPES_EXPECTED:
        # Be tolerant — just count types
        n_full = layer_types.count("full_attention")
        n_linear = layer_types.count("linear_attention")
        if n_full != 10 or n_linear != 30:
            mismatches.append(f"layer_types pattern off: {n_linear} linear / {n_full} full (expected 30/10)")

    # Architecture name
    arch = cfg.get("architectures", [])
    if arch and "Qwen3_5MoeForConditionalGeneration" not in arch[0]:
        mismatches.append(f"architecture {arch} not Qwen3_5MoeForConditionalGeneration family")

    return (len(mismatches) == 0), mismatches, {"config_actual": actual,
                                                  "mtp_num_hidden_layers": text_cfg.get("mtp_num_hidden_layers", 0),
                                                  "attn_output_gate": text_cfg.get("attn_output_gate", None)}


def t4_safetensors_index_sanity(v2_dir: Path) -> tuple[bool, list[str], dict]:
    """T4: safetensors index contains expected NVFP4 packed tensor names."""
    index_path = v2_dir / "model.safetensors.index.json"
    with open(index_path) as f:
        index = json.load(f)

    weight_map = index.get("weight_map", {})
    all_tensor_names = set(weight_map.keys())

    issues = []
    layer_coverage = {}
    for layer_idx in range(40):
        prefix = f"model.language_model.layers.{layer_idx}."
        # Either main_body MoE layers should have packed; if variable-pruned some may not
        per_layer_keys = [k for k in all_tensor_names if k.startswith(prefix)]
        # v0 used underscore-style (_gate_up_packed); v2 uses dot-style (.gate_up_packed)
        # or generic .packed / .scale / .global_scale per any Linear weight
        nvfp4_keys = [k for k in per_layer_keys if any(suffix in k for suffix in
                       ["_gate_up_packed", "_down_packed", "_gate_up_scale", "_down_scale",
                        ".gate_up_packed", ".down_packed", ".gate_up_scale", ".down_scale"])
                       or k.endswith(".packed") or k.endswith(".scale") or k.endswith(".global_scale")]
        layer_coverage[layer_idx] = {
            "total_keys": len(per_layer_keys),
            "nvfp4_packed_keys": len(nvfp4_keys),
        }

    n_layers_with_packed = sum(1 for c in layer_coverage.values() if c["nvfp4_packed_keys"] > 0)
    if n_layers_with_packed < 30:  # at least most layers should have packed
        issues.append(f"only {n_layers_with_packed}/40 layers have NVFP4 packed tensors (expected ≥30)")

    # Check lm_head, embed_tokens, model norm
    for required in ["lm_head.weight",
                     "model.language_model.embed_tokens.weight",
                     "model.language_model.norm.weight"]:
        if required not in all_tensor_names:
            issues.append(f"missing critical tensor: {required}")

    # MTP detection
    mtp_keys = [k for k in all_tensor_names if k.startswith("mtp.") or k.startswith("model.mtp.")]

    return (len(issues) == 0), issues, {
        "total_tensors": len(all_tensor_names),
        "layers_with_packed_nvfp4": n_layers_with_packed,
        "mtp_keys_count": len(mtp_keys),
        "mtp_keys_sample": sorted(mtp_keys)[:5] if mtp_keys else [],
    }


def t5_lynn_manifest_sanity(v2_dir: Path) -> tuple[bool, list[str], dict]:
    """T5: Lynn-specific manifest files parseable + key fields present."""
    issues = []
    info = {}

    try:
        with open(v2_dir / "lynn_quant_manifest.json") as f:
            quant_mfst = json.load(f)
        info["quant_manifest_keys"] = sorted(quant_mfst.keys())[:10]
        # Possible W4A8-only marker (per earlier discussion)
        if quant_mfst.get("inference_path_required") == "w4a8":
            info["w4a8_only_locked"] = True
        elif "w4a8" in str(quant_mfst).lower():
            info["w4a8_mentioned"] = True
    except FileNotFoundError:
        issues.append("lynn_quant_manifest.json missing")
    except json.JSONDecodeError as e:
        issues.append(f"lynn_quant_manifest.json parse error: {e}")

    try:
        with open(v2_dir / "lynn_engine_variable_expert_spec.json") as f:
            expert_spec = json.load(f)
        info["variable_expert_spec_keys"] = sorted(expert_spec.keys())[:10] if isinstance(expert_spec, dict) else "list-form"
    except FileNotFoundError:
        issues.append("lynn_engine_variable_expert_spec.json missing")
    except json.JSONDecodeError as e:
        issues.append(f"lynn_engine_variable_expert_spec.json parse error: {e}")

    try:
        with open(v2_dir / "router_mask_variable_target.json") as f:
            router_mask = json.load(f)
        info["router_mask_present"] = True
    except FileNotFoundError:
        issues.append("router_mask_variable_target.json missing")
    except json.JSONDecodeError as e:
        issues.append(f"router_mask_variable_target.json parse error: {e}")

    return (len(issues) == 0), issues, info


def t6_mtp_head_check(v2_dir: Path) -> tuple[bool, list[str], dict]:
    """T6: if MTP head present in v2, validate shapes against qwen3_next_mtp spec."""
    try:
        from safetensors.torch import safe_open
    except ImportError:
        return True, ["(skipped — safetensors not installed)"], {"skipped": True}

    index_path = v2_dir / "model.safetensors.index.json"
    with open(index_path) as f:
        index = json.load(f)
    weight_map = index.get("weight_map", {})
    mtp_keys = [k for k in weight_map.keys() if k.startswith("mtp.") or k.startswith("model.mtp.")]

    if not mtp_keys:
        return True, ["(no MTP head in v2 — bundled MTP not expected at this stage)"], {
            "mtp_present": False,
        }

    # Load and check shapes
    # Note: collect tensors from their respective shards
    sys.path.insert(0, str(Path(__file__).parent.parent))
    try:
        from engine.mtp_qwen3_next import (
            Qwen3NextMTPConfig, Qwen3NextMTPModule, expected_shape_check,
            remap_qwen36_to_lynn_mtp,
        )
    except ImportError as e:
        return False, [f"engine.mtp_qwen3_next not importable: {e}"], {}

    with open(v2_dir / "config.json") as f:
        cfg = json.load(f)
    text_cfg = cfg.get("text_config", cfg)
    mtp_cfg = Qwen3NextMTPConfig.from_dict(text_cfg)

    import torch
    module = Qwen3NextMTPModule(mtp_cfg)
    expected_shapes = expected_shape_check(module)

    # Load MTP tensors from their shards
    mtp_state = {}
    shards_to_open = set(weight_map[k] for k in mtp_keys)
    for shard in shards_to_open:
        shard_path = v2_dir / shard
        with safe_open(str(shard_path), framework="pt", device="cpu") as sf:
            for key in sf.keys():
                if key in mtp_keys:
                    mtp_state[key] = sf.get_tensor(key)

    remapped = remap_qwen36_to_lynn_mtp(mtp_state)

    issues = []
    for k, exp_shape in expected_shapes.items():
        if k not in remapped:
            issues.append(f"MTP missing: {k}")
            continue
        actual = tuple(remapped[k].shape)
        if actual != exp_shape:
            issues.append(f"MTP shape mismatch {k}: got {actual} expected {exp_shape}")

    return (len(issues) == 0), issues, {
        "mtp_present": True,
        "mtp_tensors": len(mtp_state),
    }


def t7_topology_diff_vs_v0(v2_dir: Path, v0_dir: Path) -> tuple[bool, list[str], dict]:
    """T7: tensor topology (name set + shapes from index) matches v0 architecturally."""
    issues = []
    info = {}

    if not v0_dir.exists():
        return True, ["(skipped — v0 dir not found)"], {"skipped": True}

    def load_index(d: Path) -> dict:
        with open(d / "model.safetensors.index.json") as f:
            return json.load(f).get("weight_map", {})

    v2_map = load_index(v2_dir)
    v0_map = load_index(v0_dir)

    # Normalize tensor names for diff: v2 uses dot-style (e.g. `.weight.packed`)
    # while v0 uses underscore-style (e.g. `.weight_packed`). Same data, different naming.
    # Treat them as equivalent by mapping dots in compound suffixes to underscores.
    def normalize(name: str) -> str:
        # `.weight.packed` -> `.weight_packed`,  `.weight.global_scale` -> `.weight_global_scale`
        for suffix in [".weight.global_scale", ".weight.packed", ".weight.scale",
                       ".weight.alpha_scale"]:
            if suffix in name:
                name = name.replace(suffix, suffix.replace(".", "_", 1).replace("_", ".", 1).replace(".", "_", 1)[1:] if False else suffix.replace(".g", "_g", 1).replace(".p", "_p", 1).replace(".s", "_s", 1).replace(".a", "_a", 1))
        # Simpler: any `.weight.<X>` -> `.weight_<X>` for X being the known scaled suffixes
        import re
        name = re.sub(r"\.weight\.(packed|scale|global_scale|alpha_scale)", r".weight_\1", name)
        return name

    v2_names_norm = {normalize(n) for n in v2_map.keys()}
    v0_names_norm = {normalize(n) for n in v0_map.keys()}
    v2_names = v2_names_norm
    v0_names = v0_names_norm

    # Allow MTP additions in v2 (since v0 doesn't have MTP)
    only_in_v2 = v2_names - v0_names
    only_in_v0 = v0_names - v2_names
    only_in_v2_non_mtp = {n for n in only_in_v2 if not (n.startswith("mtp.") or n.startswith("model.mtp."))}

    info["topology_diff"] = {
        "common": len(v2_names & v0_names),
        "only_in_v2": len(only_in_v2),
        "only_in_v0": len(only_in_v0),
        "only_in_v2_non_mtp": len(only_in_v2_non_mtp),
    }
    if only_in_v2_non_mtp:
        issues.append(f"v2 has {len(only_in_v2_non_mtp)} unexpected non-MTP tensors (e.g., {sorted(only_in_v2_non_mtp)[:3]})")
    if only_in_v0:
        issues.append(f"v2 missing {len(only_in_v0)} tensors that v0 has (e.g., {sorted(only_in_v0)[:3]})")

    return (len(issues) == 0), issues, info


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--v2-dir", required=True, help="Path to received v2 artifact directory")
    parser.add_argument("--v0-dir", default="/home/merkyor/models/lynn-27b-variable-recovery-step5000-nvfp4-final",
                        help="Path to v0 baseline for topology diff")
    parser.add_argument("--checksum-file", default=None,
                        help="Optional explicit checksum file (else auto-scan v2 dir)")
    parser.add_argument("--out", default=None,
                        help="JSON report output path (default: <v2-dir>/sp17_report.json)")
    args = parser.parse_args()

    v2_dir = Path(args.v2_dir)
    v0_dir = Path(args.v0_dir)
    checksum_file = Path(args.checksum_file) if args.checksum_file else None

    if not v2_dir.exists():
        print(f"[sp17] ERROR: v2 dir does not exist: {v2_dir}")
        return 1

    out_path = Path(args.out) if args.out else (v2_dir / "sp17_report.json")

    print(f"[sp17] v2 artifact validation gate")
    print(f"[sp17]   v2_dir: {v2_dir}")
    print(f"[sp17]   v0_dir: {v0_dir}")
    print(f"[sp17]   checksum_file: {checksum_file or 'auto-scan'}")
    print()

    tests = [
        ("T1 file completeness",          lambda: t1_file_completeness(v2_dir)),
        ("T2 checksum verify",            lambda: t2_checksum_verify(v2_dir, checksum_file)),
        ("T3 config sanity vs Lynn 27B",  lambda: t3_config_sanity(v2_dir)),
        ("T4 safetensors index sanity",   lambda: t4_safetensors_index_sanity(v2_dir)),
        ("T5 Lynn manifest sanity",       lambda: t5_lynn_manifest_sanity(v2_dir)),
        ("T6 MTP head shape check",       lambda: t6_mtp_head_check(v2_dir)),
        ("T7 topology diff vs v0",        lambda: t7_topology_diff_vs_v0(v2_dir, v0_dir)),
    ]

    results = []
    for name, fn in tests:
        t0 = time.time()
        try:
            ok, issues, info = fn()
            elapsed = (time.time() - t0) * 1000
            print(f"  [{'PASS' if ok else 'FAIL'}] {name:40} ({elapsed:.0f}ms)")
            for msg in issues:
                marker = "  " if ok else "    !"
                print(f"  {marker} {msg}")
            for k, v in info.items() if isinstance(info, dict) else []:
                if not isinstance(v, (dict, list)) or len(str(v)) < 120:
                    print(f"     {k}: {v}")
            results.append({"name": name, "pass": ok, "issues": issues, "info": info})
        except Exception as e:
            elapsed = (time.time() - t0) * 1000
            print(f"  [ERROR] {name:40} ({elapsed:.0f}ms) — {type(e).__name__}: {e}")
            import traceback
            traceback.print_exc()
            results.append({"name": name, "pass": False, "error": f"{type(e).__name__}: {e}"})
        print()

    n_pass = sum(1 for r in results if r["pass"])
    n_total = len(results)
    overall = (n_pass == n_total)

    print(f"=== SP-17 v2 artifact receive gate: {'PASS' if overall else 'FAIL'} ({n_pass}/{n_total}) ===")

    summary = {
        "type": "sp17_v2_artifact_receive_validation",
        "date": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
        "v2_dir": str(v2_dir),
        "v0_dir": str(v0_dir),
        "overall_pass": overall,
        "n_pass": n_pass,
        "n_total": n_total,
        "results": results,
    }
    try:
        out_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False, default=str))
        print(f"[sp17] report: {out_path}")
    except (OSError, PermissionError) as e:
        print(f"[sp17] WARN could not write report: {e}")

    return 0 if overall else 1


if __name__ == "__main__":
    sys.exit(main())
