#!/usr/bin/env python3
"""
扩展 V9 27 题 → 56 题 (8 dim × 7 题,sql 仍单独不计分但保留 3 题)
+ 32 新题:每 dim +4 题

数据源:
    physics/chemistry/biology  ← Idavidrein/gpqa (Diamond split)
    code_algo                  ← evalplus/humanevalplus
    medical                    ← bigbio/med_qa (us / 4-option)
    longctx                    ← THUDM/LongBench-v2
    math                       ← hardcoded AIME 2024/2025 (4 道公开题)
    finance                    ← hardcoded 自创 4 道 (DCF / 比率 / 利息 / 杠杆)
    sql                        ← skip(verifier 不公平,保留原 3 题)

输出:写入 data/<dim>3.json (覆盖) — 文件名保留 "3" 后缀(实际变 7 题)
"""
import os
import json
import random
import re
import string
from pathlib import Path

os.environ['HF_TOKEN'] = open(os.path.expanduser('~/.cache/huggingface/token')).read().strip()
from datasets import load_dataset

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
random.seed(42)  # 可重复


# ── 1. GPQA Diamond → physics / chemistry / biology +4 each ──
def expand_gpqa(n_per_domain=4):
    """从 GPQA Diamond 抽 n_per_domain 题/domain · 转 V9 letter 格式"""
    print(f"[gpqa] loading GPQA Diamond...")
    d = load_dataset('Idavidrein/gpqa', 'gpqa_diamond', split='train')

    # 按 domain 分桶
    by_domain = {'Physics': [], 'Chemistry': [], 'Biology': []}
    for row in d:
        dom = row.get('High-level domain', '')
        if dom in by_domain:
            by_domain[dom].append(row)
    for dom, rows in by_domain.items():
        print(f"  {dom}: {len(rows)} questions available")

    # 从每 domain 选 n_per_domain 题
    selected = {dom: random.sample(rows, n_per_domain) for dom, rows in by_domain.items()}

    out = {}
    subset_map = {'Physics': 'physics', 'Chemistry': 'chemistry', 'Biology': 'biology'}
    for dom, rows in selected.items():
        subset = subset_map[dom]
        items = []
        for i, r in enumerate(rows):
            q = r['Question'].strip()
            correct = r['Correct Answer'].strip()
            wrong = [r['Incorrect Answer 1'].strip(), r['Incorrect Answer 2'].strip(), r['Incorrect Answer 3'].strip()]
            # 随机化 4 选项位置
            opts = wrong + [correct]
            random.shuffle(opts)
            correct_idx = opts.index(correct)
            correct_letter = ['A', 'B', 'C', 'D'][correct_idx]
            opts_text = "\n".join(f"{['A','B','C','D'][k]}. {opt}" for k, opt in enumerate(opts))
            problem = f"{q}\n\n{opts_text}\n\nAnswer with only A/B/C/D."
            items.append({
                "qid": f"{'phys' if subset=='physics' else 'chem' if subset=='chemistry' else 'bio'}_{i+3:03d}",  # 03..06 接现有 00..02
                "subset": subset,
                "source": "GPQA Diamond",
                "domain": subset,
                "raw_subdomain": r.get('Subdomain', ''),
                "problem": problem,
                "answer": correct_letter,
            })
        out[subset] = items
    return out


# ── 2. HumanEval+ → code_algo +4 ──
def expand_humaneval(n=4):
    print(f"[humaneval+] loading evalplus/humanevalplus...")
    d = load_dataset('evalplus/humanevalplus', split='test')
    rows = list(d)
    # 跳过原 V9 已有的(he_000=HumanEval/0 max_element 等);从中后段抽
    selected = random.sample(rows[10:], n)
    items = []
    for i, r in enumerate(selected):
        items.append({
            "qid": f"he_{i+3:03d}",
            "subset": "code_algo",
            "source": "HumanEval+",
            "problem": r['prompt'],
            "entry_point": r.get('entry_point', ''),
            "tests": r.get('test', ''),
            "answer": r.get('canonical_solution', ''),  # reference solution
        })
    return items


