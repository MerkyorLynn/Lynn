"""
Letter Match Verifier · A/B/C/D 多选

输入:
    model_output: LLM 完整输出文本(可能含 reasoning + answer)
    gold_letter: "A" / "B" / "C" / "D"

返回:
    {verified: bool, model_ans: str | None, gold_ans: str, method: str}

提取策略(优先级)·:
    1. \boxed{X}                 - 数学风格
    2. "answer is X" / "答案是 X"  - 标准短语
    3. "(X)"                       - 括号包裹
    4. tail "**X**"                - markdown bold
    5. 末尾单独的 X                 - line ends with letter
    6. 整行就一个 X                 - whole line a single letter
"""
import re
from typing import Optional


def extract_choice(text: str) -> Optional[str]:
    if not text:
        return None

    # 1. \boxed{X}
    m = re.search(r'\\boxed\{\s*([A-D])\s*\}', text)
    if m:
        return m.group(1).upper()

    # 2. answer is X / 答案是 X / 选 X / 选项 X
    patterns = [
        r'(?:final\s+answer|answer)\s*(?:is|=|:)?\s*\(?([A-D])\)?',
        r'答案\s*(?:是|为|=|:)?\s*\(?([A-D])\)?',
        r'选\s*(?:择|项)?\s*[:：]?\s*\(?([A-D])\)?',
    ]
    for p in patterns:
        m = re.search(p, text, re.I)
        if m:
            return m.group(1).upper()

    # 3. (X) · 整个 (A)/(B) 格式
    m = re.search(r'\(([A-D])\)', text)
    if m:
        return m.group(1).upper()

    # 4. tail markdown **X** · 在末尾 200 字找
    tail = text[-300:]
    for c in 'ABCD':
        if f'**{c}**' in tail or f'**{c}.' in tail:
            return c

    # 5. 整行就一个字母(模型只输出 letter)
    for line in text.strip().split('\n'):
        line = line.strip()
        if line in ('A', 'B', 'C', 'D'):
            return line

    # 6. 行尾的 X
    m = re.search(r'\b([A-D])\b\s*[\.\?\n]?\s*$', text.strip())
    if m:
        return m.group(1).upper()

    return None


def verify(model_output: str, gold_letter: str) -> dict:
    extracted = extract_choice(model_output)
    gold = (gold_letter or "").strip().upper()

    if not extracted:
        return {
            "verified": False,
            "model_ans": None,
            "gold_ans": gold,
            "method": "no_letter_extracted",
            "error": "model_output_no_letter",
        }

    return {
        "verified": extracted == gold,
        "model_ans": extracted,
        "gold_ans": gold,
        "method": "letter_match",
        "error": None,
    }


# Self-test
def _selftest():
    cases = [
        # (model_output, gold, expected_verified, description)
        ("Final answer: B", "B", True, "answer is X"),
        ("\\boxed{C}", "C", True, "boxed letter"),
        ("答案是 A", "A", True, "Chinese answer"),
        ("After analysis, I choose (D)", "D", True, "(X) format"),
        ("**A**", "A", True, "bold markdown"),
        ("...\nThe answer is **C**", "C", True, "tail bold"),
        ("Long reasoning ending with\nB", "B", True, "tail single letter"),
        ("just A", "A", True, "tail single A"),
        ("answer is B", "C", False, "wrong answer"),
        ("I cannot answer this", "A", False, "refusal · no extraction"),
        ("Looking at choice D more carefully, ... so the answer is A.", "A", True, "answer is X overrides earlier mention"),
    ]
    n_pass = 0
    for i, (mo, gold, expected, desc) in enumerate(cases):
        r = verify(mo, gold)
        ok = r["verified"] == expected
        n_pass += int(ok)
        status = "✓" if ok else "✗"
        print(f"  {status} case {i}: {desc} → verified={r['verified']} extracted={r['model_ans']!r}")
    print(f"\n[selftest] {n_pass}/{len(cases)} passed")
    return n_pass == len(cases)


if __name__ == "__main__":
    _selftest()
