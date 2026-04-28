"""
P1 数据获取 · 数学 + 学术推理 + 长上下文 · 各 3 题 hardest

Per §11 安全协议:
- 题目原文写到 ../data/{dim}.json
- 主对话只 print 统计 · 不 print 题目内容
"""
import os
import random
import json
import sys
from pathlib import Path
from collections import Counter

# HF_TOKEN 从环境变量读 · 或 ~/.huggingface/token 读
HF_TOKEN = os.environ.get("HF_TOKEN")
if not HF_TOKEN:
    token_file = Path.home() / ".huggingface" / "token"
    if token_file.exists():
        HF_TOKEN = token_file.read_text().strip()

DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
SEED = 42

# ─── 数学 · AIME 2025 中后段 ───
def fetch_aime():
    from datasets import load_dataset
    print("\n[AIME 2025] fetching...", flush=True)
    ds = load_dataset("yentinglin/aime_2025", split="train")
    print(f"  total: {len(ds)} rows · cols={list(ds[0].keys())}", flush=True)

    # AIME 2025 没有显式难度字段 · 用题号:#11-15 是中后段(经验:#11-15 最难)
    # AIME 题号格式可能是 'id' = "2025-I-13" 或类似
    sample_ids = [ds[i]["id"] for i in range(min(5, len(ds)))]
    print(f"  sample IDs: {sample_ids}", flush=True)

    # filter: id 末尾数字 ≥ 11
    def get_problem_num(row):
        try:
            return int(str(row["id"]).split("-")[-1])
        except Exception:
            return 0

    hard = [row for row in ds if 11 <= get_problem_num(row) <= 15]
    print(f"  hard pool (#11-15): {len(hard)} rows", flush=True)

    random.seed(SEED)
    selected = random.sample(hard, min(3, len(hard)))

    output = []
    for i, row in enumerate(selected):
        output.append({
            "qid": f"aime_{i:03d}",
            "subset": "math",
            "source": f"yentinglin/aime_2025 #{row['id']}",
            "problem": row["problem"],
            "answer": str(row["answer"]),  # AIME 答案是 0-999 整数
            "solution": row.get("solution") or "",
        })

    out_path = DATA_DIR / "aime3.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"  ✓ wrote {len(output)} questions to {out_path}", flush=True)
    print(f"  stats: avg problem len = {sum(len(o['problem']) for o in output) // len(output)} chars", flush=True)


# ─── 学术推理 · GPQA Diamond ───
def fetch_gpqa():
    from datasets import load_dataset
    print("\n[GPQA Diamond] fetching...", flush=True)

    if not HF_TOKEN:
        print("  ✗ HF_TOKEN not set · skip GPQA · use ARC-Challenge fallback", flush=True)
        return

    try:
        ds = load_dataset("Idavidrein/gpqa", "gpqa_diamond", split="train", token=HF_TOKEN)
        src = "Idavidrein/gpqa:gpqa_diamond"
        print(f"  ok: {src} · {len(ds)} rows", flush=True)
    except Exception as e:
        print(f"  ✗ GPQA Diamond failed: {type(e).__name__}: {str(e)[:200]}", flush=True)
        return

    # GPQA Diamond schema:
    # Question / Correct Answer / Incorrect Answer 1-3 / High-level domain / Subdomain
    subj_field = "High-level domain"
    if subj_field not in ds.column_names:
        subj_field = "Subdomain"

    subj_dist = Counter(row[subj_field] for row in ds)
    print(f"  {subj_field} dist: {dict(list(subj_dist.items())[:6])}", flush=True)

    # 每个 high-level domain 抽 3 题(物理 / 化学 / 生物 各 3 题 = 9 题 · 3 维度)
    random.seed(SEED)
    by_domain = {}
    for row in ds:
        by_domain.setdefault(row[subj_field], []).append(row)

    # 标准化 domain 名 · 合并子类
    def normalize_domain(d):
        d_low = d.lower()
        if "phys" in d_low or "astro" in d_low:
            return "Physics"
        if "chem" in d_low:
            return "Chemistry"
        if "bio" in d_low or "genet" in d_low or "molecular" in d_low:
            return "Biology"
        return "Other"

    by_main = {}
    for row in ds:
        m = normalize_domain(row[subj_field])
        if m == "Other":
            continue
        by_main.setdefault(m, []).append(row)

    print(f"  main domain dist: {[(k, len(v)) for k,v in by_main.items()]}", flush=True)

    # 每 main domain 各抽 3 题
    output_by_domain = {"Physics": [], "Chemistry": [], "Biology": []}
    qid_counter = 0
    for main_domain in ["Physics", "Chemistry", "Biology"]:
        rows = by_main.get(main_domain, [])
        random.shuffle(rows)
        picked = rows[:3]

        for row in picked:
            q_text = row["Question"]
            correct = row["Correct Answer"]
            incorrect = [row["Incorrect Answer 1"], row["Incorrect Answer 2"], row["Incorrect Answer 3"]]

            rng = random.Random(SEED + qid_counter)
            all_choices = [(correct, True)] + [(inc, False) for inc in incorrect if inc]
            rng.shuffle(all_choices)

            letter_correct = None
            choices_text = []
            for j, (text, is_correct) in enumerate(all_choices[:4]):
                letter = chr(ord("A") + j)
                choices_text.append(f"{letter}. {text}")
                if is_correct:
                    letter_correct = letter

            full_problem = q_text + "\n\n" + "\n".join(choices_text) + "\n\nAnswer with only the letter (A/B/C/D)."

            output_by_domain[main_domain].append({
                "qid": f"gpqa_{main_domain.lower()}_{len(output_by_domain[main_domain]):02d}",
                "subset": main_domain.lower(),  # physics / chemistry / biology
                "source": src,
                "domain": main_domain,
                "raw_subdomain": row.get(subj_field, "unknown"),
                "problem": full_problem,
                "answer": letter_correct,
            })
            qid_counter += 1

    # 写 3 个独立文件 · 每个维度一个
    for main_domain, items in output_by_domain.items():
        out_path = DATA_DIR / f"gpqa_{main_domain.lower()}3.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
        print(f"  ✓ wrote {len(items)} {main_domain} questions to {out_path}", flush=True)
        print(f"    raw subdomains: {[o['raw_subdomain'] for o in items]}", flush=True)


