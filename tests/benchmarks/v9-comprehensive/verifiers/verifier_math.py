"""
MATH verifier · sympy 数值/符号比对

输入:
    model_output: LLM 完整输出文本(reasoning + 最终答案)
    gold_solution: dataset 的 'solution' 字段(含 \\boxed{答案})

返回:
    dict: {verified: bool, model_ans: str | None, gold_ans: str | None, method: str, error: str | None}

使用:
    from verifier_math import verify
    result = verify(llm_output, dataset_row['solution'])
    if result['verified']:
        score += 3  # MATH-50 每题 3 分
"""
import re
import sympy
from sympy.parsing.latex import parse_latex


def extract_boxed(text: str) -> str | None:
    """提取 \\boxed{...} · 支持嵌套 {}"""
    if not text:
        return None
    # 找最后一个 \boxed{...}(模型可能有多个 attempt · 最后是结论)
    matches = []
    i = 0
    while i < len(text):
        idx = text.find(r'\boxed{', i)
        if idx < 0:
            idx = text.find(r'\boxed ', i)
            if idx < 0:
                break
        # 找到 \boxed{ · 平衡 brace 找到对应的 }
        start = idx + len(r'\boxed{')
        depth = 1
        j = start
        while j < len(text) and depth > 0:
            if text[j] == '{':
                depth += 1
            elif text[j] == '}':
                depth -= 1
            j += 1
        if depth == 0:
            matches.append(text[start:j-1].strip())
        i = j

    if matches:
        return matches[-1]  # 最后一个

    # Fallback · "answer is X" / "答案是 X" 模式
    for pat in [
        r'(?:final answer|answer)\s*(?:is|=|:)\s*([^\n.]+)',
        r'答案\s*(?:是|为|=|:)\s*([^\n。]+)',
        r'\\\[\s*([^\\]+?)\s*\\\]',  # \[ ans \]
    ]:
        m = re.search(pat, text, re.I)
        if m:
            return m.group(1).strip()
    return None


def normalize_latex(s: str) -> str:
    """LaTeX 常见格式标准化"""
    if s is None:
        return ""
    # 去外围空白 + 美元符号
    s = s.strip().strip('$')
    # 去 \text{...}
    s = re.sub(r'\\text\s*\{([^}]*)\}', r'\1', s)
    # 去 \mbox{...}
    s = re.sub(r'\\mbox\s*\{([^}]*)\}', r'\1', s)
    # 去 \\left( \\right) 等空 LaTeX delimiter
    s = re.sub(r'\\(left|right|big|Big|bigg|Bigg)\s*', '', s)
    # 去末尾 .
    s = s.rstrip('.')
    # 去千位逗号(不是分隔符的逗号)· e.g. "1,234" → "1234"
    s = re.sub(r'(\d),(\d{3})(?=\D|$)', r'\1\2', s)
    # ⭐ 去所有空白(数学答案空格不影响语义 · "(3, -3)" == "(3,-3)" == "(3 ,-3 )")
    s = re.sub(r'\s+', '', s)
    return s


def parse_to_sympy(s: str):
    """LaTeX/text -> sympy.Expr · 失败返 None"""
    if not s:
        return None
    s = normalize_latex(s)
    if not s:
        return None
    # 1. Direct sympify(纯数字 / 简单算式)
    try:
        return sympy.sympify(s)
    except Exception:
        pass
    # 2. parse_latex(\frac{a}{b} 等 LaTeX)
    try:
        return parse_latex(s)
    except Exception:
        pass
    # 3. 处理 LaTeX 转 sympy 友好形式
    try:
        s2 = s
        s2 = re.sub(r'\\frac\s*\{([^}]+)\}\s*\{([^}]+)\}', r'(\1)/(\2)', s2)
        s2 = re.sub(r'\\sqrt\s*\{([^}]+)\}', r'sqrt(\1)', s2)
        s2 = re.sub(r'\\pi\b', 'pi', s2)
        s2 = s2.replace('\\cdot', '*').replace('\\times', '*')
        s2 = s2.replace('^', '**')
        return sympy.sympify(s2)
    except Exception:
        return None


