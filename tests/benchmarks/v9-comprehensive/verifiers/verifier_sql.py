"""
SQL Verifier · sqlglot AST normalize 比对 · 不真 exec(简化)

输入:
    model_output: LLM 输出(可能含 ```sql```)
    gold_query: 标准 SQL query string

返回:
    {verified, model_ans, gold_ans, method, error}

方法:
    1. 抽 model SQL(从 ```sql``` 块或 SELECT 开头)
    2. 都 normalize(via sqlglot · sqlite dialect)
    3. AST string 比对
    4. fallback: token-level 比对(去 alias / 大小写无关)
"""
import re
from typing import Optional

import sqlglot
from sqlglot import exp


def extract_sql(text: str) -> Optional[str]:
    if not text:
        return None
    # 1. ```sql ... ``` block
    m = re.findall(r'```(?:sql|sqlite)?\s*\n(.+?)\n```', text, re.DOTALL | re.I)
    if m:
        return m[-1].strip()
    # 2. ```query``` 或 SQL 直接放
    m = re.findall(r'```\n?\s*(SELECT.+?)\n?```', text, re.DOTALL | re.I)
    if m:
        return m[-1].strip()
    # 3. 直接找 SELECT ... 直到末尾或换行段
    m = re.search(r'(SELECT\s.+?)(?:\n\n|\Z|;)', text, re.DOTALL | re.I)
    if m:
        return m.group(1).strip().rstrip(";").strip()
    return None


def normalize_sql(sql: str) -> Optional[str]:
    """normalize SQL via sqlglot"""
    if not sql:
        return None
    try:
        parsed = sqlglot.parse_one(sql, dialect="sqlite")
        if parsed is None:
            return None
        # normalize_identifiers + 大小写统一
        normalized = parsed.sql(dialect="sqlite", normalize=True, comments=False)
        return normalized.strip().lower().replace('"', '').replace("`", "")
    except Exception:
        return None


def verify(model_output: str, gold_query: str) -> dict:
    model_sql = extract_sql(model_output)
    if not model_sql:
        return {"verified": False, "model_ans": None, "gold_ans": gold_query,
                "method": "no_sql_extracted", "error": "extraction failed"}

    m_norm = normalize_sql(model_sql)
    g_norm = normalize_sql(gold_query)

    if m_norm is None:
        return {"verified": False, "model_ans": model_sql[:200], "gold_ans": gold_query,
                "method": "model_sql_unparseable", "error": "sqlglot parse failed"}
    if g_norm is None:
        return {"verified": False, "model_ans": model_sql[:200], "gold_ans": gold_query,
                "method": "gold_sql_unparseable", "error": "gold sqlglot parse failed"}

    # 1. AST normalized string match
    if m_norm == g_norm:
        return {"verified": True, "model_ans": m_norm[:200], "gold_ans": g_norm[:200],
                "method": "sqlglot_normalize_match", "error": None}

    # 2. fallback: token-level loose compare(去 alias / 空格 / 引号)
    def token_normalize(s: str) -> str:
        s = re.sub(r'\s+', ' ', s.lower().strip())
        s = re.sub(r'\s*\bas\s+\w+', '', s)  # 去 AS alias
        s = re.sub(r'[`"\']', '', s)  # 去引号
        s = re.sub(r'\s*([(),;])\s*', r'\1', s)  # 去标点周围空白
        return s

    if token_normalize(m_norm) == token_normalize(g_norm):
        return {"verified": True, "model_ans": m_norm[:200], "gold_ans": g_norm[:200],
                "method": "token_normalize_match", "error": None}

    return {"verified": False, "model_ans": m_norm[:200], "gold_ans": g_norm[:200],
            "method": "no_match", "error": None}


def _selftest():
    cases = [
        ("```sql\nSELECT name FROM students WHERE age > 20\n```",
         "SELECT name FROM students WHERE age > 20",
         True, "exact match"),
        ("```sql\nSELECT name FROM students WHERE age > 20\n```",
         "select students.name from students where students.age > 20",
         True, "case + table prefix · should match via normalize"),
        ("```sql\nSELECT * FROM t1\n```",
         "SELECT name FROM t1",
         False, "different cols"),
        ("answer is select name from students",
         "SELECT name FROM students",
         True, "no fence · still parseable"),
        ("I cannot generate SQL",
         "SELECT * FROM t",
         False, "no SQL extracted"),
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