# ── 3. MedQA → medical +4(GBaker/MedQA-USMLE-4-options · parquet) ──
def expand_medqa(n=4):
    print(f"[medqa] loading GBaker/MedQA-USMLE-4-options...")
    d = load_dataset('GBaker/MedQA-USMLE-4-options', split='test')
    rows = list(d)
    selected = random.sample(rows, n)
    items = []
    for i, r in enumerate(selected):
        q = r.get('question') or r.get('sent1') or ''
        # MedQA-USMLE-4-options schema: question, options (dict A-D), answer_idx (A/B/C/D), answer (text)
        opts = r.get('options') or {}
        if isinstance(opts, dict):
            opts_text = "\n".join(f"{k}. {v}" for k, v in sorted(opts.items()))
            ans = r.get('answer_idx', '')
        elif isinstance(opts, list):
            opts_text = "\n".join(f"{['A','B','C','D'][j]}. {o}" for j, o in enumerate(opts))
            ans = r.get('answer_idx', '') or r.get('label', '')
        else:
            opts_text = "(no options)"
            ans = ''
        problem = f"{q}\n\n{opts_text}\n\nAnswer with only A/B/C/D."
        items.append({
            "qid": f"med_{i+3:03d}",
            "subset": "medical",
            "source": "MedQA-USMLE-4opt",
            "problem": problem,
            "answer": ans,
        })
    return items


# ── 4. LongBench-V2 → longctx +4 ──
def expand_longbench(n=4):
    print(f"[longbench-v2] loading THUDM/LongBench-v2...")
    d = load_dataset('THUDM/LongBench-v2', split='train')
    rows = list(d)
    # 选 50K-200K 范围(真 longctx 但仍 fit 大部分模型 200K context)
    short_rows = [r for r in rows if 50000 <= len(r.get('context', '')) <= 200000]
    print(f"  available: {len(rows)} total, {len(short_rows)} in 50K-200K range")
    selected = random.sample(short_rows, min(n, len(short_rows)))
    items = []
    for i, r in enumerate(selected):
        ctx = r.get('context', '')
        q = r.get('question', '')
        opts = []
        for letter in ['A', 'B', 'C', 'D']:
            choice = r.get(f'choice_{letter}', '')
            if choice:
                opts.append(f"{letter}. {choice}")
        opts_text = "\n".join(opts)
        problem = f"{ctx}\n\n---\n\n{q}\n\n{opts_text}\n\nAnswer with only A/B/C/D."
        items.append({
            "qid": f"lb_{i+3:03d}",
            "subset": "longctx",
            "source": "LongBench-V2",
            "problem": problem,
            "answer": r.get('answer', ''),
        })
    return items


# ── 5. AIME 2024/2025 → math +4(手挑公开题)──
def expand_aime():
    """AIME 公开题 4 道 — 答案均为 0-999 整数"""
    return [
        {
            "qid": "aime_003",
            "subset": "math",
            "source": "AIME 2024 I Problem 1",
            "problem": "Every morning Aya goes for a 9-kilometer-long walk and stops at a coffee shop afterwards. When she walks at a constant speed of s kilometers per hour, the walk takes her 4 hours, including t minutes spent in the coffee shop. When she walks s+2 kilometers per hour, the walk takes her 2 hours and 24 minutes, including t minutes spent in the coffee shop. Suppose Aya walks at s+1/2 kilometers per hour. Find the number of minutes the walk takes her, including the t minutes spent in the coffee shop. Give the final answer in \\boxed{}.",
            "answer": "204",
        },
        {
            "qid": "aime_004",
            "subset": "math",
            "source": "AIME 2024 I Problem 4",
            "problem": "Jen enters a lottery by picking 4 distinct numbers from S={1,2,3,...,9,10}. 4 numbers are randomly chosen from S. She wins a prize if at least two of her numbers were 2 of the randomly chosen numbers, and wins the grand prize if all four of her numbers were the randomly chosen numbers. The probability of her winning the grand prize given that she won a prize is m/n where m and n are relatively prime positive integers. Find m+n. Give the final answer in \\boxed{}.",
            "answer": "116",
        },
        {
            "qid": "aime_005",
            "subset": "math",
            "source": "AIME 2025 I Problem 1",
            "problem": "Find the sum of all integer bases b > 9 for which 17_b is a divisor of 97_b. (Here 17_b means the number 17 in base b.) Give the final answer in \\boxed{}.",
            "answer": "70",
        },
        {
            "qid": "aime_006",
            "subset": "math",
            "source": "AIME 2025 I Problem 3",
            "problem": "The 9 members of a baseball team went to an ice-cream parlor after their game. Each player had a single scoop cone of chocolate, vanilla, or strawberry ice cream. At least one player chose each flavor, and the number of players who chose chocolate was greater than the number of players who chose vanilla, which was greater than the number of players who chose strawberry. Let N be the number of different assignments of flavors to players that meet these conditions. Find the remainder when N is divided by 1000. Give the final answer in \\boxed{}.",
            "answer": "16",
        },
    ]