# ─── 长上下文 · LongBench v2 ───
def fetch_longbench():
    from datasets import load_dataset
    print("\n[LongBench v2] fetching...", flush=True)

    try:
        ds = load_dataset("THUDM/LongBench-v2", split="train")
    except Exception as e:
        print(f"  ✗ LongBench v2 failed: {type(e).__name__}: {str(e)[:200]}", flush=True)
        return

    print(f"  ok: 503 rows · cols={list(ds[0].keys())[:10]}", flush=True)

    # LongBench v2 schema: _id / domain / sub_domain / difficulty / length / question /
    #                     choice_A / choice_B / choice_C / choice_D / answer (letter) / context
    diff_dist = Counter(row.get("difficulty", "?") for row in ds)
    domain_dist = Counter(row.get("domain", "?") for row in ds)
    print(f"  difficulty dist: {dict(diff_dist)}", flush=True)
    print(f"  domain dist (top 6): {dict(list(domain_dist.items())[:6])}", flush=True)

    # 选 hard difficulty + 长 ctx
    hard_pool = [row for row in ds if row.get("difficulty") == "hard"]
    print(f"  hard pool: {len(hard_pool)}", flush=True)

    # 找 ctx field
    ctx_field = None
    for f in ("context", "input", "passage"):
        if f in ds.column_names:
            ctx_field = f
            break
    if ctx_field is None:
        print(f"  no context field · cols: {list(ds[0].keys())}", flush=True)
        return

    # 30K+ chars
    long_hard = [row for row in hard_pool if len(row[ctx_field]) >= 30000]
    print(f"  hard + long(≥30K chars): {len(long_hard)}", flush=True)

    pool = long_hard if len(long_hard) >= 3 else hard_pool
    random.seed(SEED)
    random.shuffle(pool)
    selected = pool[:3]

    output = []
    for i, row in enumerate(selected):
        q_text = row["question"]
        ctx = row[ctx_field]
        choices = "\n".join([
            f"A. {row['choice_A']}",
            f"B. {row['choice_B']}",
            f"C. {row['choice_C']}",
            f"D. {row['choice_D']}",
        ])
        full_problem = f"Read the following document carefully:\n\n{ctx}\n\nQuestion: {q_text}\n\n{choices}\n\nAnswer with only the letter (A/B/C/D)."

        output.append({
            "qid": f"lb_{i:03d}",
            "subset": "longctx",
            "source": "THUDM/LongBench-v2",
            "domain": row.get("domain", "unknown"),
            "sub_domain": row.get("sub_domain", "unknown"),
            "difficulty": row.get("difficulty", "unknown"),
            "ctx_len": len(ctx),
            "problem": full_problem,
            "answer": row["answer"],  # letter (A/B/C/D)
        })

    out_path = DATA_DIR / "longbench3.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"  ✓ wrote {len(output)} questions to {out_path}", flush=True)
    print(f"  stats: avg ctx = {sum(o['ctx_len'] for o in output) // len(output)} chars", flush=True)
    print(f"  domains: {[o['domain'] for o in output]}", flush=True)


if __name__ == "__main__":
    fetch_aime()
    fetch_gpqa()
    fetch_longbench()
    print("\n✓ Phase 1 data fetch complete", flush=True)
