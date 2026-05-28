#!/usr/bin/env python3
"""
把 mimo-v25-pro-eval.mjs 输出的 humaneval.jsonl 转成 evalplus 期望的 samples 格式,
然后(可选)直接调用 evalplus.evaluate 跑真 functional pass@1。

evalplus samples 格式(per line):
  {"task_id": "HumanEval/0", "solution": "def func(...):\n    ..."}

solution 需要是**完整可独立运行**的 function 实现(prompt 里的签名 + 实现体)。
我们的 mjs runner 让 model 输出"function body only"(写在 ```python``` 块里),
所以需要把 model 输出的代码合并到 prompt 的签名 + docstring 后面。

Usage:
  python3 scripts/humaneval_to_evalplus.py \
    --in /tmp/mimo-eval-FULL-.../humaneval.jsonl \
    --dataset /tmp/eval-data/humaneval_plus.json \
    --out /tmp/mimo-eval-FULL-.../humaneval_samples.jsonl \
    [--run-evalplus]
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path


def build_solution(prompt: str, model_code: str, entry_point: str) -> str:
    """合并 prompt(签名 + docstring)+ model 输出的实现体 → 完整 function"""
    code = model_code.strip()
    # 如果 model 已经写了完整 def(包含签名),直接用
    if f"def {entry_point}" in code:
        # 但可能有 import 语句在 def 前面 → 保留
        return code
    # 否则 model 只写了实现体 → 拼在 prompt 后面
    # prompt 通常以 def func(...)... -> ...:\n    """..."""\n 结尾
    # 我们需要在 prompt 末尾加缩进的实现体
    body = code
    if not body.startswith("    ") and not body.startswith("\t"):
        # 加 4-space 缩进
        body = "\n".join("    " + line if line.strip() else line for line in body.split("\n"))
    return prompt.rstrip() + "\n" + body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="humaneval.jsonl from mimo eval")
    ap.add_argument("--dataset", required=True, help="humaneval_plus.json (canonical prompt + task_id)")
    ap.add_argument("--out", required=True, help="output samples.jsonl")
    ap.add_argument("--run-evalplus", action="store_true", help="invoke evalplus.evaluate after conversion")
    args = ap.parse_args()

    # 索引 dataset by task_id 和 entry_point
    with open(args.dataset, "r", encoding="utf-8") as f:
        dataset = json.load(f)
    by_taskid = {row["task_id"]: row for row in dataset}
    by_ep = {row["entry_point"]: row for row in dataset}

    samples = []
    seen_task_ids = set()
    skipped_no_code = 0
    truncated_excerpt = 0
    with open(args.inp, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            if d.get("error"):
                skipped_no_code += 1
                continue
            # 取完整代码:优先 fullCode → response → response_excerpt
            model_code = d.get("fullCode") or d.get("response") or d.get("response_excerpt") or ""
            if not model_code.strip():
                skipped_no_code += 1
                continue
            # 检查代码来源是否是 excerpt(可能被 400-char 截断)
            if d.get("response_excerpt") and not d.get("fullCode") and not d.get("response"):
                if len(d["response_excerpt"]) >= 399:
                    truncated_excerpt += 1
            # 找 dataset 里的对应 task
            task_id = d.get("task_id")
            ep = d.get("entry_point")
            row = by_taskid.get(task_id) if task_id else None
            if not row and ep:
                row = by_ep.get(ep)
            if not row:
                # qid 形如 HumanEval_0 → HumanEval/0
                qid = d.get("qid", "")
                guess_taskid = qid.replace("_", "/")
                row = by_taskid.get(guess_taskid)
            if not row:
                print(f"  warn: no dataset match for qid={d.get('qid')}, skip", file=sys.stderr)
                skipped_no_code += 1
                continue

            # 从 ```python``` block 抽代码
            m = re.search(r"```python\n?([\s\S]*?)```", model_code)
            code_block = m.group(1) if m else model_code

            solution = build_solution(row["problem"], code_block, row["entry_point"])
            if row["task_id"] in seen_task_ids:
                continue
            seen_task_ids.add(row["task_id"])
            samples.append({"task_id": row["task_id"], "solution": solution})

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    print(f"converted {len(samples)} samples → {args.out}")
    print(f"  skipped (no code / not in dataset): {skipped_no_code}")
    print(f"  used truncated excerpt (likely incomplete code): {truncated_excerpt}")

    if args.run_evalplus:
        print("running evalplus.evaluate …")
        try:
            res = subprocess.run(
                ["python3", "-m", "evalplus.evaluate", "--dataset", "humaneval", "--samples", args.out],
                capture_output=True, text=True, timeout=600,
            )
            print(res.stdout)
            if res.returncode != 0:
                print("evalplus stderr:", res.stderr, file=sys.stderr)
        except FileNotFoundError:
            print("evalplus not installed; install with `pip install evalplus`", file=sys.stderr)


if __name__ == "__main__":
    main()