# ── 6. Finance 自创 4 道(DCF / 比率 / 利息 / 现金流) ──
def expand_finance():
    return [
        {
            "qid": "fin_003",
            "subset": "finance",
            "source": "self-authored DCF",
            "problem": "公司明年自由现金流 (FCFF) 预测 100 million USD,之后每年永续增长 3%。WACC = 9%。用 Gordon growth model 计算公司企业价值 (Enterprise Value),单位百万美元,保留 1 位小数。\n\nEnd your answer in \\boxed{}.",
            "answer": 1666.7,
            "tolerance": 5.0,
        },
        {
            "qid": "fin_004",
            "subset": "finance",
            "source": "self-authored ratio",
            "problem": "公司财报:总资产 5,000 million,总负债 3,200 million,营业收入 8,000 million,净利润 480 million。计算 Return on Equity (ROE),百分比保留 2 位小数。\n\nEnd your answer in \\boxed{}.",
            "answer": 26.67,
            "tolerance": 0.5,
        },
        {
            "qid": "fin_005",
            "subset": "finance",
            "source": "self-authored bond",
            "problem": "5 年期债券,面值 1,000 USD,coupon rate 5% (年付),YTM = 6%。计算债券价格,保留 2 位小数。\n\nEnd your answer in \\boxed{}.",
            "answer": 957.88,
            "tolerance": 1.0,
        },
        {
            "qid": "fin_006",
            "subset": "finance",
            "source": "self-authored leverage",
            "problem": "公司 EBIT = 200 million,利息费用 = 40 million,税率 25%。计算 Times Interest Earned ratio (利息保障倍数),保留 2 位小数。\n\nEnd your answer in \\boxed{}.",
            "answer": 5.00,
            "tolerance": 0.05,
        },
    ]


def merge_and_save(subset, new_items):
    """读现有 <subset>3.json,append new_items,保存"""
    fname = {
        'physics': 'gpqa_physics3.json',
        'chemistry': 'gpqa_chemistry3.json',
        'biology': 'gpqa_biology3.json',
        'code_algo': 'humaneval3.json',
        'medical': 'medqa3.json',
        'longctx': 'longbench3.json',
        'math': 'aime3.json',
        'finance': 'finance3.json',
    }[subset]
    fp = DATA_DIR / fname
    existing = json.loads(fp.read_text())
    n_old = len(existing)
    merged = existing + new_items
    # 备份 + 写入
    backup = fp.with_suffix('.json.bak27')
    if not backup.exists():
        backup.write_text(json.dumps(existing, ensure_ascii=False, indent=2))
    fp.write_text(json.dumps(merged, ensure_ascii=False, indent=2))
    print(f"  ✓ {fname}: {n_old} → {len(merged)} (backup: {backup.name})")


def main():
    # 跳过 GPQA / HumanEval(已扩成功)
    import sys
    if "--skip-done" not in sys.argv:
        gpqa_items = expand_gpqa(4)
        for subset in ['physics', 'chemistry', 'biology']:
            merge_and_save(subset, gpqa_items[subset])

        code_items = expand_humaneval(4)
        merge_and_save('code_algo', code_items)

    med_items = expand_medqa(4)
    merge_and_save('medical', med_items)

    long_items = expand_longbench(4)
    merge_and_save('longctx', long_items)

    math_items = expand_aime()
    merge_and_save('math', math_items)

    fin_items = expand_finance()
    merge_and_save('finance', fin_items)

    print("\nDone. V9 expanded to 8 dim × 7 = 56 题 (sql 保留 3 题不变).")


if __name__ == "__main__":
    main()
