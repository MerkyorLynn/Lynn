#!/usr/bin/env python3
"""V9 Gemini Native API harness (走 Google AI Studio API key,支持 3.x preview)"""
import argparse, json, os, sys, time
import urllib.request, urllib.error
from datetime import datetime
from pathlib import Path
from collections import Counter

sys.path.insert(0, str(Path(__file__).parent.parent / "verifiers"))
from verifier_math import verify as verify_math
from verifier_letter import verify as verify_letter
from verifier_code import verify as verify_code
from verifier_sql import verify as verify_sql
from verifier_finance import verify as verify_finance

VERIFIER_DISPATCH = {
    "math": verify_math,
    "physics": verify_letter, "chemistry": verify_letter, "biology": verify_letter,
    "longctx": verify_letter, "academic": verify_letter, "medical": verify_letter,
    "code_algo": verify_code, "sql": verify_sql, "finance": verify_finance,
}

API_KEY = os.environ.get("GEMINI_API_KEY", "")
if not API_KEY:
    raise SystemExit("GEMINI_API_KEY is required; refusing to run without an explicit environment variable.")


def build_prompt(q):
    s = q.get("subset", "math")
    if s == "math":
        return f"Solve this math problem. Show your work and give the final answer in \\boxed{{...}}.\n\n{q['problem']}"
    elif s == "code_algo":
        return f"Solve this Python coding problem. Output **only** the function implementation in a ```python``` code block.\n\n{q['problem']}"
    elif s == "sql":
        return f"Write a SQLite SQL query. Output **only** the SQL in a ```sql``` code block.\n\n{q['problem']}"
    else:
        return q["problem"]


def get_gold(q):
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
        return q["answer"]


def call_gemini(model: str, prompt: str, timeout: int = 240) -> dict:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}"
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 16384},
    }
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                  headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        data = json.load(resp)
        cands = data.get("candidates") or []
        if not cands:
            return {"ok": False, "ms": round((time.time() - t0) * 1000),
                    "error": f"no candidates: {json.dumps(data)[:200]}"}
        parts = cands[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts)
        return {"ok": True, "ms": round((time.time() - t0) * 1000), "text": text}
    except urllib.error.HTTPError as e:
        return {"ok": False, "ms": round((time.time() - t0) * 1000),
                "error": f"HTTP {e.code}: {e.read().decode()[:200]}"}
    except Exception as e:
        return {"ok": False, "ms": round((time.time() - t0) * 1000),
                "error": f"{type(e).__name__}: {str(e)[:200]}"}


def run_question(model, q, runs=1, timeout=240):
    runs_data = []
    for i in range(runs):
        prompt = build_prompt(q)
        r = call_gemini(model, prompt, timeout=timeout)
        if not r["ok"]:
            runs_data.append({"run": i, "ok": False, "verified": False,
                              "ms": r.get("ms", 0), "error": r.get("error"),
                              "method": None, "model_ans": None})
            continue
        verifier = VERIFIER_DISPATCH.get(q["subset"], verify_letter)
        gold = get_gold(q)
        vr = verifier(r["text"], gold)
        runs_data.append({
            "run": i, "ok": True, "verified": vr["verified"],
            "method": vr.get("method"), "model_ans": vr.get("model_ans"),
            "gold_ans": vr.get("gold_ans"), "ms": r["ms"],
            "content_len": len(r["text"]), "reasoning_len": 0,
            "raw_full": r["text"][:8000],
            "verify_error": vr.get("error"),
        })
    return {
        "qid": q["qid"], "subset": q["subset"],
        "verified_strict": all(rd["verified"] for rd in runs_data),
        "n_verified": sum(1 for rd in runs_data if rd["verified"]),
        "n_ok": sum(1 for rd in runs_data if rd["ok"]),
        "runs": runs_data,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--data", default=None)
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--timeout", type=int, default=240)
    ap.add_argument("--out", default=None)
    ap.add_argument("--name", default=None, help="display provider name")
    args = ap.parse_args()

    data_dir = Path(__file__).parent.parent / "data"
    if args.all:
        dataset_files = sorted(data_dir.glob("*.json"))
    elif args.data:
        dataset_files = [data_dir / fn.strip() for fn in args.data.split(",")]
    else:
        names = ["aime3.json", "gpqa_physics3.json", "gpqa_chemistry3.json",
                 "gpqa_biology3.json", "longbench3.json",
                 "humaneval3.json", "spider3.json", "medqa3.json", "finance3.json"]
        dataset_files = [data_dir / n for n in names]

    questions = []
    for fp in dataset_files:
        if not fp.exists():
            continue
        with open(fp) as f:
            qs = json.load(f)
        questions.extend(qs)
        print(f"  loaded {len(qs)} from {fp.name}")

    pname = args.name or args.model
    print(f"\nV9 Gemini API · {len(questions)} 题 · model={args.model} · name={pname}")

    ts = datetime.now().strftime("%Y%m%d_%H%M")
    safe = pname.replace(" ", "_").replace(".", "").replace("/", "_")
    out_path = Path(args.out) if args.out else (Path(__file__).parent.parent / "results" / f"v9_{safe}_{ts}.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"out: {out_path}\n")

    all_results = []
    subset_score = Counter()
    subset_total = Counter()

    for q in questions:
        r = run_question(args.model, q, runs=args.runs, timeout=args.timeout)
        all_results.append(r)
        subset_total[q["subset"]] += 1
        if r["verified_strict"]:
            subset_score[q["subset"]] += 1

        avg_ms = sum(rd.get("ms", 0) for rd in r["runs"]) // max(len(r["runs"]), 1)
        status = "✓✓" if r["verified_strict"] else (
            "✓✗" if r["n_verified"] == 1 else (
                "✗✗" if r["n_ok"] >= 1 else "💥"))
        method_or_err = (r["runs"][0].get("method") or r["runs"][0].get("error", "")[:40] or "")[:40]
        print(f"  {status} {q['qid']:<22} {q['subset']:<11} {avg_ms:>6}ms · {method_or_err}")

        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({
                "timestamp": datetime.now().isoformat(),
                "provider": pname, "model": args.model, "runs": args.runs,
                "subset_score": dict(subset_score),
                "subset_total": dict(subset_total),
                "results": all_results,
            }, f, ensure_ascii=False, indent=2)
        time.sleep(0.5)

    print(f"\n{'='*72}")
    total_correct = sum(subset_score.values())
    total_q = sum(subset_total.values())
    for subset in sorted(subset_total.keys()):
        c, t = subset_score[subset], subset_total[subset]
        print(f"  {subset:<12} {c}/{t}  ({100*c/t if t else 0:>5.1f}%)")
    print(f"  TOTAL        {total_correct}/{total_q}  ({100*total_correct/total_q:.1f}%)")


if __name__ == "__main__":
    main()
