#!/usr/bin/env python3
"""
准备 MiMo eval 完整 dataset(MMLU 500 / GPQA Diamond 198 / HumanEval+ 164)
→ 转成 scripts/mimo-v25-pro-eval.mjs 期望的 JSON shape。

输出:
  /tmp/eval-data/mmlu_500.json
  /tmp/eval-data/gpqa_diamond.json
  /tmp/eval-data/humaneval_plus.json

Usage:
  python3 scripts/prep_eval_datasets.py [--out /tmp/eval-data]
"""
import argparse
import json
import os
import random
import sys
from collections import defaultdict

# 国内/海外都可,优先国内 mirror
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

from datasets import load_dataset  # noqa: E402

LETTER = ["A", "B", "C", "D", "E"]


def prep_mmlu(out_dir, sample=500, seed=42):
    """MMLU test split → 500 题分层抽样(57 subjects × ~9 题)"""
    print("[mmlu] loading cais/mmlu …", flush=True)
    ds = load_dataset("cais/mmlu", "all", split="test")
    by_subject = defaultdict(list)
    for row in ds:
        by_subject[row["subject"]].append(row)
    print(f"[mmlu] {len(ds)} total, {len(by_subject)} subjects", flush=True)

    rng = random.Random(seed)
    target_per_subj = max(1, sample // len(by_subject))
    picked = []
    for subj, rows in by_subject.items():
        n = min(target_per_subj, len(rows))
        picked.extend(rng.sample(rows, n))
    # 凑齐 500
    while len(picked) < sample:
        subj = rng.choice(list(by_subject.keys()))
        candidate = rng.choice(by_subject[subj])
        if candidate not in picked:
            picked.append(candidate)
    picked = picked[:sample]
    rng.shuffle(picked)

    items = []
    for i, r in enumerate(picked):
        items.append({
            "qid": f"mmlu_{i:04d}",
            "subset": r["subject"],
            "question": r["question"],
            "choices": r["choices"],
            "answer": LETTER[r["answer"]],  # 转成字母
        })
    fp = os.path.join(out_dir, "mmlu_500.json")
    with open(fp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    print(f"[mmlu] wrote {len(items)} → {fp}", flush=True)


def prep_gpqa_diamond(out_dir):
    """GPQA Diamond 198 全集 — Idavidrein/gpqa,gpqa_diamond config"""
    print("[gpqa] loading Idavidrein/gpqa diamond …", flush=True)
    try:
        ds = load_dataset("Idavidrein/gpqa", "gpqa_diamond", split="train", trust_remote_code=True)
    except Exception as e:
        # gated dataset 可能要 token,试 fallback
        print(f"[gpqa] load failed: {e}; trying default split", flush=True)
        ds = load_dataset("Idavidrein/gpqa", "gpqa_diamond", trust_remote_code=True)
        ds = ds["train"]

    items = []
    rng = random.Random(42)  # deterministic option shuffle
    for i, r in enumerate(ds):
        # GPQA 字段:Question / Correct Answer / Incorrect Answer 1/2/3 + (some have Subdomain)
        q = r.get("Question") or r.get("question")
        correct = r.get("Correct Answer") or r.get("correct_answer")
        incs = [
            r.get("Incorrect Answer 1") or r.get("incorrect_answer_1"),
            r.get("Incorrect Answer 2") or r.get("incorrect_answer_2"),
            r.get("Incorrect Answer 3") or r.get("incorrect_answer_3"),
        ]
        opts = [correct] + incs
        # 随机化选项顺序
        idx = list(range(4))
        rng.shuffle(idx)
        shuffled = [opts[j] for j in idx]
        ans_letter = LETTER[idx.index(0)]
        subdomain = r.get("Subdomain") or r.get("subdomain") or "general"

        problem = (
            q + "\n\n" +
            "\n".join(f"{LETTER[k]}. {shuffled[k]}" for k in range(4)) +
            "\n\nAnswer with only the letter (A/B/C/D)."
        )
        items.append({
            "qid": f"gpqa_{i:03d}",
            "subset": subdomain,
            "source": "Idavidrein/gpqa:gpqa_diamond",
            "problem": problem,
            "answer": ans_letter,
        })

    fp = os.path.join(out_dir, "gpqa_diamond.json")
    with open(fp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    print(f"[gpqa] wrote {len(items)} → {fp}", flush=True)


def prep_humaneval_plus(out_dir):
    """HumanEval+ 164 — evalplus/humanevalplus"""
    print("[humaneval] loading evalplus/humanevalplus …", flush=True)
    ds = load_dataset("evalplus/humanevalplus", split="test")
    items = []
    for r in ds:
        items.append({
            "qid": r.get("task_id", "").replace("/", "_") or f"he_{len(items)}",
            "subset": "code_algo",
            "source": "evalplus/humanevalplus",
            "task_id": r.get("task_id"),
            "entry_point": r.get("entry_point"),
            "problem": r.get("prompt", ""),
            "tests": r.get("test", ""),
            "canonical_solution": r.get("canonical_solution", ""),
        })
    fp = os.path.join(out_dir, "humaneval_plus.json")
    with open(fp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    print(f"[humaneval] wrote {len(items)} → {fp}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/eval-data")
    ap.add_argument("--skip-mmlu", action="store_true")
    ap.add_argument("--skip-gpqa", action="store_true")
    ap.add_argument("--skip-humaneval", action="store_true")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    if not args.skip_mmlu:
        try:
            prep_mmlu(args.out)
        except Exception as e:
            print(f"[mmlu] FAILED: {e}", file=sys.stderr)
    if not args.skip_gpqa:
        try:
            prep_gpqa_diamond(args.out)
        except Exception as e:
            print(f"[gpqa] FAILED: {e}", file=sys.stderr)
    if not args.skip_humaneval:
        try:
            prep_humaneval_plus(args.out)
        except Exception as e:
            print(f"[humaneval] FAILED: {e}", file=sys.stderr)
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
