"""
Finance Verifier · 数字 exact match with tolerance

输入:
    model_output: LLM 输出
    gold: dict { 'answer': str (numeric), 'tolerance': float }

返回:
    {verified, model_ans, gold_ans, method, error}
"""
import re
from typing import Optional, Union


def extract_number(text: str) -> Optional[float]:
    if not text:
        return None

    # 1. \boxed{N}
    m = re.search(r'\\boxed\{\s*([-+]?\d[\d,]*\.?\d*)\s*\}', text)
    if m:
        s = m.group(1).replace(",", "")
        try:
            return float(s)
        except Exception:
            pass

    # 2. final answer / 答案 number
    patterns = [
        r'(?:final\s+answer|answer|总值|结果)\s*(?:is|=|:)?\s*\$?([-+]?\d[\d,]*\.?\d*)',
        r'答案\s*(?:是|=|:)?\s*\$?([-+]?\d[\d,]*\.?\d*)',
    ]
    for p in patterns:
        m = re.search(p, text, re.I)
        if m:
            s = m.group(1).replace(",", "")
            try:
                return float(s)
            except Exception:
                pass

    # 3. 末尾 ~200 字找数字 · 取最后一个
    tail = text[-300:]
    nums = re.findall(r'[-+]?\d[\d,]*\.?\d+', tail)
    if nums:
        try:
            return float(nums[-1].replace(",", ""))
        except Exception:
            pass

    return None


def verify(model_output: str, gold: Union[dict, str, float]) -> dict:
    if isinstance(gold, dict):
        gold_val = float(gold["answer"])
        tol = gold.get("tolerance", 0.01)
    elif isinstance(gold, (int, float)):
        gold_val = float(gold)
        tol = 0.01
    else:
        try:
            gold_val = float(str(gold).replace(",", "").strip())
            tol = 0.01
        except Exception:
            return {"verified": False, "model_ans": None, "gold_ans": gold,
                    "method": "gold_unparseable", "error": "gold not numeric"}

    extracted = extract_number(model_output)
    if extracted is None:
        return {"verified": False, "model_ans": None, "gold_ans": str(gold_val),
                "method": "no_number_extracted", "error": "extraction failed"}

    if abs(extracted - gold_val) <= tol:
        return {"verified": True, "model_ans": str(extracted), "gold_ans": str(gold_val),
                "method": "tolerance_match", "error": None}

    return {"verified": False, "model_ans": str(extracted), "gold_ans": str(gold_val),
            "method": "no_match", "error": f"diff={extracted-gold_val:.2f}"}


def _selftest():
    cases = [
        ("Final answer: \\boxed{2.54}", {"answer": "2.54", "tolerance": 0.05}, True, "exact match"),
        ("answer is $240.0 million", {"answer": "240.0", "tolerance": 0.5}, True, "with $"),
        ("\\boxed{1721}", {"answer": "1721", "tolerance": 5}, True, "tolerance"),
        ("\\boxed{1750}", {"answer": "1721", "tolerance": 5}, False, "out of tolerance"),
        ("\\boxed{1,234.5}", {"answer": "1234.5", "tolerance": 0.1}, True, "thousand sep"),
        ("...\nThe value is approximately 240", {"answer": "240.0", "tolerance": 1}, True, "tail number"),
        ("I cannot calculate", {"answer": "100", "tolerance": 1}, False, "no number"),
    ]
    n_pass = 0
    for i, (out, gold, expected, desc) in enumerate(cases):
        r = verify(out, gold)
        ok = r["verified"] == expected
        n_pass += int(ok)
        status = "✓" if ok else "✗"
        print(f"  {status} case {i}: {desc} → verified={r['verified']} method={r['method']}")
    print(f"\n[selftest] {n_pass}/{len(cases)} passed")
    return n_pass == len(cases)


if __name__ == "__main__":
    _selftest()
