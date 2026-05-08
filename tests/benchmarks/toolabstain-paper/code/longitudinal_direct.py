#!/usr/bin/env python3
"""
ToolAbstain Longitudinal · Direct provider APIs (no OpenRouter credit limit)

Covers:
  · GLM 6 versions: 4.5 / 4.6 / 4.7 / 5 / 5-turbo / 5.1 (Zhipu coding paas)
  · MiniMax 4 versions: M2 / M2.1 / M2.5 / M2.7 (highspeed variants)
  · Step 3 versions: step-3 / step-3.5-flash / step-3.5-flash-2603

Total: 13 versions × 31 q × 1 trial = 403 calls. Fast (~10 min).
"""
import json, os, sys, time
import urllib.request, urllib.error
from datetime import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, str(Path(__file__).parent))
from harness_v1 import QUESTIONS, TOOLS, score, api_call, extract_call_info, run_multi_turn

ZHIPU_KEY = os.environ.get("ZHIPU_API_KEY", "")
MINIMAX_KEY = os.environ.get("MINIMAX_API_KEY", "")
STEP_KEY = os.environ.get("STEPFUN_API_KEY", "")

VERSIONS = [
    # GLM family (Zhipu coding paas v4 supports 4.5/4.6/4.7/5/5-turbo/5.1)
    {"family":"GLM","name":"GLM-4.5","model":"glm-4.5","released":"2025-09",
     "url":"https://open.bigmodel.cn/api/coding/paas/v4/chat/completions","key":ZHIPU_KEY,"sleep":0.6},
    {"family":"GLM","name":"GLM-4.6","model":"glm-4.6","released":"2025-10",
     "url":"https://open.bigmodel.cn/api/coding/paas/v4/chat/completions","key":ZHIPU_KEY,"sleep":0.6},
    {"family":"GLM","name":"GLM-4.7","model":"glm-4.7","released":"2025-12",
     "url":"https://open.bigmodel.cn/api/coding/paas/v4/chat/completions","key":ZHIPU_KEY,"sleep":0.6},
    {"family":"GLM","name":"GLM-5","model":"glm-5","released":"2026-02",
     "url":"https://open.bigmodel.cn/api/coding/paas/v4/chat/completions","key":ZHIPU_KEY,"sleep":0.6},
    {"family":"GLM","name":"GLM-5-Turbo","model":"GLM-5-Turbo","released":"2026-04",
     "url":"https://open.bigmodel.cn/api/coding/paas/v4/chat/completions","key":ZHIPU_KEY,"sleep":0.6},
    {"family":"GLM","name":"GLM-5.1","model":"GLM-5.1","released":"2026-04",
     "url":"https://open.bigmodel.cn/api/coding/paas/v4/chat/completions","key":ZHIPU_KEY,"sleep":0.6},

    # MiniMax family
    {"family":"MiniMax","name":"MiniMax-M2","model":"MiniMax-M2","released":"2025-10",
     "url":"https://api.minimaxi.com/v1/chat/completions","key":MINIMAX_KEY,"sleep":1.0},
    {"family":"MiniMax","name":"MiniMax-M2.1","model":"MiniMax-M2.1-highspeed","released":"2025-12",
     "url":"https://api.minimaxi.com/v1/chat/completions","key":MINIMAX_KEY,"sleep":1.0},
    {"family":"MiniMax","name":"MiniMax-M2.5","model":"MiniMax-M2.5-highspeed","released":"2026-02",
     "url":"https://api.minimaxi.com/v1/chat/completions","key":MINIMAX_KEY,"sleep":1.0},
    {"family":"MiniMax","name":"MiniMax-M2.7","model":"MiniMax-M2.7-highspeed","released":"2026-04",
     "url":"https://api.minimaxi.com/v1/chat/completions","key":MINIMAX_KEY,"sleep":1.0},

    # Step family
    {"family":"Step","name":"step-3","model":"step-3","released":"2025-Q3",
     "url":"https://api.stepfun.com/v1/chat/completions","key":STEP_KEY,"sleep":3.0},
    {"family":"Step","name":"step-3.5-flash","model":"step-3.5-flash","released":"2026-04",
     "url":"https://api.stepfun.com/v1/chat/completions","key":STEP_KEY,"sleep":3.0},
    {"family":"Step","name":"step-3.5-flash-2603","model":"step-3.5-flash-2603","released":"2026-03",
     "url":"https://api.stepfun.com/v1/chat/completions","key":STEP_KEY,"sleep":3.0},
]


