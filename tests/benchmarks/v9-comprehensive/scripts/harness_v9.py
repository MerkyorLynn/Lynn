#!/usr/bin/env python3
"""
V9 Multi-dimension Harness
===========================
- 多 dataset 自动加载(v9/data/*.json)
- subset 字段 → verifier dispatch (math/letter)
- N=2 跑两次 · 严格(两次都对才算对)
- 增量 JSON dump
- Per §11: 题目不 print stdout

用法:
    python harness_v9.py --provider "Qwen3.6-Plus" [--data aime3.json,gpqa_physics3.json]
    python harness_v9.py --provider "GLM-5-Turbo" --all   # 跑所有 v9/data/*.json
    python harness_v9.py --provider "..." --all --runs 2   # N=2

Verifier 映射:
    math      → verifier_math (sympy)
    physics   → verifier_letter
    chemistry → verifier_letter
    biology   → verifier_letter
    longctx   → verifier_letter
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path
from collections import Counter

# verifier 路径
sys.path.insert(0, str(Path(__file__).parent.parent / "verifiers"))
from verifier_math import verify as verify_math
from verifier_letter import verify as verify_letter
from verifier_code import verify as verify_code
from verifier_sql import verify as verify_sql
from verifier_finance import verify as verify_finance

VERIFIER_DISPATCH = {
    "math": verify_math,
    "physics": verify_letter,
    "chemistry": verify_letter,
    "biology": verify_letter,
    "longctx": verify_letter,
    "academic": verify_letter,
    "medical": verify_letter,
    "code_algo": verify_code,
    "sql": verify_sql,
    "finance": verify_finance,
}

# ── 加载 ENV ──
def load_env():
    env = {}
    for path in [
        "/opt/lobster-brain/.env",
        os.path.expanduser("~/.lynn/brain.env"),
        os.path.expanduser("~/lynn-brain.env"),
    ]:
        if os.path.exists(path):
            with open(path) as f:
                for line in f:
                    s = line.strip()
                    if s and not s.startswith("#") and "=" in s:
                        k, v = s.split("=", 1)
                        env[k] = v.strip("\"'")
            print(f"[env] loaded from {path}", file=sys.stderr)
            return env
    return env


ENV = load_env()


# ── 12 家 Provider 配置 ──
PROVIDERS = [
    {
        "name": "Qwen3.6-A3B (Spark)",
        "url": os.environ.get("SPARK_URL", "http://127.0.0.1:18002/v1/chat/completions"),
        "key": None,
        "model": os.environ.get("SPARK_MODEL", "Qwen3.6-35B-A3B-FP8"),
        "max_tokens": 16384,
        "extra": {"chat_template_kwargs": {"enable_thinking": True}, "enable_thinking": True},
    },
    {
        "name": "Qwen3.6-27B (4090)",
        "url": os.environ.get("FOUR090_URL", "http://127.0.0.1:18000/v1/chat/completions"),
        "key": None,
        "model": os.environ.get("FOUR090_MODEL", "Qwen3.6-27B"),
        "max_tokens": 16384,
    },
    {
        "name": "Qwen3.6-Plus",
        "url": ENV.get("DASHSCOPE_BASE", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1") + "/chat/completions",
        "key": ENV.get("DASHSCOPE_KEY"),
        "model": "qwen3.6-plus",
        "max_tokens": 16384,
        "extra": {"enable_thinking": True},
    },
    {
        "name": "DeepSeek V4-Pro",
        "url": (ENV.get("DEEPSEEK_BASE") or "https://api.deepseek.com/v1") + "/chat/completions",
        "key": ENV.get("DEEPSEEK_KEY"),
        "model": ENV.get("DEEPSEEK_REASONER_MODEL", "deepseek-reasoner"),
        "max_tokens": 32768,
        "stream": True,
    },
    {
        "name": "DeepSeek V4-Flash",
        "url": (ENV.get("DEEPSEEK_BASE") or "https://api.deepseek.com/v1") + "/chat/completions",
        "key": ENV.get("DEEPSEEK_KEY"),
        "model": ENV.get("DEEPSEEK_MODEL", "deepseek-chat"),
        "max_tokens": 16384,
    },
    {
        "name": "Kimi K2.6",
        "url": (ENV.get("KIMI_CODING_BASE") or "https://api.kimi.com/coding/v1") + "/chat/completions",
        "key": ENV.get("KIMI_CODING_KEY"),
        "model": ENV.get("KIMI_CODING_MODEL", "kimi-for-coding"),
        "max_tokens": 16384,
        "headers_extra": {"User-Agent": "claude-cli/1.0.0"},
    },
    {
        "name": "GLM-5-Turbo",
        "url": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
        "key": ENV.get("ZHIPU_CODING_KEY") or "0785add4f2784f809fb3e59d70715d18.Iw7DrHDc2GKVxdh0",
        "model": "GLM-5-Turbo",
        "max_tokens": 16384,
    },
    {
        "name": "GLM-5.1",
        "url": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
        "key": ENV.get("ZHIPU_CODING_KEY") or "0785add4f2784f809fb3e59d70715d18.Iw7DrHDc2GKVxdh0",
        "model": "GLM-5.1",
        "max_tokens": 16384,
        "stream": False,
    },
    {
        "name": "MiniMax M2.7",
        "url": (ENV.get("MINIMAX_BASE") or "https://api.minimaxi.com/v1") + "/chat/completions",
        "key": ENV.get("MINIMAX_KEY"),
        "model": ENV.get("MINIMAX_MODEL", "minimax-m2"),
        "max_tokens": 16384,
    },
    {
        "name": "Step-3.5-Flash",
        "url": (ENV.get("STEP_BASE") or "https://api.stepfun.com/v1") + "/chat/completions",
        "key": ENV.get("STEP_KEY"),
        "model": ENV.get("STEP_TEXT_MODEL", "step-3-5-flash"),
        "max_tokens": 8192,
    },
]


# ── Prompt(题目原文不进 prompt template,直接传)──
def build_prompt(q):
    """根据 subset 调整 prompt"""
    s = q.get("subset", "math")
    if s == "math":
        return f"""Solve this math problem. Show your work and give the final answer in \\boxed{{...}}.