def verify(model_output: str, gold_solution: str) -> dict:
    """主验证函数"""
    result = {
        "verified": False,
        "model_ans": None,
        "gold_ans": None,
        "method": None,
        "error": None,
    }

    # 抽答案
    model_ans = extract_boxed(model_output)
    gold_ans = extract_boxed(gold_solution)
    result["model_ans"] = model_ans
    result["gold_ans"] = gold_ans

    if model_ans is None:
        # Tail-number fallback: 模型用 markdown header / 自然语言写答案没用 \boxed{}
        # 在最后 800 字找 gold 数字(支持整数 / 小数 / 分数 a/b)
        gold_for_search = extract_boxed(gold_solution)
        if gold_for_search is not None:
            tail = model_output[-800:] if model_output else ""
            # 简化 gold:取数字 token
            gold_clean = re.sub(r'[\\\s${}]', '', gold_for_search)
            # 整数或小数
            if re.fullmatch(r'-?\d+(?:\.\d+)?', gold_clean):
                # 尾段必须含完整数字(word boundary)
                if re.search(rf'(?<![.\d]){re.escape(gold_clean)}(?![.\d])', tail):
                    result["verified"] = True
                    result["model_ans"] = f"[tail-match] {gold_clean}"
                    result["gold_ans"] = gold_for_search
                    result["method"] = "tail_number_match"
                    return result
        result["error"] = "model_output_no_boxed"
        return result
    if gold_ans is None:
        result["error"] = "gold_solution_no_boxed"
        return result

    # 1. 字符串完全 match(normalized)
    m_norm = normalize_latex(model_ans)
    g_norm = normalize_latex(gold_ans)
    if m_norm == g_norm:
        result["verified"] = True
        result["method"] = "string_match"
        return result

    # 2. sympy 符号简化
    m_expr = parse_to_sympy(model_ans)
    g_expr = parse_to_sympy(gold_ans)

    if m_expr is None or g_expr is None:
        result["method"] = "parse_fail"
        result["error"] = f"parse: model={m_expr is None}, gold={g_expr is None}"
        return result

    try:
        diff = sympy.simplify(m_expr - g_expr)
        if diff == 0:
            result["verified"] = True
            result["method"] = "sympy_simplify"
            return result
    except Exception as e:
        result["error"] = f"simplify_fail: {type(e).__name__}"

    # 3. 数值比对(浮点容忍)
    try:
        m_float = float(m_expr.evalf())
        g_float = float(g_expr.evalf())
        if abs(m_float - g_float) < 1e-6:
            result["verified"] = True
            result["method"] = "numeric_match"
            return result
    except Exception:
        pass

    result["method"] = "no_match"
    return result


# Self-test · 不显示题目内容 · 只检查 verifier 行为
def _selftest():
    cases = [
        # (model_output, gold_solution, expected_verified, description)
        (r"... so \boxed{42}", r"... thus \boxed{42}", True, "exact int"),
        (r"... \boxed{1/2}", r"... \boxed{\frac{1}{2}}", True, "frac vs decimal form"),
        (r"\boxed{0.5}", r"\boxed{\frac{1}{2}}", True, "decimal vs frac"),
        (r"\boxed{\sqrt{2}}", r"\boxed{2^{1/2}}", True, "sqrt forms"),
        (r"\boxed{42}", r"\boxed{43}", False, "wrong answer"),
        (r"no boxed here", r"\boxed{x}", False, "model didn't box"),
        (r"\boxed{2\pi}", r"\boxed{2\pi}", True, "pi exact"),
        (r"answer is 5", r"\boxed{5}", True, "fallback regex"),
        (r"\boxed{(3, -3)}", r"\boxed{(3,-3)}", True, "ordered pair whitespace"),
        (r"\boxed{1,234}", r"\boxed{1234}", True, "thousand separator"),
        (r"\boxed{\left( 1, 2 \right)}", r"\boxed{(1,2)}", True, "left/right delimiters"),
    ]
    n_pass = 0
    for i, (mo, gs, expected, desc) in enumerate(cases):
        r = verify(mo, gs)
        ok = r["verified"] == expected
        n_pass += int(ok)
        status = "✓" if ok else "✗"
        print(f"  {status} case {i}: {desc} → verified={r['verified']} method={r['method']}")
    print(f"\n[selftest] {n_pass}/{len(cases)} passed")
    return n_pass == len(cases)


if __name__ == "__main__":
    _selftest()
