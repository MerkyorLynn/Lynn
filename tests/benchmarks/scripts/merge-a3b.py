#!/usr/bin/env python3
"""合并 v3 6 模型 + A3B 单模型 → 7 模型 JSON"""
import json
import sys

v3_path = "/Users/lynn/Desktop/lynn-marketing/hard-test-v3-1050.json"
a3b_path = "/Users/lynn/Desktop/lynn-marketing/a3b-only-1109.json"
out_path = "/Users/lynn/Desktop/lynn-marketing/hard-test-v4-merged.json"

with open(v3_path) as f:
    v3 = json.load(f)
with open(a3b_path) as f:
    a3b = json.load(f)

# 把 A3B 作为第 1 个模型插入（因为它赢了）
A3B_NAME = "Qwen3.6-A3B 本地"
a3b_results = {}
for tid, r in a3b["results"].items():
    a3b_results[tid] = {
        "score": r["score"],
        "latency": r["latency"],
        "scene": r["scene"],
        "difficulty": r.get("difficulty", ""),
        "error": r["error"],
        "note": r.get("note", ""),
        "tool_calls": "",
    }

# 新顺序：A3B 第 1，其余照旧
new_models = [A3B_NAME] + v3["models"]
new_results = {A3B_NAME: a3b_results}
for m in v3["models"]:
    new_results[m] = v3["results"][m]

merged = {
    "timestamp": v3["timestamp"],
    "models": new_models,
    "tests": v3["tests"],
    "results": new_results,
    "note": "v3 + A3B 合并版（7 模型）",
}

with open(out_path, "w") as f:
    json.dump(merged, f, ensure_ascii=False, indent=2)

print(f"✅ 合并完毕: {out_path}")
print(f"模型顺序: {new_models}")
for m in new_models:
    total = sum(r["score"] for r in new_results[m].values())
    print(f"  {m}: {total}/72")
