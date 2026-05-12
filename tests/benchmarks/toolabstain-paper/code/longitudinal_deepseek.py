#!/usr/bin/env python3
"""
ToolAbstain Longitudinal · DeepSeek 6 versions via OpenRouter

Versions (oldest → newest):
  · deepseek/deepseek-v3.1-terminus     (~2025-09)
  · deepseek/deepseek-v3.2-exp          (~2025-10)
  · deepseek/deepseek-v3.2              (~2025-12)
  · deepseek/deepseek-v3.2-speciale     (~2025-12)
  · deepseek/deepseek-v4-flash          (2026-04)
  · deepseek/deepseek-v4-pro            (2026-04)

Run same 30 adversarial questions × 1 trial → 180 calls.
Goal: locate the *bump* that fixed the RLHF tool tax.
"""
import json, os, sys, time
import urllib.request, urllib.error
from datetime import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# Reuse questions + tools from adversarial v0
sys.path.insert(0, str(Path(__file__).parent))
from harness_adversarial_v0 import QUESTIONS, TOOLS, score_call, aggregate

OR_KEY = os.getenv("OPENROUTER_API_KEY", "")
OR_URL = "https://openrouter.ai/api/v1/chat/completions"

VERSIONS = [
    {"name": "DS-V3.1-terminus", "model": "deepseek/deepseek-v3.1-terminus", "released": "2025-09"},
    {"name": "DS-V3.2-exp",      "model": "deepseek/deepseek-v3.2-exp",      "released": "2025-10"},
    {"name": "DS-V3.2",          "model": "deepseek/deepseek-v3.2",          "released": "2025-12"},
    {"name": "DS-V3.2-speciale", "model": "deepseek/deepseek-v3.2-speciale", "released": "2025-12"},
    {"name": "DS-V4-Flash",      "model": "deepseek/deepseek-v4-flash",      "released": "2026-04"},
    {"name": "DS-V4-Pro",        "model": "deepseek/deepseek-v4-pro",        "released": "2026-04"},
]


def call_or(version, prompt, timeout=90):
    payload = {
        "model": version["model"], "messages":[{"role":"user","content":prompt}],
        "tools": TOOLS, "tool_choice": "auto",
        "max_tokens": 600, "temperature": 0.3, "stream": False,
    }
    req = urllib.request.Request(OR_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type":"application/json", "Authorization":f"Bearer {OR_KEY}",
                 "HTTP-Referer": "https://lynn.local", "X-Title": "ToolAbstain"},
        method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.load(r)
        ms = int((time.time()-t0)*1000)
        choices = d.get("choices") or []
        if not choices:
            return {"error": f"no choices: {json.dumps(d)[:200]}", "latency_ms": ms}
        msg = choices[0].get("message",{}) or {}
        tc = msg.get("tool_calls") or []
        return {"tool_calls_n": len(tc),
                "tool_names": [x.get("function",{}).get("name") for x in tc],
                "tool_args": [x.get("function",{}).get("arguments","")[:200] for x in tc],
                "content_len": len(msg.get("content") or ""),
                "content_head": (msg.get("content") or "")[:400],
                "latency_ms": ms, "error": None}
    except urllib.error.HTTPError as e:
        try: body = e.read().decode("utf-8","replace")[:200]
        except: body = ""
        return {"error": f"HTTP {e.code}: {body}", "latency_ms": int((time.time()-t0)*1000)}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {str(e)[:160]}", "latency_ms": int((time.time()-t0)*1000)}


def run_version(v, n_trials=1, sleep=1.5):
    rows = []
    print(f"[start] {v['name']} ({v['model']})", flush=True)
    for q in QUESTIONS:
        for trial in range(n_trials):
            r = call_or(v, q["prompt"])
            sc = score_call(q, r)
            rows.append({"provider": v["name"], "model": v["model"], "released": v["released"],
                         "qid": q["qid"], "cat": q["cat"], "kind": q["kind"],
                         "trial": trial, **r, "scoring": sc})
            time.sleep(sleep)
    print(f"[done]  {v['name']} ({len(rows)} rows)", flush=True)
    return rows


def main():
    n_trials = int(os.environ.get("N_TRIALS", "1"))
    out_dir = Path(__file__).parent
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    out_path = out_dir / f"longitudinal_deepseek_{ts}.json"

    print(f"running {len(VERSIONS)} DS versions × 30 q × {n_trials} trials = {len(VERSIONS)*30*n_trials} calls", flush=True)
    all_rows = []
    # Run sequentially to avoid OR rate limit on free tier
    for v in VERSIONS:
        try:
            rows = run_version(v, n_trials=n_trials, sleep=1.5)
            all_rows.extend(rows)
        except Exception as e:
            print(f"[fail] {v['name']}: {e}", flush=True)

    agg = aggregate(all_rows)

    # Print version-wise leaderboard
    cats = ["A","B","C","D","E"]
    print(f"\n========== DEEPSEEK LONGITUDINAL (trials={n_trials}) ==========", flush=True)
    print(f"\n{'Version':<22} {'Released':<10} | " + " | ".join(f"{c}/{6*n_trials}" for c in cats) +
          f" | total/{30*n_trials}", flush=True)
    print("-" * 100, flush=True)
    for v in VERSIONS:
        p = v["name"]
        if p not in agg: continue
        cells, tot = [], 0
        for c in cats:
            a = agg[p].get(c, {"n_pass":0,"n_trials":0})
            cells.append(f"{a['n_pass']}/{a['n_trials']}")
            tot += a["n_pass"]
        print(f"{p:<22} {v['released']:<10} | " + " | ".join(f"{c:>5}" for c in cells) +
              f" | {tot}/{30*n_trials}", flush=True)

    # Per-question version trajectory
    print(f"\n========== Per-Q trajectory (oldest → newest, ✓ = passed) ==========", flush=True)
    print(f"{'qid':<5} {'cat':<3} | " + " ".join(f"{v['name'][:13]:<13}" for v in VERSIONS), flush=True)
    print("-" * 110, flush=True)
    by_qid = {}
    for r in all_rows:
        by_qid.setdefault(r["qid"], {})[r["provider"]] = r["scoring"].get("score")
    for q in QUESTIONS:
        qid = q["qid"]
        scores = by_qid.get(qid, {})
        cells = []
        for v in VERSIONS:
            s = scores.get(v["name"])
            cells.append("    ✓        " if s == 1 else "    ✗        " if s == 0 else "    -        ")
        print(f"{qid:<5} {q['cat']:<3} | " + "".join(cells), flush=True)

    out = {"benchmark":"DeepSeek Longitudinal","ts":datetime.now().isoformat(),
           "n_trials":n_trials, "versions":[v["name"] for v in VERSIONS],
           "raw_rows": all_rows, "aggregate": agg}
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"\n💾 saved → {out_path}", flush=True)


if __name__ == "__main__":
    main()
