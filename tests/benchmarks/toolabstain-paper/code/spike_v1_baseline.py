#!/usr/bin/env python3
"""
ToolAbstain Spike v1 · Full-fleet baseline
==========================================

Run *only* C0 baseline (tool_choice=auto, no system, original tool names) on:

  · DeepSeek V4-Pro / V4-Flash
  · Step-3.5-Flash
  · MiniMax M2.7
  · GLM-5-Turbo / GLM-5.1
  · Qwen3.6-Plus / Qwen3.6-Flash (Alibaba)
  · Kimi K2.5 (via AlayaNew alt endpoint)
  · MiMo 2.5 Pro (Xiaomi)
  · HY3-Preview (OpenRouter free)
  · Gemini-2.5-Flash (OpenAI-compat /v1beta/openai/)

12 SHOULD_CALL (full v3 set) + 3 SHOULDN'T_CALL = 15 questions per provider.

Goal: confirm whether the "cloud refuses to call tools" finding is still
reproducible on current model versions (2026-05). If recall is < 100% for
any provider on >=3 questions, that's a real refusal pocket worth deeper
intervention testing.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path

# ────────────────────────────────────────────────────────────────────────
# Provider config (key + url + model)
# ────────────────────────────────────────────────────────────────────────
PROVIDERS = [
    # DeepSeek family
    {"name": "DeepSeek-V4-Pro", "url": "https://api.deepseek.com/v1/chat/completions",
     "model": "deepseek-v4-pro", "key": os.getenv("DEEPSEEK_API_KEY", ""),
     "sleep": 0.6},
    {"name": "DeepSeek-V4-Flash", "url": "https://api.deepseek.com/v1/chat/completions",
     "model": "deepseek-v4-flash", "key": os.getenv("DEEPSEEK_API_KEY", ""),
     "sleep": 0.6},
    # GLM
    {"name": "GLM-5-Turbo", "url": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
     "model": "GLM-5-Turbo", "key": os.getenv("ZHIPU_API_KEY", ""),
     "sleep": 0.6},
    {"name": "GLM-5.1", "url": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
     "model": "GLM-5.1", "key": os.getenv("ZHIPU_API_KEY", ""),
     "sleep": 0.6},
    # Step
    {"name": "Step-3.5-Flash", "url": "https://api.stepfun.com/v1/chat/completions",
     "model": "step-3.5-flash", "key": os.getenv("STEPFUN_API_KEY", ""),
     "sleep": 3.0},  # RPM tight
    # MiniMax
    {"name": "MiniMax-M2.7", "url": "https://api.minimaxi.com/v1/chat/completions",
     "model": "MiniMax-M2.7-highspeed",
     "key": os.getenv("MINIMAX_API_KEY", ""),
     "sleep": 1.0},
    # Qwen3.6-Plus skipped — DashScope intl free-tier exhausted (HTTP 403)
    # Kimi K2.5 via AlayaNew alt endpoint (Kimi for-Coding 403 on direct API)
    {"name": "Kimi-K2.5-via-AlayaNew", "url": "https://codingplan.alayanew.com/v1/chat/completions",
     "model": "kimi-k2.5", "key": os.getenv("ALAYANEW_API_KEY", ""),
     "sleep": 0.8},
    # MiMo 2.5 Pro (Xiaomi token-plan-cn)
    {"name": "MiMo-2.5-Pro", "url": "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
     "model": "mimo-v2.5-pro", "key": os.getenv("MIMO_API_KEY", ""),
     "sleep": 0.8},
    # HY3 via OpenRouter (Tencent free tier)
    {"name": "HY3-Preview", "url": "https://openrouter.ai/api/v1/chat/completions",
     "model": "tencent/hy3-preview:free",
     "key": os.getenv("OPENROUTER_API_KEY", ""),
     "sleep": 1.5},
    # Gemini-2.5 skipped — API key marked as leaked, needs rotation
]

# ────────────────────────────────────────────────────────────────────────
TOOLS = [
    {"type": "function", "function": {"name": "web_search", "description": "搜索互联网信息(新闻/百科/实时事件)",
        "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
    {"type": "function", "function": {"name": "get_weather", "description": "查询某城市天气",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}, "days": {"type": "integer", "default": 1}}, "required": ["city"]}}},
    {"type": "function", "function": {"name": "get_stock", "description": "查询股票价格",
        "parameters": {"type": "object", "properties": {"symbol": {"type": "string"}}, "required": ["symbol"]}}},
    {"type": "function", "function": {"name": "get_crypto", "description": "查询加密货币价格",
        "parameters": {"type": "object", "properties": {"coin": {"type": "string"}}, "required": ["coin"]}}},
    {"type": "function", "function": {"name": "calculate", "description": "数学计算",
        "parameters": {"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]}}},
    {"type": "function", "function": {"name": "search_train", "description": "查询高铁时刻表",
        "parameters": {"type": "object", "properties": {"from_city": {"type": "string"}, "to_city": {"type": "string"}, "date": {"type": "string"}}, "required": ["from_city", "to_city"]}}},
    {"type": "function", "function": {"name": "query_movie", "description": "查询电影信息",
        "parameters": {"type": "object", "properties": {"title": {"type": "string"}, "year": {"type": "integer"}}, "required": ["title"]}}},
    {"type": "function", "function": {"name": "send_email", "description": "发送邮件",
        "parameters": {"type": "object", "properties": {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}}, "required": ["to", "subject", "body"]}}},
    {"type": "function", "function": {"name": "extract_entities", "description": "从文本中提取人名/地名/机构名",
        "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}},
    {"type": "function", "function": {"name": "summarize", "description": "总结长文本",
        "parameters": {"type": "object", "properties": {"text": {"type": "string"}, "max_words": {"type": "integer", "default": 200}}, "required": ["text"]}}},
]

# 12 SHOULD_CALL = full v3 basic set
SHOULD_CALL = [
    ("N1", "今天国内外最大的新闻是什么？给我 3 条不同领域的（科技/经济/国际），并按影响力排序。"),
    ("N2", "DeepSeek 最近发布了什么新模型？对比 Qwen3.6 的发布时间和参数规模，给我结论。"),
    ("E1", "最近有什么好看的华语悬疑片？按豆瓣评分排序，告诉我前 3 名。"),
    ("E2", "2026 年春节档有哪三部电影？帮我同时查它们的豆瓣评分和导演。"),
    ("L1", "我下周要去上海出差 3 天（周一到周三），查下这 3 天的天气。"),
    ("L2", "查一下北京今天、明天、后天的温度，告诉我哪一天最适合穿短袖。"),
    ("W1", "帮我同时查阿里、腾讯、美团三家今天的股价和涨跌幅。"),
    ("W2", "帮我订一张后天从北京到上海的高铁票，10 点之后出发，二等座。"),
    ("F1", "今天上证指数是多少？和一周前比涨了百分之多少？"),
    ("F2", "比特币现在价格是多少？和 2026 年 3 月 1 日相比，涨跌幅怎么样？"),
    ("S1", "NBA 昨天有哪些比赛？湖人打赢了吗？告诉我最终比分。"),
    ("S2", "中国男足最近 3 场世界杯预选赛的对手和比分是什么？"),
]

# 3 SHOULDN'T_CALL = control group
SHOULDNT_CALL = [
    ("CTRL_CREATIVE", "请写一首 8 句关于'中年危机'的现代诗，不要用排比句。"),
    ("CTRL_KNOWLEDGE", "请用 100 字解释什么是熵增定律，不要给例子，只讲核心物理含义。"),
    ("CTRL_REASONING", "如果一个房间有 4 个人，每两个人之间握一次手，一共握了多少次手？请用中文一句话给答案，不要列举。"),
]

# ────────────────────────────────────────────────────────────────────────
def call_provider(prov, question, timeout=60):
    key = prov.get("key") or os.environ.get(prov.get("key_env", ""))
    if not key:
        return {"error": f"missing key for {prov['name']}"}

    payload = {
        "model": prov["model"],
        "messages": [{"role": "user", "content": question}],
        "tools": TOOLS,
        "tool_choice": "auto",
        "max_tokens": 500,
        "temperature": 0.3,
        "stream": False,
    }

    req = urllib.request.Request(
        prov["url"],
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
            "content_head": content[:160],
            "latency_ms": latency_ms,
            "error": None,
        }
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        return {"error": f"HTTP {e.code}: {body}", "latency_ms": int((time.time() - t0) * 1000)}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {str(e)[:200]}", "latency_ms": int((time.time() - t0) * 1000)}


def score(kind, result):
    if result.get("error"):
        return None
    if kind == "SHOULD":
        return 1 if result["tool_calls_n"] > 0 else 0
    return 1 if result["tool_calls_n"] == 0 else 0


def main():
    only = set(sys.argv[1:]) if len(sys.argv) > 1 else None
    out_dir = Path(__file__).parent
    out_path = out_dir / f"spike_v1_baseline_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"

    results = []
    for prov in PROVIDERS:
        if only and prov["name"] not in only:
            continue
        print(f"\n=== {prov['name']} ({prov['model']}) ===", flush=True)

        for qid, q in SHOULD_CALL:
            r = call_provider(prov, q)
            rec = {"provider": prov["name"], "model": prov["model"], "qid": qid, "kind": "SHOULD", **r}
            rec["score"] = score("SHOULD", r)
            results.append(rec)

            tag = "🛠" if r.get("tool_calls_n", 0) > 0 else "📝" if r.get("content_len", 0) else "❌"
            err = f" [{r['error'][:50]}]" if r.get("error") else ""
            tn = ",".join(r.get("tool_names", []) or []) if not r.get("error") else ""
            print(f"  {qid:4s} {tag} tcalls={r.get('tool_calls_n','?'):>2} clen={r.get('content_len','?'):>4} {r.get('latency_ms','?'):>5}ms  [{tn}]{err}", flush=True)
            time.sleep(prov.get("sleep", 0.6))

        for qid, q in SHOULDNT_CALL:
            r = call_provider(prov, q)
            rec = {"provider": prov["name"], "model": prov["model"], "qid": qid, "kind": "SHOULDNT", **r}
            rec["score"] = score("SHOULDNT", r)
            results.append(rec)

            tag = "🛠" if r.get("tool_calls_n", 0) > 0 else "📝" if r.get("content_len", 0) else "❌"
            err = f" [{r['error'][:50]}]" if r.get("error") else ""
            tn = ",".join(r.get("tool_names", []) or []) if not r.get("error") else ""
            print(f"  {qid:14s} {tag} tcalls={r.get('tool_calls_n','?'):>2} clen={r.get('content_len','?'):>4} {r.get('latency_ms','?'):>5}ms  [{tn}]{err}", flush=True)
            time.sleep(prov.get("sleep", 0.6))

    # Aggregate
    print("\n\n========== BASELINE LEADERBOARD ==========", flush=True)
    print(f"{'Provider':<26} {'Recall (SHOULD/12)':<22} {'Spec (SHOULDNT/3)':<22} {'Net':<8} {'Errs'}", flush=True)
    print("-" * 95, flush=True)

    summary = []
    for prov in PROVIDERS:
        if only and prov["name"] not in only:
            continue
        should = [r for r in results if r["provider"] == prov["name"] and r["kind"] == "SHOULD"]
        shouldnt = [r for r in results if r["provider"] == prov["name"] and r["kind"] == "SHOULDNT"]
        s_ok = [r["score"] for r in should if r["score"] is not None]
        sn_ok = [r["score"] for r in shouldnt if r["score"] is not None]
        n_errs = sum(1 for r in (should + shouldnt) if r.get("error"))
        recall = sum(s_ok) / len(s_ok) if s_ok else 0.0
        spec = sum(sn_ok) / len(sn_ok) if sn_ok else 0.0
        net = (recall + spec) / 2 if s_ok and sn_ok else (recall or spec)
        # which SHOULD questions did the model REFUSE to call tools on
        refused = [r["qid"] for r in should if r["score"] == 0]
        # which SHOULDN'T did it overcall on
        overcalled = [r["qid"] for r in shouldnt if r["score"] == 0]

        summary.append({
            "provider": prov["name"], "model": prov["model"],
            "recall": recall, "specificity": spec, "net": net,
            "errors": n_errs,
            "refused_questions": refused,
            "overcalled_questions": overcalled,
            "n_should": len(s_ok), "n_shouldnt": len(sn_ok),
        })
        print(f"{prov['name']:<26} {sum(s_ok)}/{len(s_ok)} ({recall:>5.1%})        "
              f"{sum(sn_ok)}/{len(sn_ok)} ({spec:>5.1%})        "
              f"{net:>6.1%}  {n_errs}",
              flush=True)
        if refused:
            print(f"   ↳ refused tools on: {','.join(refused)}", flush=True)
        if overcalled:
            print(f"   ↳ overcalled tools on: {','.join(overcalled)}", flush=True)

    out = {
        "spike": "ToolAbstain v1 baseline",
        "ts": datetime.now().isoformat(),
        "n_should": len(SHOULD_CALL),
        "n_shouldnt": len(SHOULDNT_CALL),
        "providers": [p["name"] for p in PROVIDERS if not only or p["name"] in only],
        "raw_results": results,
        "summary": summary,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\n💾 Saved to {out_path}", flush=True)


if __name__ == "__main__":
    main()
