"""
P2 数据获取 · 编程算法 + 数据分析 SQL + 医学 + 金融自定义

Per §11 安全协议:
- 题目原文写到 ../data/{dim}.json
- 主对话只 print 统计
"""
import os
import random
import json
from pathlib import Path
from collections import Counter

HF_TOKEN = os.environ.get("HF_TOKEN")
DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
SEED = 42


# ─── 编程算法 · HumanEval+ ───
def fetch_humaneval():
    from datasets import load_dataset
    print("\n[HumanEval+]", flush=True)
    ds = load_dataset("evalplus/humanevalplus", split="test")
    print(f"  total: {len(ds)} rows · cols={list(ds[0].keys())}", flush=True)

    # 抽 hardest 3 题 · 用 entry_point 复杂度 + test 长度 proxy
    # 选 task_id 较大(后面题通常更难)+ test 长度大的
    rows = list(ds)
    # 排序:test code 长度降序(更多 unit test = 更复杂题)
    rows.sort(key=lambda r: -len(r.get("test", "")))

    random.seed(SEED)
    hard_pool = rows[:50]  # top 50 hardest
    selected = random.sample(hard_pool, 3)

    output = []
    for i, row in enumerate(selected):
        output.append({
            "qid": f"he_{i:03d}",
            "subset": "code_algo",
            "source": "evalplus/humanevalplus",
            "task_id": row["task_id"],
            "entry_point": row["entry_point"],
            "problem": row["prompt"],  # 含函数签名 + docstring
            "tests": row["test"],       # pytest 用
            "canonical_solution": row.get("canonical_solution", ""),
        })

    out_path = DATA_DIR / "humaneval3.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"  ✓ wrote {len(output)} questions to {out_path}", flush=True)
    print(f"  task_ids: {[o['task_id'] for o in output]}", flush=True)
    print(f"  test_lens: {[len(o['tests']) for o in output]}", flush=True)


# ─── 数据分析 SQL · Spider hard ───
def fetch_spider():
    from datasets import load_dataset
    print("\n[Spider]", flush=True)
    ds = load_dataset("xlangai/spider", split="validation")
    print(f"  total: {len(ds)} rows · cols={list(ds[0].keys())[:10]}", flush=True)

    # Spider 没显式 difficulty · 但 query 长度 + JOIN 数 proxy
    def complexity(row):
        q = (row.get("query") or "").upper()
        # 评分:JOIN 多 + nested SELECT + GROUP BY + HAVING + ORDER BY 复杂
        score = 0
        score += q.count(" JOIN ") * 3
        score += q.count(" GROUP BY ") * 2
        score += q.count(" HAVING ") * 3
        score += q.count(" ORDER BY ") * 1
        score += q.count("SELECT") - 1  # nested
        score += q.count(" UNION ") * 2
        score += q.count(" EXCEPT ") * 3
        score += q.count(" INTERSECT ") * 3
        score += len(q) // 100  # 长度
        return score

    rows = sorted(ds, key=complexity, reverse=True)
    print(f"  top 5 complexity: {[complexity(r) for r in rows[:5]]}", flush=True)

    random.seed(SEED)
    hard_pool = rows[:50]
    selected = random.sample(hard_pool, 3)

    output = []
    for i, row in enumerate(selected):
        output.append({
            "qid": f"sql_{i:03d}",
            "subset": "sql",
            "source": "xlangai/spider:validation",
            "db_id": row["db_id"],
            "problem": row["question"] + f"\n\nDatabase ID: {row['db_id']}\nWrite a SQLite SQL query to answer.",
            "gold_query": row["query"],
            "complexity": complexity(row),
        })

    out_path = DATA_DIR / "spider3.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"  ✓ wrote {len(output)} questions to {out_path}", flush=True)
    print(f"  complexities: {[o['complexity'] for o in output]}", flush=True)


