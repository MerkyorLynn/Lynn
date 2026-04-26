"""
HumanEval+ pytest verifier · 在子进程沙箱跑模型生成的 code

输入:
    model_output: LLM 输出文本(可能含 ```python``` 代码块 / 函数定义)
    gold: dict { 'tests': pytest unit-test code, 'entry_point': function name, 'prompt': original prompt }

返回:
    {verified, model_ans, gold_ans, method, error}
"""
import re
import os
import subprocess
import tempfile
from typing import Optional


def extract_code(text: str, entry_point: Optional[str] = None) -> Optional[str]:
    """从模型输出抽 Python code"""
    if not text:
        return None

    # 1. ```python ... ``` 代码块
    blocks = re.findall(r'```(?:python)?\s*\n(.+?)\n```', text, re.DOTALL)
    if blocks:
        # 选含 entry_point def 的 block
        if entry_point:
            for b in blocks:
                if f'def {entry_point}' in b:
                    return b.strip()
        return blocks[-1].strip()  # 最后一个 block(通常是答案)

    # 2. 直接找 def entry_point
    if entry_point:
        m = re.search(rf'(def\s+{re.escape(entry_point)}\s*\(.*?)(?=\n(?:def\s|class\s|\Z))', text, re.DOTALL)
        if m:
            return m.group(1).strip()

    # 3. 整个文本 strip 当 code(无围栏)
    return text.strip()


def verify(model_output: str, gold: dict) -> dict:
    """
    gold = {'tests': str, 'entry_point': str, 'prompt': str}
    """
    if isinstance(gold, str):
        # 兼容 · 如果 gold 是字符串 · 没法 verify
        return {"verified": False, "model_ans": None, "gold_ans": None,
                "method": "gold_not_dict", "error": "gold must be dict for code verifier"}

    entry_point = gold.get("entry_point", "")
    tests = gold.get("tests", "")
    prompt = gold.get("prompt", "")  # 含 import / docstring

    code = extract_code(model_output, entry_point)
    if not code:
        return {"verified": False, "model_ans": None, "gold_ans": entry_point,
                "method": "no_code_extracted", "error": "extraction failed"}

    # 拼接完整 program · 加 prompt 头(import / type hint)
    # 模型 code 可能不包含 import · 用 prompt 的 imports
    prompt_imports = ""
    for line in prompt.split("\n"):
        if line.startswith("from ") or line.startswith("import "):
            prompt_imports += line + "\n"

    full_program = f"""{prompt_imports}
{code}

{tests}

# Run check
check({entry_point})
"""

    # Sandbox · 子进程 · 10s timeout · 不联网
    with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False) as f:
        f.write(full_program)
        path = f.name

    try:
        result = subprocess.run(
            ["python3", path],
            timeout=15,
            capture_output=True,
            text=True,
            env={"PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1"},
        )
        passed = result.returncode == 0
        err = (result.stderr or "")[:500]
        return {
            "verified": passed,
            "model_ans": entry_point if passed else "fail",
            "gold_ans": entry_point,
            "method": "pytest_pass" if passed else "pytest_fail",
            "error": err if not passed else None,
        }
    except subprocess.TimeoutExpired:
        return {"verified": False, "model_ans": None, "gold_ans": entry_point,
                "method": "exec_timeout", "error": "code execution > 15s"}
    except Exception as e:
        return {"verified": False, "model_ans": None, "gold_ans": entry_point,
                "method": "exec_error", "error": f"{type(e).__name__}: {str(e)[:200]}"}
    finally:
        try:
            os.unlink(path)
        except Exception:
            pass


def _selftest():
    # 简单测试 · 不实际跑 HumanEval
    cases = [
        # 模型完整正确 add 函数
        ("```python\ndef add(a, b):\n    return a + b\n```",
         {"entry_point": "add", "tests": "def check(f):\n    assert f(1,2) == 3\n    assert f(0,0) == 0",
          "prompt": ""},
         True, "valid add func"),

        # 模型错答案
        ("```python\ndef add(a, b):\n    return a - b\n```",
         {"entry_point": "add", "tests": "def check(f):\n    assert f(1,2) == 3",
          "prompt": ""},
         False, "wrong impl"),

        # 模型没给 code
        ("I think the answer is 42",
         {"entry_point": "add", "tests": "def check(f):\n    assert f(1,2) == 3",
          "prompt": ""},
         False, "no code in output"),
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
