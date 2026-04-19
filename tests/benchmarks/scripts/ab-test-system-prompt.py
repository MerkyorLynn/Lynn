#!/usr/bin/env python3
"""
A/B 对比测试：有无 system prompt 对"调不调工具"的影响
- 2 模型: glm-5-turbo / Kimi K2.5
- 5 题: 全是"需要实时信息"的题
- 2 轮: Round A 无 system / Round B 加强 system prompt
- 共 20 次请求，~2 分钟
"""
import json
import time
import urllib.request
from datetime import datetime

BRAIN_URL = "http://127.0.0.1:8789/v1/chat/completions"

TOOLS = [
    {"type":"function","function":{"name":"web_search","description":"搜索互联网信息","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
    {"type":"function","function":{"name":"get_weather","description":"查询某城市天气","parameters":{"type":"object","properties":{"city":{"type":"string"},"days":{"type":"integer","default":1}},"required":["city"]}}},
    {"type":"function","function":{"name":"get_stock","description":"查询股票价格","parameters":{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}}},
    {"type":"function","function":{"name":"calculate","description":"数学计算","parameters":{"type":"object","properties":{"expression":{"type":"string"}},"required":["expression"]}}},
    {"type":"function","function":{"name":"get_crypto","description":"查询加密货币价格","parameters":{"type":"object","properties":{"coin":{"type":"string"}},"required":["coin"]}}},
]

# 挑 5 题都是"需要实时信息"、v3 里 GLM/Kimi 失败的典型
TESTS = [
    ("N1", "今天国内外最大的新闻是什么？给我 3 条不同领域的（科技/经济/国际），并按影响力排序。"),
    ("L2", "查一下北京今天、明天、后天的温度，告诉我哪一天最适合穿短袖。"),
    ("W1", "帮我同时查阿里、腾讯、美团三家今天的股价和涨跌幅。"),
    ("F1", "今天上证指数是多少？和一周前比涨了百分之多少？"),
    ("S1", "NBA 昨天有哪些比赛？湖人打赢了吗？告诉我最终比分。"),
]

SYSTEM_PROMPT = """你是一个 AI Agent，可以调用工具。规则：
1. 当用户问题涉及【实时信息】（新闻、天气、股价、比分、当前时间等），你【必须】调用对应工具获取最新数据，【不允许】凭记忆直接回答。
2. 需要多个数据点时，【优先并行调用】多个工具（一次返回多个 tool_calls）。
3. 如果没有合适工具，才用自然语言回答。
请严格遵守以上规则。"""

MODELS = [
    ("glm-5-turbo", "glm-5-turbo"),
    ("Kimi K2.5", "kimi-k25"),
]


def call_model(model_id, prompt, system=None):
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    payload = {
        "model": model_id,
        "messages": messages,
        "tools": TOOLS,
        "tool_choice": "auto",
        "max_tokens": 500,
        "temperature": 0.3,
        "stream": False,
    }
    req = urllib.request.Request(BRAIN_URL, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)
        latency = int((time.time() - t0) * 1000)
        msg = data["choices"][0]["message"]
        tool_calls = msg.get("tool_calls") or []
        content = msg.get("content") or ""
        return tool_calls, content, latency, None
    except Exception as e:
        return [], "", int((time.time() - t0) * 1000), f"{type(e).__name__}: {str(e)[:100]}"


def score(tool_calls, content, error):
    if error:
        return 0, f"❌ {error[:40]}"
    if not tool_calls:
        if content:
            return 1, "⚠️ 只写 content 不调工具"
        return 0, "❌ 空"
    return 3, f"✅ 调了 {len(tool_calls)} 个: {','.join(tc.get('function',{}).get('name','?') for tc in tool_calls[:3])}"


def main():
    print(f"\n{'='*78}")
    print(f"🔬 A/B 对比测试：有无 system prompt 的影响")
    print(f"{'='*78}\n")

    summary = {m: {"A": 0, "B": 0, "A_calls": 0, "B_calls": 0} for m, _ in MODELS}
    details = []

    for round_name, use_system in [("A 无 system", False), ("B 加 system", True)]:
        print(f"\n━━━━━ Round {round_name} ━━━━━")
        for mn, mid in MODELS:
            print(f"\n📊 {mn}")
            for tid, prompt in TESTS:
                sp = SYSTEM_PROMPT if use_system else None
                tc, content, lat, err = call_model(mid, prompt, system=sp)
                s, note = score(tc, content, err)
                print(f"  {tid}  {s}/3 · {lat:>5}ms · {note[:60]}")
                key = "A" if not use_system else "B"
                summary[mn][key] += s
                if tc:
                    summary[mn][f"{key}_calls"] += 1
                details.append({
                    "round": round_name, "model": mn, "tid": tid,
                    "score": s, "latency": lat, "note": note,
                    "called_tool": bool(tc),
                })
                time.sleep(0.3)

    # 总结表
    print(f"\n\n{'='*78}")
    print(f"📊 总结：有无 system prompt 对调用率的影响（5 题 × 3 分 = 15 满分）")
    print(f"{'='*78}\n")
    print(f"{'模型':<18} {'无 system (得分/调用率)':<28} {'有 system (得分/调用率)':<28} {'提升':<10}")
    print(f"{'-'*85}")
    for mn, _ in MODELS:
        sa = summary[mn]["A"]
        sb = summary[mn]["B"]
        ca = summary[mn]["A_calls"]
        cb = summary[mn]["B_calls"]
        delta = sb - sa
        arrow = "📈" if delta > 0 else ("📉" if delta < 0 else "→")
        print(f"{mn:<18} {sa}/15 · {ca}/5 调用率{'':<8} {sb}/15 · {cb}/5 调用率{'':<8} {arrow} +{delta}")

    # 写 JSON
    out = {
        "timestamp": datetime.now().isoformat(),
        "summary": summary,
        "details": details,
    }
    out_path = f"/tmp/ab-test-{datetime.now().strftime('%H%M')}.json"
    with open(out_path, "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\n✅ JSON: {out_path}")


if __name__ == "__main__":
    main()