{q['problem']}"""
    elif s == "code_algo":
        return f"""Solve this Python coding problem. Output **only** the function implementation in a ```python``` code block. Do not include test cases or `if __name__ == "__main__"`.

{q['problem']}"""
    elif s == "sql":
        return f"""Write a SQLite SQL query to answer the question. Output **only** the SQL query in a ```sql``` code block.

{q['problem']}"""
    elif s == "finance":
        return q["problem"]  # finance prompt 已 self-contained · 含 \\boxed instruction
    else:  # 多选 letter
        return q["problem"]  # 题目里已经包含选项 + "Answer with only A/B/C/D"


def get_gold(q):
    """根据 subset 取 gold for verifier"""
    s = q.get("subset", "math")
    if s == "math":
        return f"\\boxed{{{q['answer']}}}"
    elif s == "code_algo":
        return {"tests": q.get("tests", ""), "entry_point": q.get("entry_point", ""), "prompt": q.get("problem", "")}
    elif s == "sql":
        return q.get("gold_query", "")
    elif s == "finance":
        return {"answer": q["answer"], "tolerance": q.get("tolerance", 0.01)}
    else:
        return q["answer"]  # letter


# ── 调用 ──
def call_once(p, prompt, timeout=300):
    payload = {
        "model": p["model"],
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": p.get("max_tokens", 8192),
        "temperature": 0.3,
        "stream": p.get("stream", False),
    }
    if p.get("extra"):
        payload.update(p["extra"])

    headers = {"Content-Type": "application/json"}
    if p.get("key"):
        headers["Authorization"] = f"Bearer {p['key']}"
    if p.get("headers_extra"):
        headers.update(p["headers_extra"])

    req = urllib.request.Request(p["url"], data=json.dumps(payload).encode(), headers=headers)
    t0 = time.time()

    try:
        if payload["stream"]:
            content_parts, reasoning_parts = [], []
            with urllib.request.urlopen(req, timeout=timeout) as r:
                for line in r:
                    line = line.decode("utf-8", errors="ignore").strip()
                    if not line.startswith("data:"):
                        continue
                    body = line[5:].strip()
                    if body == "[DONE]":
                        break
                    try:
                        c = json.loads(body)
                        if c.get("choices"):
                            d = c["choices"][0].get("delta", {})
                            if d.get("content"):
                                content_parts.append(d["content"])
                            if d.get("reasoning_content"):
                                reasoning_parts.append(d["reasoning_content"])
                            elif d.get("reasoning"):
                                reasoning_parts.append(d["reasoning"])
                    except Exception:
                        continue
            content = "".join(content_parts)
            reasoning = "".join(reasoning_parts)
        else:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.load(r)
            msg = data["choices"][0]["message"]
            content = msg.get("content") or ""
            reasoning = msg.get("reasoning_content") or msg.get("reasoning") or ""

        ms = round((time.time() - t0) * 1000)
        full = (reasoning + "\n\n" + content).strip() if reasoning else content
        return {"ok": True, "ms": ms, "full": full,
                "content_len": len(content), "reasoning_len": len(reasoning)}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")[:300]
        return {"ok": False, "ms": round((time.time() - t0) * 1000),
                "error": f"HTTP {e.code}: {body}"}
    except Exception as e:
        return {"ok": False, "ms": round((time.time() - t0) * 1000),
                "error": f"{type(e).__name__}: {str(e)[:200]}"}


# ── 跑单题(N runs · 严格:N 次都对才算对)──
def run_question(p, q, runs=2, timeout=300):
    runs_data = []
    for run_idx in range(runs):
        prompt = build_prompt(q)
        r = call_once(p, prompt, timeout=timeout)

        if not r["ok"]:
            runs_data.append({
                "run": run_idx, "ok": False, "verified": False,
                "ms": r.get("ms", 0), "error": r.get("error"),
                "method": None, "model_ans": None,
            })
            continue

        # Verifier dispatch
        verifier = VERIFIER_DISPATCH.get(q["subset"], verify_letter)
        gold = get_gold(q)
        vr = verifier(r["full"], gold)

        runs_data.append({
            "run": run_idx,
            "ok": True,
            "verified": vr["verified"],
            "method": vr.get("method"),
            "model_ans": vr.get("model_ans"),
            "gold_ans": vr.get("gold_ans"),
            "ms": r["ms"],
            "content_len": r["content_len"],
            "reasoning_len": r["reasoning_len"],
            "raw_full": r["full"][:8000],  # 限 8K 防 JSON 巨大
            "verify_error": vr.get("error"),
        })

    # 严格判定:所有 runs 都 verified 才算对
    all_verified = all(rd["verified"] for rd in runs_data)
    any_ok = any(rd["ok"] for rd in runs_data)

    return {
        "qid": q["qid"],
        "subset": q["subset"],
        "verified_strict": all_verified,
        "n_verified": sum(1 for rd in runs_data if rd["verified"]),
        "n_ok": sum(1 for rd in runs_data if rd["ok"]),
        "runs": runs_data,
    }


# ── Main ──
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", required=True, help="provider name")
    ap.add_argument("--data", default=None, help="comma-sep dataset filenames in v9/data/")
    ap.add_argument("--all", action="store_true", help="run all v9/data/*.json")
    ap.add_argument("--runs", type=int, default=2, help="N runs per question (strict mode)")
    ap.add_argument("--limit", type=int, default=None, help="limit questions per dataset")
    ap.add_argument("--out", default=None)
    ap.add_argument("--timeout", type=int, default=300)
    args = ap.parse_args()

    data_dir = Path(__file__).parent.parent / "data"

    # 选择 dataset
    if args.all:
        dataset_files = sorted(data_dir.glob("*.json"))
    elif args.data:
        dataset_files = [data_dir / fn.strip() for fn in args.data.split(",")]
    else:
        print("ERROR: must specify --data or --all", file=sys.stderr)
        sys.exit(1)

    # 加载所有题
    questions = []
    for fp in dataset_files:
        if not fp.exists():
            print(f"  ⚠ skip missing: {fp}")
            continue
        with open(fp) as f:
            qs = json.load(f)
        if args.limit:
            qs = qs[:args.limit]
        questions.extend(qs)
        print(f"  loaded {len(qs)} from {fp.name}")

    # 选 provider
    provider = next((p for p in PROVIDERS if p["name"] == args.provider), None)
    if not provider:
        print(f"ERROR: provider '{args.provider}' not found.", file=sys.stderr)
        print(f"Available: {[p['name'] for p in PROVIDERS]}", file=sys.stderr)
        sys.exit(1)

    # Output path
    ts = datetime.now().strftime("%Y%m%d_%H%M")
    safe_pname = args.provider.replace(" ", "_").replace("(", "").replace(")", "").replace(".", "")
    out_path = Path(args.out) if args.out else (Path(__file__).parent.parent / "results" / f"v9_{safe_pname}_{ts}.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"\nV9 Multi-dim · {len(questions)} 题 × {args.runs} runs · provider={provider['name']}")
    print(f"out: {out_path}\n")

    all_results = []
    subset_score = Counter()  # subset → n_correct
    subset_total = Counter()

    for q in questions:
        r = run_question(provider, q, runs=args.runs, timeout=args.timeout)
        all_results.append(r)

        subset_total[q["subset"]] += 1
        if r["verified_strict"]:
            subset_score[q["subset"]] += 1

        # 单题 status
        avg_ms = sum(rd.get("ms", 0) for rd in r["runs"]) // max(len(r["runs"]), 1)
        status = "✓✓" if r["verified_strict"] else (
            "✓✗" if r["n_verified"] == 1 else (
                "✗✗" if r["n_ok"] >= 1 else "💥"
            )
        )
        method_or_err = (r["runs"][0].get("method") or r["runs"][0].get("error", "")[:40] or "")[:40]
        print(f"  {status} {q['qid']:<22} {q['subset']:<11} {avg_ms:>6}ms · {method_or_err}")

        # 增量保存
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({
                "timestamp": datetime.now().isoformat(),
                "provider": provider["name"],
                "model": provider["model"],
                "runs": args.runs,
                "subset_score": dict(subset_score),
                "subset_total": dict(subset_total),
                "results": all_results,
            }, f, ensure_ascii=False, indent=2)

        time.sleep(0.5)

    # 汇总
    print(f"\n{'='*72}")
    print(f"V9 汇总 · {provider['name']} · runs={args.runs} (strict)")
    print(f"{'='*72}")
    total_correct = sum(subset_score.values())
    total_q = sum(subset_total.values())
    for subset in sorted(subset_total.keys()):
        c, t = subset_score[subset], subset_total[subset]
        pct = 100 * c / t if t else 0
        print(f"  {subset:<12} {c}/{t}  ({pct:>5.1f}%)")
    print(f"  {'TOTAL':<12} {total_correct}/{total_q}  ({100*total_correct/total_q:.1f}%)")
    print(f"\nSaved: {out_path}")


if __name__ == "__main__":
    main()
