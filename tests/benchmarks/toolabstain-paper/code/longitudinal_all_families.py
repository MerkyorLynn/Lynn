#!/usr/bin/env python3
"""
ToolAbstain Longitudinal · All 6 families × 5 historical versions + Spark Qwen 35B A3B (Lynn FP8 deployment)

Total: 26 model versions × 31 questions × 1 trial = 806 calls.

Goal: locate the bump in each family that fixed the RLHF tool tax;
generalize the DeepSeek finding (V3.2→V4 +30%) across Chinese cloud LLMs.

Reuses QUESTIONS / TOOLS / score() / call_question() from harness_v1.py.
Run via OpenRouter (one key) + local SSH tunnel for Spark Qwen.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, str(Path(__file__).parent))
from harness_v1 import QUESTIONS, TOOLS, score, run_multi_turn, api_call, extract_call_info

OR_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OR_URL = "https://openrouter.ai/api/v1/chat/completions"

# 5 families × ~5 versions through OpenRouter + 1 Spark local
VERSIONS = [
    # ─ DeepSeek (skip, already done in longitudinal_deepseek.py — included for completeness)
    {"family":"DeepSeek","name":"DS-V3.1-terminus","model":"deepseek/deepseek-v3.1-terminus","released":"2025-09","via":"OR"},
    {"family":"DeepSeek","name":"DS-V3.2-exp","model":"deepseek/deepseek-v3.2-exp","released":"2025-10","via":"OR"},
    {"family":"DeepSeek","name":"DS-V3.2","model":"deepseek/deepseek-v3.2","released":"2025-12","via":"OR"},
    {"family":"DeepSeek","name":"DS-V4-Flash","model":"deepseek/deepseek-v4-flash","released":"2026-04","via":"OR"},
    {"family":"DeepSeek","name":"DS-V4-Pro","model":"deepseek/deepseek-v4-pro","released":"2026-04","via":"OR"},

    # ─ Qwen (5 OR + 1 Spark FP8 local)
    {"family":"Qwen","name":"Qwen3-Max","model":"qwen/qwen3-max","released":"2025-09","via":"OR"},
    {"family":"Qwen","name":"Qwen3.5-Plus-02-15","model":"qwen/qwen3.5-plus-02-15","released":"2025-12","via":"OR"},
    {"family":"Qwen","name":"Qwen3.5-35B-A3B","model":"qwen/qwen3.5-35b-a3b","released":"2026-02","via":"OR"},
    {"family":"Qwen","name":"Qwen3.6-27B","model":"qwen/qwen3.6-27b","released":"2026-04","via":"OR"},
    {"family":"Qwen","name":"Qwen3.6-35B-A3B(OR)","model":"qwen/qwen3.6-35b-a3b","released":"2026-04","via":"OR"},
    {"family":"Qwen","name":"Qwen3.6-35B-A3B-FP8(Spark)","model":"Qwen3.6-35B-A3B-FP8","released":"2026-04","via":"local",
     "url":"http://127.0.0.1:18002/v1/chat/completions","key":"none",
     "extra_payload":{"chat_template_kwargs":{"enable_thinking":False}}},

    # ─ GLM (Zhipu)
    {"family":"GLM","name":"GLM-4.6","model":"z-ai/glm-4.6","released":"2025-10","via":"OR"},
    {"family":"GLM","name":"GLM-4.7","model":"z-ai/glm-4.7","released":"2025-12","via":"OR"},
    {"family":"GLM","name":"GLM-5","model":"z-ai/glm-5","released":"2026-02","via":"OR"},
    {"family":"GLM","name":"GLM-5-Turbo","model":"z-ai/glm-5-turbo","released":"2026-04","via":"OR"},
    {"family":"GLM","name":"GLM-5.1","model":"z-ai/glm-5.1","released":"2026-04","via":"OR"},

    # ─ MiniMax
    {"family":"MiniMax","name":"MiniMax-M2","model":"minimax/minimax-m2","released":"2025-10","via":"OR"},
    {"family":"MiniMax","name":"MiniMax-M2.1","model":"minimax/minimax-m2.1","released":"2025-12","via":"OR"},
    {"family":"MiniMax","name":"MiniMax-M2.5","model":"minimax/minimax-m2.5","released":"2026-02","via":"OR"},
    {"family":"MiniMax","name":"MiniMax-M2.7","model":"minimax/minimax-m2.7","released":"2026-04","via":"OR"},

    # ─ Kimi (Moonshot)
    {"family":"Kimi","name":"Kimi-K2-thinking","model":"moonshotai/kimi-k2-thinking","released":"2025-11","via":"OR"},
    {"family":"Kimi","name":"Kimi-K2.5","model":"moonshotai/kimi-k2.5","released":"2026-01","via":"OR"},
    {"family":"Kimi","name":"Kimi-K2.6","model":"moonshotai/kimi-k2.6","released":"2026-04","via":"OR"},
    {"family":"Kimi","name":"Kimi-latest","model":"moonshotai/kimi-latest","released":"2026-04","via":"OR"},

    # ─ MiMo (Xiaomi)
    {"family":"MiMo","name":"MiMo-v2-flash","model":"xiaomi/mimo-v2-flash","released":"2025-12","via":"OR"},
    {"family":"MiMo","name":"MiMo-v2-pro","model":"xiaomi/mimo-v2-pro","released":"2026-01","via":"OR"},
    {"family":"MiMo","name":"MiMo-v2.5","model":"xiaomi/mimo-v2.5","released":"2026-04","via":"OR"},
    {"family":"MiMo","name":"MiMo-v2.5-pro","model":"xiaomi/mimo-v2.5-pro","released":"2026-04","via":"OR"},
]


# ────────────────────────────────────────────────────────────────────────
def call_or(version, prompt, multi_turn=False, max_turns=3, timeout=120):
    """Single-turn or multi-turn call via OpenRouter."""
    url = OR_URL
    key = OR_KEY
    extra = {}
    if version.get("via") == "local":
        url = version["url"]
        key = version["key"]
        extra = version.get("extra_payload", {})

    if multi_turn:
        prov_compat = {"url": url, "model": version["model"], "key": key, "sleep": 1.5}
        return _multi_turn_or(prov_compat, prompt, max_turns, extra)

    # single-turn
    payload = {"model": version["model"],
               "messages":[{"role":"user","content":prompt}],
               "tools": TOOLS, "tool_choice":"auto",
               "max_tokens": 600, "temperature": 0.3, "stream": False, **extra}
    headers = {"Content-Type":"application/json","Authorization":f"Bearer {key}"}
    if version.get("via") == "OR":
        headers["HTTP-Referer"] = "https://lynn.local"
        headers["X-Title"] = "ToolAbstain"
    req = urllib.request.Request(url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.load(r)
        ms = int((time.time()-t0)*1000)
        choices = d.get("choices") or []
        if not choices:
            return {"error": f"no choices: {json.dumps(d)[:200]}", "latency_ms": ms}
        msg = choices[0].get("message",{}) or {}
        info = extract_call_info(msg)
        return {"tool_calls_n": info["tool_calls_n"],
                "tool_names": info["tool_names"],
                "content_head": info["content"][:400],
                "content_len": len(info["content"]),
                "latency_ms": ms, "error": None}
    except urllib.error.HTTPError as e:
        try: body = e.read().decode("utf-8","replace")[:300]
        except: body = ""
        return {"error": f"HTTP {e.code}: {body}", "latency_ms": int((time.time()-t0)*1000)}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {str(e)[:160]}", "latency_ms": int((time.time()-t0)*1000)}


def _multi_turn_or(prov_compat, prompt, max_turns, extra_payload):
    """Multi-turn through OpenRouter — feeds fake tool results between turns."""
    from harness_v1 import FAKE_TOOL_RESULTS
    messages = [{"role":"user","content":prompt}]
    turns = []
    for turn_idx in range(max_turns):
        payload = {"model": prov_compat["model"], "messages": messages,
                   "tools": TOOLS, "tool_choice":"auto",
                   "max_tokens": 600, "temperature": 0.3, "stream": False, **extra_payload}
        headers = {"Content-Type":"application/json","Authorization":f"Bearer {prov_compat['key']}"}
        if "openrouter" in prov_compat["url"]:
            headers["HTTP-Referer"] = "https://lynn.local"
            headers["X-Title"] = "ToolAbstain"
        req = urllib.request.Request(prov_compat["url"],
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers, method="POST")
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                d = json.load(r)
            ms = int((time.time()-t0)*1000)
            choices = d.get("choices") or []
            if not choices:
                turns.append({"turn":turn_idx,"error":f"no choices","latency_ms":ms})
                break
            msg = choices[0].get("message",{}) or {}
            info = extract_call_info(msg)
            turns.append({"turn":turn_idx,"tool_calls_n":info["tool_calls_n"],
                          "tool_names":info["tool_names"],"content_head":info["content"][:300],
                          "content_len":len(info["content"]),"latency_ms":ms})
            if info["tool_calls_n"] == 0:
                break
            messages.append({"role":"assistant","content":info["content"] or "",
                             "tool_calls":info["tool_calls_raw"]})
            for tc in info["tool_calls_raw"]:
                tname = tc.get("function",{}).get("name","")
                mock = FAKE_TOOL_RESULTS.get(tname,{"ok":True})
                messages.append({"role":"tool","tool_call_id":tc.get("id","call_x"),
                                 "content":json.dumps(mock,ensure_ascii=False)})
            time.sleep(prov_compat.get("sleep",1.5))
        except urllib.error.HTTPError as e:
            try: body = e.read().decode("utf-8","replace")[:200]
            except: body = ""
            turns.append({"turn":turn_idx,"error":f"HTTP {e.code}: {body}","latency_ms":int((time.time()-t0)*1000)})
            break
        except Exception as e:
            turns.append({"turn":turn_idx,"error":f"{type(e).__name__}: {str(e)[:140]}","latency_ms":int((time.time()-t0)*1000)})
            break

    all_names, all_n = [], 0
    for t in turns:
        if t.get("error"): continue
        all_names.extend(t.get("tool_names",[]))
        all_n += t.get("tool_calls_n",0)
    last = turns[-1] if turns else {}
    return {"n_turns":len(turns),"tool_calls_n":all_n,"tool_names":all_names,
            "content_head":last.get("content_head",""),"content_len":last.get("content_len",0),
            "latency_ms":sum(t.get("latency_ms",0) for t in turns),"turns":turns,
            "error":turns[-1].get("error") if turns and turns[-1].get("error") else None}


def call_question(version, q):
    multi_turn = "multi_turn" in q.get("verifier","")
    return call_or(version, q["prompt"], multi_turn=multi_turn)


def run_version(v, n_trials=1, sleep=1.5):
    rows = []
    print(f"[start] {v['name']} ({v['model']})", flush=True)
    for q in QUESTIONS:
        for trial in range(n_trials):
            r = call_question(v, q)
            sc = score(q, r)
            rows.append({"family":v["family"],"version":v["name"],"model":v["model"],
                         "released":v["released"],"qid":q["qid"],"cat":q["cat"],"kind":q["kind"],
                         "trial":trial,**r,"scoring":sc})
            time.sleep(sleep)
    print(f"[done]  {v['name']} ({len(rows)} rows)", flush=True)
    return rows


def main():
    n_trials = int(os.environ.get("N_TRIALS","1"))
    only = set(sys.argv[1:]) if len(sys.argv) > 1 else None
    out_path = Path(__file__).parent / f"longitudinal_all_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    runners = [v for v in VERSIONS if not only or v["name"] in only or v["family"] in only]
    print(f"running {len(runners)} versions × {len(QUESTIONS)} q × {n_trials} trials = {len(runners)*len(QUESTIONS)*n_trials} calls", flush=True)

    all_rows = []
    # 6 parallel workers — OR can handle, Spark local is independent
    with ThreadPoolExecutor(max_workers=6) as ex:
        fut_map = {ex.submit(run_version, v, n_trials, 1.5 if v.get("via")=="OR" else 0.6): v for v in runners}
        for fut in as_completed(fut_map):
            try: all_rows.extend(fut.result())
            except Exception as e: print(f"[fail] {fut_map[fut]['name']}: {e}", flush=True)

    # Per-family per-cat aggregate
    fams = sorted(set(v["family"] for v in runners))
    cats = ["A","B","C","D","E","F"]
    cat_n = {c: sum(1 for q in QUESTIONS if q["cat"]==c) for c in cats}

    print(f"\n========== ToolAbstain Longitudinal · all families ==========", flush=True)
    for fam in fams:
        fam_versions = [v for v in runners if v["family"] == fam]
        print(f"\n{'─'*100}\n## {fam}\n{'─'*100}", flush=True)
        print(f"{'Version':<32} {'Released':<10} | " + "|".join(f"{c}/{cat_n[c]*n_trials}".center(8) for c in cats) + f"|{'tot/'+str(len(QUESTIONS)*n_trials):^10}|err", flush=True)
        for v in fam_versions:
            vrows = [r for r in all_rows if r["version"]==v["name"]]
            cells, tot, err = [], 0.0, 0
            for c in cats:
                rs = [r for r in vrows if r["cat"]==c]
                pts = sum((r["scoring"] or {}).get("score",0) or 0 for r in rs)
                ne  = sum(1 for r in rs if (r["scoring"] or {}).get("score") is None)
                cells.append(f"{pts:.1f}/{len(rs)}")
                tot += pts; err += ne
            print(f"{v['name']:<32} {v['released']:<10} | " + "|".join(c.center(8) for c in cells) + f"|{tot:>4.1f}/{len(QUESTIONS)*n_trials:<5}| {err}", flush=True)

    out = {"benchmark":"ToolAbstain Longitudinal All Families","ts":datetime.now().isoformat(),
           "n_trials":n_trials,"n_questions":len(QUESTIONS),
           "versions":[v["name"] for v in runners],
           "raw_rows":all_rows}
    out_path.write_text(json.dumps(out,ensure_ascii=False,indent=2))
    print(f"\n💾 saved → {out_path}", flush=True)


if __name__ == "__main__":
    main()
