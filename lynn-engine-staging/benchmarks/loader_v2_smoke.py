"""Verify Spark Lynn engine loader can actually load v2 layer-0 weights end-to-end.
Real load test (not just manifest check)."""
import sys
sys.path.insert(0, "/lynn-engine")

import time
import torch

# Container path mount: /home/merkyor/models -> /models
V2_DIR = "/models/lynn-27b-w4a8-nvfp4-v2"
V0_DIR = "/models/lynn-27b-variable-recovery-step5000-nvfp4-final"


def smoke_layer_load(model_dir: str, label: str):
    print(f"=== {label} ===")
    print(f"  dir: {model_dir}")
    from engine.loader import load_qwen36_layer

    t0 = time.time()
    try:
        weights, config = load_qwen36_layer(
            model_dir,
            layer_idx=0,
            num_experts=256,
            device="cuda",
            dequant_dtype=torch.bfloat16,
        )
        ok = True
    except Exception as e:
        print(f"  EXCEPTION: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return False, None, None

    elapsed = time.time() - t0
    n_tensors = len(weights)
    total_bytes = sum(t.element_size() * t.numel() for t in weights.values() if isinstance(t, torch.Tensor))
    print(f"  load OK in {elapsed:.2f}s")
    print(f"  n_tensors: {n_tensors}")
    print(f"  total bytes: {total_bytes/1e9:.3f} GB")
    print(f"  config: {config}")
    # Print sample shapes
    print(f"  sample tensors:")
    for i, (k, t) in enumerate(weights.items()):
        if i >= 4:
            break
        if isinstance(t, torch.Tensor):
            print(f"    {k}: shape={tuple(t.shape)} dtype={t.dtype}")
    return True, n_tensors, total_bytes


def main():
    # Load v0 layer 0 first (baseline)
    ok0, n0, b0 = smoke_layer_load(V0_DIR, "v0 layer 0")
    print()
    # Load v2 layer 0
    ok2, n2, b2 = smoke_layer_load(V2_DIR, "v2 layer 0")
    print()
    print("=== VERDICT ===")
    if ok0 and ok2:
        print(f"  v0 load: OK ({n0} tensors, {b0/1e9:.2f} GB)")
        print(f"  v2 load: OK ({n2} tensors, {b2/1e9:.2f} GB)")
        if abs(n2 - n0) <= 2 and abs(b2 - b0) / max(b0, 1) < 0.10:
            print("  TASK C VERDICT: GREEN — Spark loader handles v2 transparently")
        else:
            print(f"  TASK C VERDICT: PASS but {n2} vs {n0} tensors / {b2/1e9:.2f} vs {b0/1e9:.2f} GB — review")
    elif ok0 and not ok2:
        print("  v0 OK, v2 FAILED → loader has v2 compat bug")
    elif not ok0:
        print("  v0 FAILED too → loader env broken, not a v2 issue")


if __name__ == "__main__":
    main()
