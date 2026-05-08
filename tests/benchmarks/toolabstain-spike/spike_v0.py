#!/usr/bin/env python3
"""
ToolAbstain Spike v0
====================
Test 4 cheap interventions on tool-call abstention failure:

  C0  baseline           (tool_choice=auto, no system, generic tool names)
  C1  strong system      (replicate Lynn's prior 0/5 negative result)
  C2  in-context few-shot (2 demo turns showing tool calls)
  C3  tool_choice=required (ceiling — does it emit usable tool_calls?)

3 cloud models × 4 conditions × (5 SHOULD_CALL + 2 SHOULDN'T_CALL) = 84 calls.

Metric:
  SHOULD recall      = tool_calls emitted on SHOULD_CALL questions / 5
  SHOULDN'T spec.    = tool_calls absent on SHOULDN'T_CALL questions / 2
  Net score          = (recall + specificity) / 2

Output: JSON + markdown summary.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime

# ────────────────────────────────────────────────────────────────────────
# Provider config
# ────────────────────────────────────────────────────────────────────────
PROVIDERS = [
    {
        "name": "GLM-5-Turbo",
        "url": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
        "model": "GLM-5-Turbo",
        "key_env": "ZHIPU_CODING_KEY",
        "key_default": os.getenv("ZHIPU_API_KEY", ""),
    },
    {
        "name": "Step-3.5-Flash",
        "url": "https://api.stepfun.com/v1/chat/completions",
        "model": "step-3.5-flash",
        "key_env": "STEP_KEY",
        "key_default": os.getenv("STEPFUN_API_KEY", ""),
    },
    {
        "name": "DeepSeek-V4-Flash",
        "url": "https://api.deepseek.com/v1/chat/completions",
        "model": "deepseek-chat",
        "key_env": "DEEPSEEK_KEY",
        "key_default": os.getenv("DEEPSEEK_API_KEY", ""),
    },
]

# ────────────────────────────────────────────────────────────────────────
# Tool definitions (same 5 used in Lynn's ab-test for parity)
# ────────────────────────────────────────────────────────────────────────
TOOLS = [
    {"type": "function", "function": {
        "name": "web_search",
        "description": "搜索互联网信息(新闻/百科/实时事件)",
        "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "get_weather",
        "description": "查询某城市天气",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}, "days": {"type": "integer", "default": 1}}, "required": ["city"]}}},
    {"type": "function", "function": {
        "name": "get_stock",
        "description": "查询股票价格",
        "parameters": {"type": "object", "properties": {"symbol": {"type": "string"}}, "required": ["symbol"]}}},
    {"type": "function", "function": {
        "name": "get_crypto",
        "description": "查询加密货币价格",
        "parameters": {"type": "object", "properties": {"coin": {"type": "string"}}, "required": ["coin"]}}},
    {"type": "function", "function": {
        "name": "calculate",
        "description": "数学计算",
        "parameters": {"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]}}},
]

# ────────────────────────────────────────────────────────────────────────
# Test set
# ────────────────────────────────────────────────────────────────────────
SHOULD_CALL = [
    ("N1", "今天国内外最大的新闻是什么？给我 3 条不同领域的（科技/经济/国际），并按影响力排序。"),
    ("L2", "查一下北京今天、明天、后天的温度，告诉我哪一天最适合穿短袖。"),
    ("W1", "帮我同时查阿里、腾讯、美团三家今天的股价和涨跌幅。"),
    ("F1", "今天上证指数是多少？和一周前比涨了百分之多少？"),
    ("S1", "NBA 昨天有哪些比赛？湖人打赢了吗？告诉我最终比分。"),
]

# Control group: questions where tool calls are unwarranted
SHOULDNT_CALL = [
    ("CTRL_CREATIVE", "请写一首 8 句关于'中年危机'的现代诗，不要用排比句。"),
    ("CTRL_KNOWLEDGE", "请用 100 字解释什么是熵增定律，不要给例子，只讲核心物理含义。"),
]

STRONG_SYSTEM = """你是一个 AI Agent，可以调用工具。规则：
1. 当用户问题涉及【实时信息】（新闻、天气、股价、比分、当前时间等），你【必须】调用对应工具获取最新数据，【不允许】凭记忆直接回答。
2. 需要多个数据点时，【优先并行调用】多个工具（一次返回多个 tool_calls）。
3. 如果没有合适工具，才用自然语言回答。
请严格遵守以上规则。"""

FEWSHOT_PREFIX = [
    {"role": "user", "content": "今天美股道琼斯指数怎么样？"},
    {"role": "assistant", "content": "", "tool_calls": [
        {"id": "call_demo1", "type": "function",
         "function": {"name": "get_stock", "arguments": json.dumps({"symbol": "DJI"}, ensure_ascii=False)}}]},
    {"role": "tool", "tool_call_id": "call_demo1",
     "content": json.dumps({"price": 38500, "change_pct": 0.8}, ensure_ascii=False)},
    {"role": "assistant", "content": "今天道琼斯指数 38500 点，上涨 0.8%。"},

    {"role": "user", "content": "上海明天会下雨吗？"},
    {"role": "assistant", "content": "", "tool_calls": [
        {"id": "call_demo2", "type": "function",
         "function": {"name": "get_weather", "arguments": json.dumps({"city": "上海", "days": 2}, ensure_ascii=False)}}]},
    {"role": "tool", "tool_call_id": "call_demo2",
     "content": json.dumps({"forecast": [{"day": "今天", "weather": "晴"}, {"day": "明天", "weather": "小雨"}]}, ensure_ascii=False)},
    {"role": "assistant", "content": "上海明天预计有小雨。"},
]

# ────────────────────────────────────────────────────────────────────────
def build_messages(condition: str, question: str):
    """Build chat messages per condition."""
    msgs = []

    if condition == "C0_baseline":
        msgs.append({"role": "user", "content": question})

    elif condition == "C1_system":
        msgs.append({"role": "system", "content": STRONG_SYSTEM})
        msgs.append({"role": "user", "content": question})

    elif condition == "C2_fewshot":
        msgs.append({"role": "system", "content": "你是 AI 助手，可以调用工具。"})
        msgs.extend(FEWSHOT_PREFIX)
        msgs.append({"role": "user", "content": question})

    elif condition == "C3_required":
        # Same as baseline but force tool_choice=required
        msgs.append({"role": "user", "content": question})

    return msgs


def call_provider(provider, condition, question_id, question, timeout=60):
    key = os.environ.get(provider["key_env"]) or provider["key_default"]
    if not key:
        return {"error": f"missing key for {provider['name']}"}

    messages = build_messages(condition, question)

    payload = {
        "model": provider["model"],
        "messages": messages,
        "tools": TOOLS,
        "tool_choice": "required" if condition == "C3_required" else "auto",
        "max_tokens": 500,
        "temperature": 0.3,
        "stream": False,
    }

    req = urllib.request.Request(
        provider["url"],
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.load(r)
        latency_ms = int((time.time() - t0) * 1000)
        msg = data.get("choices", [{}])[0].get("message", {}) or {}
        tool_calls = msg.get("tool_calls") or []
        content = msg.get("content") or ""
        tool_names = [tc.get("function", {}).get("name") for tc in tool_calls]
        return {
            "tool_calls_n": len(tool_calls),
            "tool_names": tool_names,
            "content_len": len(content),
            "content_head": content[:120],
            "latency_ms": latency_ms,
            "error": None,
        }
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        return {"error": f"HTTP {e.code}: {body}", "latency_ms": int((time.time() - t0) * 1000)}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {str(e)[:200]}", "latency_ms": int((time.time() - t0) * 1000)}


def score_call(question_kind, result):
    """Score a single call. SHOULD_CALL: 1 if tool_calls. SHOULDN'T_CALL: 1 if no tool_calls."""
    if result.get("error"):
        return None  # exclude from denominator
    if question_kind == "SHOULD":
        return 1 if result["tool_calls_n"] > 0 else 0
    else:  # SHOULDNT
        return 1 if result["tool_calls_n"] == 0 else 0


