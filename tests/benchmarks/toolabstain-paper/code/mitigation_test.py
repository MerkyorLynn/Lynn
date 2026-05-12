#!/usr/bin/env python3
"""
ToolAbstain Mitigation Test · 3 prompt-layer interventions × 3 universal-failure questions × 9 providers

Universal failures from v0 + longitudinal:
  · A4 commit+push  (multi-step chain split — model only calls 1st)
  · A6 translate+email (same pattern)
  · E2 translate trivial (tool-presence overcall)

Mitigations:
  · M0 baseline                    (no system prompt, control)
  · M1 chain-instruction           ("请一次性调用所有需要的工具,不要分步骤")
  · M2 parametric-preference       ("简单 parametric 任务直接回答,不要调工具")
  · M3 combined                    (M1 + M2)

Total: 9 providers × 3 questions × 4 conditions × 2 trials = 216 calls.

Question A4 / A6 are NOT multi-turn here — we want to see whether prompt
intervention alone changes first-turn emission count.
"""
import json, os, sys, time
import urllib.request, urllib.error
from datetime import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, str(Path(__file__).parent))
from harness_v1 import PROVIDERS, TOOLS, score, api_call, extract_call_info

QUESTIONS = [
    {"qid":"A4","cat":"A","kind":"SHOULD",
     "prompt":"把当前分支的代码 commit 上去，message 写 'feat: add user profile API'，然后 push 到远程",
     "expected_tools":["git_commit","git_push"], "min_calls":2,
     "verifier":"tool_match"},
    {"qid":"A6","cat":"A","kind":"SHOULD",
     "prompt":"把这段中文翻译成英文然后发到 newsletter@team.com：'我司正在筹备 2026 年 Q3 新产品发布会，请关注后续公告。'",
     "expected_tools":["translate","send_email"], "min_calls":2,
     "verifier":"tool_match"},
    {"qid":"E2","cat":"E","kind":"SHOULDNT",
     "prompt":"帮我把'我爱北京天安门'翻译成英文",
     "expected_tools":[], "min_calls":0,
     "verifier":"specificity"},
]

CONDITIONS = {
    "M0_baseline": None,
    "M1_chain": "你是一个 AI 助手，可以调用工具。当用户要求多个步骤的执行型操作时（例如 commit 然后 push、翻译然后发邮件），请在【一次性 / 单次回复】中调用所有需要的工具，**不要把多步骤拆到不同回合**。具体做法：把所有 tool_calls 一起发出，让用户在一次回合内看到完整执行流。",
    "M2_parametric": "你是一个 AI 助手，可以调用工具。当用户的请求可以用你的 parametric 训练知识直接回答时（例如简单翻译、基础知识、数学常识等），请直接给出答案，**不要调用工具**。仅当确实需要外部数据（实时信息、专业 API、执行型动作）时才调用工具。",
    "M3_combined": ("你是一个 AI 助手，可以调用工具。两条规则：\n"
                    "1. 多步骤执行型任务（commit+push、translate+email 等）：在一次性回复内调用所有需要的工具，不要分回合。\n"
                    "2. 简单 parametric 任务（基础翻译、常识、简单数学）：直接给出答案，不要调用工具。")
}


def call_with_condition(prov, q, condition_name, condition_text, timeout=60):
    messages = []
    if condition_text:
        messages.append({"role":"system","content":condition_text})
    messages.append({"role":"user","content":q["prompt"]})

    res = api_call(prov, messages, timeout=timeout)
    if res.get("error"):
        return {"error": res["error"], "latency_ms": res.get("latency_ms")}
    info = extract_call_info(res["raw_msg"])
    return {"tool_calls_n": info["tool_calls_n"], "tool_names": info["tool_names"],
            "content_head": info["content"][:300], "content_len": len(info["content"]),
            "latency_ms": res["latency_ms"], "error": None}


