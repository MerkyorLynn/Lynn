import json
import urllib.request
import time
import statistics

URL = "http://localhost:18099/v1/completions"

PROMPTS = [
    ("What is the capital of France?", "Paris"),
    ("List three programming languages.", "Python"),
    ("Translate to Chinese: I love machine learning.", "机器学习"),
    ("Calculate: 17 * 23 = ?", "391"),
    ("Write a Python Fibonacci function.", "def "),
]

all_pass = True
for p, must in PROMPTS:
    body = json.dumps({
        "model": "Lynn-V4-Distill-Qwen-27B-A3B-NVFP4",
        "prompt": p,
        "max_tokens": 60,
        "temperature": 0.0,
    }).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        d = json.loads(resp.read())
    if must not in d["choices"][0]["text"]:
        all_pass = False
        print(f"  QUALITY FAIL: {p} -> {d['choices'][0]['text'][:80]!r}")
print("QUALITY:", "PASS" if all_pass else "FAIL")

print("=== 128-token (3 warm + 12 measure) ===")
P = "Write a detailed essay on the future of artificial intelligence and human collaboration in scientific research."
times128, tokens128 = [], []
for i in range(15):
    body = json.dumps({
        "model": "Lynn-V4-Distill-Qwen-27B-A3B-NVFP4",
        "prompt": P,
        "max_tokens": 128,
        "temperature": 0.0,
    }).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as resp:
        d = json.loads(resp.read())
    dt = time.time() - t0
    n = d["usage"]["completion_tokens"]
    if i >= 3:
        times128.append(dt)
        tokens128.append(n)
tps128 = [n / t for n, t in zip(tokens128, times128)]
print(f"128tok TPS mean={statistics.mean(tps128):.2f} stdev={statistics.stdev(tps128):.3f} min={min(tps128):.2f} max={max(tps128):.2f}")

print()
print("=== 256-token (2 warm + 5 measure) ===")
times256, tokens256 = [], []
for i in range(7):
    body = json.dumps({
        "model": "Lynn-V4-Distill-Qwen-27B-A3B-NVFP4",
        "prompt": P,
        "max_tokens": 256,
        "temperature": 0.0,
    }).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=180) as resp:
        d = json.loads(resp.read())
    dt = time.time() - t0
    n = d["usage"]["completion_tokens"]
    if i >= 2:
        times256.append(dt)
        tokens256.append(n)
tps256 = [n / t for n, t in zip(tokens256, times256)]
print(f"256tok TPS mean={statistics.mean(tps256):.2f} stdev={statistics.stdev(tps256):.3f}")

print()
print(f"LOCKED Config D: 128tok={statistics.mean(tps128):.2f} / 256tok={statistics.mean(tps256):.2f}")

with open("/lynn-engine/reports/overnight_optim_20260517/configD_extended.json", "w") as f:
    json.dump({
        "config": "D_packed_shared_expert",
        "quality_pass": all_pass,
        "tps_128tok": {
            "mean": statistics.mean(tps128),
            "stdev": statistics.stdev(tps128),
            "min": min(tps128),
            "max": max(tps128),
            "n": len(tps128),
        },
        "tps_256tok": {
            "mean": statistics.mean(tps256),
            "stdev": statistics.stdev(tps256),
            "n": len(tps256),
        },
    }, f, indent=2)