# ────────────────────────────────────────────────────────────────────────
def main():
    conditions = ["C0_baseline", "C1_system", "C2_fewshot", "C3_required"]
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            f"spike_v0_results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")

    results = []
    for prov in PROVIDERS:
        print(f"\n=== {prov['name']} ({prov['model']}) ===", flush=True)
        for condition in conditions:
            print(f"  -- {condition}", flush=True)
            for qid, q in SHOULD_CALL:
                r = call_provider(prov, condition, qid, q)
                rec = {
                    "provider": prov["name"], "condition": condition,
                    "qid": qid, "kind": "SHOULD",
                    **r,
                }
                rec["score"] = score_call("SHOULD", r)
                results.append(rec)
                tag = "🛠" if r.get("tool_calls_n", 0) > 0 else "📝" if r.get("content_len", 0) else "❌"
                err = f" [err: {r['error'][:60]}]" if r.get("error") else ""
                print(f"     {qid:4s} {tag} tcalls={r.get('tool_calls_n','?'):>2}  "
                      f"clen={r.get('content_len','?'):>4}  {r.get('latency_ms','?'):>5}ms{err}",
                      flush=True)
                time.sleep(0.6)

            for qid, q in SHOULDNT_CALL:
                r = call_provider(prov, condition, qid, q)
                rec = {
                    "provider": prov["name"], "condition": condition,
                    "qid": qid, "kind": "SHOULDNT",
                    **r,
                }
                rec["score"] = score_call("SHOULDNT", r)
                results.append(rec)
                tag = "🛠" if r.get("tool_calls_n", 0) > 0 else "📝" if r.get("content_len", 0) else "❌"
                err = f" [err: {r['error'][:60]}]" if r.get("error") else ""
                print(f"     {qid:14s} {tag} tcalls={r.get('tool_calls_n','?'):>2}  "
                      f"clen={r.get('content_len','?'):>4}  {r.get('latency_ms','?'):>5}ms{err}",
                      flush=True)
                time.sleep(0.6)

    # Aggregate
    print("\n\n========== AGGREGATE ==========", flush=True)
    print(f"{'Provider':<22} {'Condition':<14} {'Recall(SHOULD)':<16} {'Spec(SHOULDNT)':<16} {'Net':<6} {'Errs'}", flush=True)
    print("-" * 90, flush=True)

    summary = []
    for prov in PROVIDERS:
        for condition in conditions:
            should = [r for r in results if r["provider"] == prov["name"] and r["condition"] == condition and r["kind"] == "SHOULD"]
            shouldnt = [r for r in results if r["provider"] == prov["name"] and r["condition"] == condition and r["kind"] == "SHOULDNT"]

            should_ok = [r["score"] for r in should if r["score"] is not None]
            shouldnt_ok = [r["score"] for r in shouldnt if r["score"] is not None]
            n_errs = sum(1 for r in (should + shouldnt) if r.get("error"))

            recall = sum(should_ok) / len(should_ok) if should_ok else 0.0
            spec = sum(shouldnt_ok) / len(shouldnt_ok) if shouldnt_ok else 0.0
            net = (recall + spec) / 2

            row = {
                "provider": prov["name"],
                "condition": condition,
                "recall_should": recall,
                "specificity_shouldnt": spec,
                "net": net,
                "errors": n_errs,
                "n_should": len(should_ok),
                "n_shouldnt": len(shouldnt_ok),
            }
            summary.append(row)
            print(f"{prov['name']:<22} {condition:<14} "
                  f"{sum(should_ok)}/{len(should_ok)} ({recall:>5.1%})    "
                  f"{sum(shouldnt_ok)}/{len(shouldnt_ok)} ({spec:>5.1%})    "
                  f"{net:>5.1%}  {n_errs}",
                  flush=True)

    out = {
        "spike": "ToolAbstain v0",
        "ts": datetime.now().isoformat(),
        "providers": [p["name"] for p in PROVIDERS],
        "conditions": conditions,
        "n_should": len(SHOULD_CALL),
        "n_shouldnt": len(SHOULDNT_CALL),
        "raw_results": results,
        "summary": summary,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\n💾 Saved to {out_path}", flush=True)


if __name__ == "__main__":
    main()