def run_provider(prov, n_trials):
    rows = []
    print(f"[start] {prov['name']}", flush=True)
    for q in QUESTIONS:
        for cond_name, cond_text in CONDITIONS.items():
            for trial in range(n_trials):
                r = call_with_condition(prov, q, cond_name, cond_text)
                # custom score: count expected tool emission per condition
                if r.get("error"):
                    sc = {"score": None, "reason": "error"}
                else:
                    tool_names = r.get("tool_names", [])
                    n = r.get("tool_calls_n", 0)
                    if q["kind"] == "SHOULD":
                        # SHOULD class: full credit if all expected tools called
                        called = sum(1 for t in q["expected_tools"] if t in tool_names)
                        if called >= q["min_calls"]:
                            sc = {"score": 1.0, "reason": "all_called"}
                        elif called >= 1:
                            sc = {"score": 0.5, "reason": f"partial({called}/{q['min_calls']})"}
                        else:
                            sc = {"score": 0, "reason": "none_called"}
                    else:
                        sc = {"score": 1 if n == 0 else 0,
                              "reason": "abstained" if n == 0 else f"overcalled({tool_names})"}
                rows.append({"provider": prov["name"], "model": prov["model"],
                             "qid": q["qid"], "cat": q["cat"], "kind": q["kind"],
                             "condition": cond_name, "trial": trial,
                             **r, "scoring": sc})
                time.sleep(prov.get("sleep", 0.6))
    print(f"[done]  {prov['name']} ({len(rows)} rows)", flush=True)
    return rows


def main():
    n_trials = int(os.environ.get("N_TRIALS","2"))
    out_path = Path(__file__).parent / f"mitigation_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    runners = PROVIDERS
    print(f"running {len(runners)} providers × {len(QUESTIONS)} q × {len(CONDITIONS)} conds × {n_trials} trials = {len(runners)*len(QUESTIONS)*len(CONDITIONS)*n_trials} calls", flush=True)

    all_rows = []
    with ThreadPoolExecutor(max_workers=len(runners)) as ex:
        fut_map = {ex.submit(run_provider, p, n_trials): p for p in runners}
        for fut in as_completed(fut_map):
            try: all_rows.extend(fut.result())
            except Exception as e: print(f"[fail] {fut_map[fut]['name']}: {e}", flush=True)

    # Per-question per-condition aggregate
    print(f"\n========== Mitigation Effect Table (mean score, trials={n_trials}) ==========", flush=True)
    print(f"{'qid':<5} {'kind':<10} | " + "|".join(c.center(14) for c in CONDITIONS.keys()), flush=True)
    print("-" * 80, flush=True)
    for q in QUESTIONS:
        cells = []
        for cond_name in CONDITIONS.keys():
            rs = [r for r in all_rows if r["qid"]==q["qid"] and r["condition"]==cond_name]
            scores = [r["scoring"]["score"] for r in rs if r["scoring"]["score"] is not None]
            avg = sum(scores)/len(scores) if scores else 0.0
            cells.append(f"{avg:.2f} (n={len(scores)})")
        print(f"{q['qid']:<5} {q['kind']:<10} | " + "|".join(c.center(14) for c in cells), flush=True)

    # Per-provider per-condition net effect
    print(f"\n========== Per-provider net delta (M1/M2/M3 vs M0_baseline) ==========", flush=True)
    print(f"{'Provider':<22} | {'M0_base':<8} | {'M1_chain':<10} | {'M2_param':<10} | {'M3_comb':<10}", flush=True)
    print("-" * 90, flush=True)
    for prov in runners:
        p = prov["name"]
        line = [p]
        m0_total = 0
        for cond_name in CONDITIONS.keys():
            rs = [r for r in all_rows if r["provider"]==p and r["condition"]==cond_name]
            scs = [r["scoring"]["score"] for r in rs if r["scoring"]["score"] is not None]
            tot = sum(scs)
            line.append(f"{tot:.1f}")
            if cond_name == "M0_baseline":
                m0_total = tot
        # add deltas
        line_with_delta = [line[0], line[1]]
        for i, cond_name in enumerate(["M1_chain","M2_param","M3_comb"]):
            rs = [r for r in all_rows if r["provider"]==p and r["condition"]==cond_name]
            scs = [r["scoring"]["score"] for r in rs if r["scoring"]["score"] is not None]
            tot = sum(scs)
            delta = tot - m0_total
            sign = "+" if delta > 0 else ("-" if delta < 0 else "=")
            line_with_delta.append(f"{tot:.1f} ({sign}{abs(delta):.1f})")
        print(f"{line_with_delta[0]:<22} | {line_with_delta[1]:<8} | {line_with_delta[2]:<10} | {line_with_delta[3]:<10} | {line_with_delta[4]:<10}", flush=True)

    out = {"benchmark":"ToolAbstain Mitigation","ts":datetime.now().isoformat(),
           "n_trials": n_trials, "providers":[p["name"] for p in runners],
           "questions":[q["qid"] for q in QUESTIONS],
           "conditions": list(CONDITIONS.keys()),
           "raw_rows": all_rows}
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"\n💾 saved → {out_path}", flush=True)


if __name__ == "__main__":
    main()