def call_q(version, q):
    multi_turn = "multi_turn" in q.get("verifier","")
    prov_compat = {"url":version["url"], "model":version["model"], "key":version["key"], "sleep":version["sleep"]}
    if multi_turn:
        return run_multi_turn(prov_compat, q["prompt"], max_turns=3)
    res = api_call(prov_compat, [{"role":"user","content":q["prompt"]}])
    if res.get("error"):
        return {"error":res["error"], "latency_ms":res.get("latency_ms")}
    info = extract_call_info(res["raw_msg"])
    return {"tool_calls_n":info["tool_calls_n"],"tool_names":info["tool_names"],
            "content_head":info["content"][:400],"content_len":len(info["content"]),
            "latency_ms":res["latency_ms"],"error":None}


def run_version(v, n_trials=1):
    rows = []
    print(f"[start] {v['name']}", flush=True)
    for q in QUESTIONS:
        for trial in range(n_trials):
            r = call_q(v, q)
            sc = score(q, r)
            rows.append({"family":v["family"],"version":v["name"],"model":v["model"],
                         "released":v["released"],"qid":q["qid"],"cat":q["cat"],"kind":q["kind"],
                         "trial":trial,**r,"scoring":sc})
            time.sleep(v["sleep"])
    print(f"[done]  {v['name']} ({len(rows)} rows)", flush=True)
    return rows


def main():
    n_trials = int(os.environ.get("N_TRIALS","1"))
    out_path = Path(__file__).parent / f"longitudinal_direct_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    runners = VERSIONS
    print(f"running {len(runners)} versions × {len(QUESTIONS)} q × {n_trials} trials = {len(runners)*len(QUESTIONS)*n_trials} calls", flush=True)

    all_rows = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        fut_map = {ex.submit(run_version, v, n_trials): v for v in runners}
        for fut in as_completed(fut_map):
            try: all_rows.extend(fut.result())
            except Exception as e: print(f"[fail] {fut_map[fut]['name']}: {e}", flush=True)

    fams = sorted(set(v["family"] for v in runners))
    cats = ["A","B","C","D","E","F"]
    cat_n = {c: sum(1 for q in QUESTIONS if q["cat"]==c) for c in cats}

    print(f"\n========== Direct-API Longitudinal · GLM / MiniMax / Step ==========", flush=True)
    for fam in fams:
        fam_versions = [v for v in runners if v["family"] == fam]
        print(f"\n## {fam}", flush=True)
        print(f"{'Version':<28} {'Released':<10} | " + "|".join(f"{c}/{cat_n[c]*n_trials}".center(8) for c in cats) + f"|{'tot/'+str(len(QUESTIONS)*n_trials):^10}|err", flush=True)
        for v in fam_versions:
            vrows = [r for r in all_rows if r["version"]==v["name"]]
            cells, tot, err = [], 0.0, 0
            for c in cats:
                rs = [r for r in vrows if r["cat"]==c]
                pts = sum((r["scoring"] or {}).get("score",0) or 0 for r in rs)
                ne  = sum(1 for r in rs if (r["scoring"] or {}).get("score") is None)
                cells.append(f"{pts:.1f}/{len(rs)}")
                tot += pts; err += ne
            print(f"{v['name']:<28} {v['released']:<10} | " + "|".join(c.center(8) for c in cells) + f"|{tot:>4.1f}/{len(QUESTIONS)*n_trials:<5}| {err}", flush=True)

    out = {"benchmark":"ToolAbstain Direct-API Longitudinal","ts":datetime.now().isoformat(),
           "n_trials":n_trials,"versions":[v["name"] for v in runners],"raw_rows":all_rows}
    out_path.write_text(json.dumps(out,ensure_ascii=False,indent=2))
    print(f"\n💾 saved → {out_path}", flush=True)


if __name__ == "__main__":
    main()
