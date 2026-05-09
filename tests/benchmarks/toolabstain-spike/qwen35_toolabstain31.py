#!/usr/bin/env python3
"""
ToolAbstain · Qwen 3.5-35B-A3B on ToolAbstain-31

Apples-to-apples for the issue #5 follow-up: get Qwen 3.5 score on the SAME
31-question ToolAbstain-31 we used for Qwen 3.6-FP8 (Spark) → 29/31 = 94%.

SiliconFlow `Qwen/Qwen3.5-35B-A3B` × N=2 trials × 31 questions × multi-turn.
"""
import sys
from pathlib import Path

# Reuse harness_v1 questions, tools, scoring, multi-turn logic
sys.path.insert(0, str(Path(__file__).parent))
from harness_v1 import (
    QUESTIONS, TOOLS, score, api_call, extract_call_info,
    run_multi_turn, FAKE_TOOL_RESULTS,
)

import json, os, time
from datetime import datetime


PROV = {
    "name": "Qwen3.5-35B-A3B-SiliconFlow",
    "url": "https://api.siliconflow.cn/v1/chat/completions",
    "model": "Qwen/Qwen3.5-35B-A3B",
    "key": os.environ["SILICONFLOW_KEY"],
    "sleep": 0.5,
}


def call_question(q):
    multi_turn = "multi_turn" in q.get("verifier", "")
    if multi_turn:
        return run_multi_turn(PROV, q["prompt"], max_turns=3)
    res = api_call(PROV, [{"role": "user", "content": q["prompt"]}])
    if res.get("error"):
        return {"error": res["error"], "latency_ms": res.get("latency_ms")}
    info = extract_call_info(res["raw_msg"])
    return {
        "tool_calls_n": info["tool_calls_n"],
        "tool_names": info["tool_names"],
        "content_head": info["content"][:400],
        "content_len": len(info["content"]),
        "latency_ms": res["latency_ms"],
        "error": None,
    }


def main():
    n_trials = int(os.environ.get("N_TRIALS", "2"))
    rows = []

    print(f"⚙️  Qwen 3.5-35B-A3B on ToolAbstain-31 via SiliconFlow")
    print(f"   {len(QUESTIONS)} questions × {n_trials} trials = {len(QUESTIONS) * n_trials} calls")

    for trial in range(n_trials):
        print(f"\n=== trial {trial+1}/{n_trials} ===", flush=True)
        for q in QUESTIONS:
            r = call_question(q)
            sc = score(q, r)
            rec = {
                "trial": trial,
                "qid": q["qid"],
                "cat": q["cat"],
                "kind": q["kind"],
                **r,
                "scoring": sc,
            }
            rows.append(rec)

            tag = "🛠" if r.get("tool_calls_n", 0) > 0 else "📝" if r.get("content_len", 0) else "❌"
            tn = ",".join(r.get("tool_names", []) or [])
            err = f" [{r.get('error', '')[:50]}]" if r.get("error") else ""
            sc_str = f"score={sc.get('score')}" if sc else ""
            print(
                f"  {q['qid']:5s} {tag} tc={r.get('tool_calls_n','?')} {sc_str:<10} [{tn}]{err}",
                flush=True,
            )
            time.sleep(PROV["sleep"])

    # Aggregate
    cats = ["A", "B", "C", "D", "E", "F"]
    cat_n = {c: sum(1 for q in QUESTIONS if q["cat"] == c) for c in cats}

    print(f"\n\n{'=' * 95}\nQwen 3.5-35B-A3B · ToolAbstain-31 result · N={n_trials} trials\n{'=' * 95}")
    print(f"\n{'Cat':<5} | {'pass/total':<14} | {'rate':<8}")
    print("-" * 45)
    total_pts = 0
    total_n = 0
    for c in cats:
        rs = [r for r in rows if r["cat"] == c]
        pts = sum((r["scoring"] or {}).get("score", 0) or 0 for r in rs)
        n = len(rs)
        total_pts += pts
        total_n += n
        if n:
            print(f"{c:<5} | {pts:.1f}/{n:<10} | {pts / n:.1%}")
    print("-" * 45)
    print(f"{'TOTAL':<5} | {total_pts:.1f}/{total_n:<10} | {total_pts / max(total_n, 1):.1%}")

    # Per-question breakdown
    print(f"\n{'qid':<6} {'cat':<3} {'kind':<10} {'pass/N':<10} status")
    print("-" * 50)
    for q in QUESTIONS:
        rs = [r for r in rows if r["qid"] == q["qid"]]
        scs = [(r["scoring"] or {}).get("score") for r in rs]
        passed = sum(s for s in scs if s is not None and s > 0)
        total = sum(1 for s in scs if s is not None)
        rate = passed / max(total, 1) if total else 0
        bar = "█" * int(rate * 10)
        print(f"{q['qid']:<6} {q['cat']:<3} {q['kind']:<10} {passed:.1f}/{total:<8} {bar}")

    # Compare with Qwen 3.6-FP8 Spark known result
    print(f"\n\n=== Side-by-side vs Qwen 3.6-35B-A3B-FP8 (Spark) on same ToolAbstain-31 ===")
    print(f"  Qwen 3.5-35B-A3B (SiliconFlow):           {total_pts:.1f}/{total_n} ({total_pts / max(total_n, 1):.1%})")
    print(f"  Qwen 3.6-35B-A3B-FP8 (Lynn Spark vLLM):   29.0/31 (93.5%)   [from longitudinal_all_20260508]")
    delta = total_pts / max(total_n, 1) - 29.0 / 31
    print(f"  Δ:  {delta * 100:+.1f} pp")

    # Save
    out = (
        Path(__file__).parent
        / f"qwen35_toolabstain31_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    )
    out.write_text(
        json.dumps(
            {
                "ts": datetime.now().isoformat(),
                "model": PROV["model"],
                "n_trials": n_trials,
                "n_questions": len(QUESTIONS),
                "raw": rows,
                "total_pts": total_pts,
                "total_n": total_n,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    print(f"\n💾 saved → {out}")


if __name__ == "__main__":
    main()