# ─── 医学 · MedQA-USMLE 4-options ───
def fetch_medqa():
    from datasets import load_dataset
    print("\n[MedQA-USMLE]", flush=True)
    ds = load_dataset("GBaker/MedQA-USMLE-4-options", split="test")
    print(f"  total: {len(ds)} rows · cols={list(ds[0].keys())}", flush=True)

    # 没 difficulty 字段 · question 长度 proxy(longer = more clinical context = harder)
    rows = sorted(ds, key=lambda r: -len(r.get("question", "")))
    print(f"  longest 5 question lens: {[len(r.get('question','')) for r in rows[:5]]}", flush=True)

    random.seed(SEED)
    hard_pool = rows[:50]
    selected = random.sample(hard_pool, 3)

    output = []
    for i, row in enumerate(selected):
        # MedQA schema: question / answer (text) / answer_idx (letter A/B/C/D) / options (dict A→text)
        opts = row["options"]  # {'A': '...', 'B': '...', ...}
        choices_lines = [f"{k}. {v}" for k, v in sorted(opts.items())]
        full_problem = row["question"] + "\n\n" + "\n".join(choices_lines) + "\n\nAnswer with only the letter (A/B/C/D)."

        output.append({
            "qid": f"med_{i:03d}",
            "subset": "medical",
            "source": "GBaker/MedQA-USMLE-4-options",
            "problem": full_problem,
            "answer": row["answer_idx"],  # letter
        })

    out_path = DATA_DIR / "medqa3.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"  ✓ wrote {len(output)} questions to {out_path}", flush=True)


# ─── 金融量化 · 自定义 2024 Q4 财报 ───
def make_finance():
    print("\n[Finance · 自定义]", flush=True)
    # 3 题 · 公开财报数据 · 数字 exact match
    questions = [
        {
            "qid": "fin_000",
            "subset": "finance",
            "source": "custom · public 2024 Q4 reports",
            "problem": """阿里巴巴 (BABA) 2024 财年 Q3 (calendar 2024 Q4 · ending Dec 31, 2024) 公司报告:
- Total revenue: 280,154 million RMB
- Net income attributable to ordinary shareholders: 48,945 million RMB
- Weighted average ordinary shares outstanding (diluted): 19,250 million shares

Calculate Diluted EPS for the quarter, in RMB. Round to 2 decimal places.

End your answer with the numeric value in \\boxed{}, no currency symbol or unit.""",
            "answer": "2.54",  # 48945 / 19250 = 2.5426
            "tolerance": 0.05,
        },
        {
            "qid": "fin_001",
            "subset": "finance",
            "source": "custom · public 2024 Q4 reports",
            "problem": """A US company's 2024 income statement:
- Revenue: $1,200 million
- Operating expenses: $850 million
- Interest expense: $30 million
- Tax rate: 25%

Calculate Net Income (in million USD). Round to 1 decimal place.

End your answer in \\boxed{}.""",
            # Pre-tax income = 1200 - 850 - 30 = 320
            # Tax = 320 * 0.25 = 80
            # Net income = 320 - 80 = 240
            "answer": "240.0",
            "tolerance": 0.5,
        },
        {
            "qid": "fin_002",
            "subset": "finance",
            "source": "custom · DCF",
            "problem": """A company has projected free cash flows for next 3 years: $100M, $115M, $130M.
After year 3, FCF grows at terminal rate g = 3% perpetually.
Use WACC = 10% as discount rate.

Calculate the present value of the company today (in $M, rounded to nearest integer).

End your answer in \\boxed{}.""",
            # PV of explicit period:
            # Y1: 100 / 1.10 = 90.909
            # Y2: 115 / 1.21 = 95.041
            # Y3: 130 / 1.331 = 97.671
            # Terminal value at end of Y3: 130 * 1.03 / (0.10 - 0.03) = 1912.857
            # PV of TV: 1912.857 / 1.331 = 1437.14
            # Total: 90.909 + 95.041 + 97.671 + 1437.14 = 1720.76
            "answer": "1721",
            "tolerance": 5,
        },
    ]

    out_path = DATA_DIR / "finance3.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(questions, f, ensure_ascii=False, indent=2)
    print(f"  ✓ wrote {len(questions)} questions to {out_path}", flush=True)


if __name__ == "__main__":
    fetch_humaneval()
    fetch_spider()
    fetch_medqa()
    make_finance()
    print("\n✓ Phase 2 data fetch complete", flush=True)
