#!/usr/bin/env python3
"""
Re-verify V9 code_algo subset using existing raw_full (numpy 装好后).
读 batch dir 下所有 v9_*.json,重判 humaneval 题,更新 results.json + subset_score.
"""
import json
import sys
from pathlib import Path

V9_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(V9_ROOT / "verifiers"))
from verifier_code import verify as verify_code

DATA_DIR = V9_ROOT / "data"
HUMANEVAL = json.loads((DATA_DIR / "humaneval3.json").read_text())
GOLD_BY_QID = {q["qid"]: {"tests": q.get("tests", ""), "entry_point": q.get("entry_point", ""), "prompt": q.get("problem", "")} for q in HUMANEVAL}

def revalidate_file(fp: Path):
    data = json.loads(fp.read_text())
    fixed = 0
    for r in data.get("results", []):
        if r.get("subset") != "code_algo":
            continue
        qid = r["qid"]
        gold = GOLD_BY_QID.get(qid)
        if not gold:
            continue
        for run in r.get("runs", []):
            if not run.get("ok"):
                continue
            raw = run.get("raw_full", "")
            if not raw:
                continue
            vr = verify_code(raw, gold)
            old = run.get("verified")
            new = vr["verified"]
            run["verified"] = new
            run["method"] = vr.get("method")
            run["model_ans"] = vr.get("model_ans")
            run["verify_error"] = vr.get("error")
            if old != new:
                fixed += 1
        # 重新算 verified_strict
        r["verified_strict"] = all(rd.get("verified") for rd in r.get("runs", []))
        r["n_verified"] = sum(1 for rd in r.get("runs", []) if rd.get("verified"))
    # 重算 subset_score
    sc = {}
    for r in data.get("results", []):
        if r["verified_strict"]:
            sc[r["subset"]] = sc.get(r["subset"], 0) + 1
    data["subset_score"] = sc
    fp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    return fixed

def main():
    if len(sys.argv) < 2:
        print(f"usage: {sys.argv[0]} <batch_dir>")
        sys.exit(1)
    batch = Path(sys.argv[1])
    total_fixed = 0
    for fp in sorted(batch.glob("v9_*.json")):
        n = revalidate_file(fp)
        print(f"  {fp.name}: {n} runs flipped")
        total_fixed += n
    print(f"Total flipped: {total_fixed}")

if __name__ == "__main__":
    main()
