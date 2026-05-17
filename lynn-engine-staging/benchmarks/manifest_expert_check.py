import json

m = json.load(open("/home/merkyor/models/lynn-27b-w4a8-nvfp4-v2/lynn_quant_manifest.json"))
qt = m["quantized_tensors"]

print("=== expert quantized_tensors (mlp.experts.*) ===")
expert_keys = [k for k in qt if "mlp.experts" in k]
print(f"found {len(expert_keys)} expert tensors in v2 manifest")
print()
for k in expert_keys[:4]:
    rec = qt[k]
    print(f"key: {k}")
    print(f"  packed_key       = {rec['packed_key']}")
    print(f"  scale_key        = {rec['scale_key']}")
    print(f"  global_scale_key = {rec['global_scale_key']}")
    print(f"  original_shape   = {rec['original_shape']}")
    print()

print("=== v0 expert manifest for comparison ===")
m0 = json.load(open("/home/merkyor/models/lynn-27b-variable-recovery-step5000-nvfp4-final/lynn_quant_manifest.json"))
qt0 = m0["quantized_tensors"]
expert_keys0 = [k for k in qt0 if "mlp.experts" in k]
print(f"v0 has {len(expert_keys0)} expert quantized")
for k in expert_keys0[:4]:
    rec = qt0[k]
    print(f"key: {k}")
    print(f"  packed_key       = {rec['packed_key']}")
    print(f"  scale_key        = {rec['scale_key']}")
    print()

print("=== conclusion ===")
# Cross-check: are the v2 packed_keys actually present in v2 safetensors index?
from pathlib import Path
weight_map = json.load(open("/home/merkyor/models/lynn-27b-w4a8-nvfp4-v2/model.safetensors.index.json"))["weight_map"]
print(f"v2 safetensors index has {len(weight_map)} tensor entries")

# Check: do all packed_keys from manifest exist in weight_map?
missing_in_safetensors = []
for k, rec in qt.items():
    for kk in ("packed_key", "scale_key", "global_scale_key"):
        v = rec.get(kk)
        if v and v not in weight_map:
            missing_in_safetensors.append((k, kk, v))

if not missing_in_safetensors:
    print(f"ALL {len(qt)} quantized_tensors have packed/scale/global_scale keys present in safetensors index ✓")
else:
    print(f"MISSING in safetensors index: {len(missing_in_safetensors)} entries")
    for k, kk, v in missing_in_safetensors[:5]:
        print(f"  manifest {k}.{kk} = {v} NOT in safetensors")
