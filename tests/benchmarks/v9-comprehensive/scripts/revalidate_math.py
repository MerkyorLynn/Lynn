#!/usr/bin/env python3
"""Re-verify V9 math subset using updated verifier_math (tail-number fallback)."""
import json, sys
from pathlib import Path

V9_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(V9_ROOT / "verifiers"))
from verifier_math import verify as verify_math

DATA_DIR = V9_ROOT / "data"
AIME = json.loads((DATA_DIR / "aime3.json").read_text())
GOLD_BY_QID = {q["qid"]: f"\\boxed{{{q['answer']}}}" for q in AIME}

def revalidate_file(fp: Path):
    data = json.loads(fp.read_text())
    fixed = 0
    for r in data.get("results", []):
        if r.get("subset") != "math":
            continue
        gold = GOLD_BY_QID.get(r["qid"])
        if not gold:
            continue
        for run in r.get("runs", []):
            if not run.get("ok"):
                continue
            raw = run.get("raw_full", "")
            if not raw:
                continue
            vr = verify_math(raw, gold)
            old = run.get("verified")
            new = vr["verified"]
            if old != new:
                run["verified"] = new
                run["method"] = vr.get("method")
                run["model_ans"] = vr.get("model_ans")
                run["verify_error"] = vr.get("error")
                fixed += 1
        r["verified_strict"] = all(rd.get("verified") for rd in r.get("runs", []))
        r["n_verified"] = sum(1 for rd in r.get("runs", []) if rd.get("verified"))
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
    total = 0
    for fp in sorted(batch.glob("v9_*.json")):
        n = revalidate_file(fp)
        print(f"  {fp.name}: {n} math runs flipped")
        total += n
    print(f"Total flipped: {total}")

if __name__ == "__main__":
    main()
