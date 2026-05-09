#!/usr/bin/env python3
"""
ToolAbstain · Qwen 3.5 vs 3.6 35B-A3B head-to-head on SiliconFlow

Answers GitHub issue #5: 「qwen3.5 vs qwen3.6 35B A3B 的 toolcall 性能和得分对比」

Setup:
  - Both models served via SiliconFlow (same serving stack, same hardware tier)
  - 12 SHOULD_CALL questions (full v3 canonical set)
  - 2 trials each → 48 calls total
  - max_tokens=600 (Qwen 3.6 needs room for reasoning_content)
  - chat_template_kwargs.enable_thinking=false (best-effort, Qwen 3.6 still reasons)
"""
import json, os, time, urllib.request, urllib.error
from datetime import datetime
from pathlib import Path
from statistics import median

KEY = os.environ["SILICONFLOW_KEY"]
URL = "https://api.siliconflow.cn/v1/chat/completions"

MODELS = [
    {"name": "Qwen3.5-35B-A3B", "model": "Qwen/Qwen3.5-35B-A3B"},
    {"name": "Qwen3.6-35B-A3B", "model": "Qwen/Qwen3.6-35B-A3B"},
]

TOOLS = [
    {"type":"function","function":{"name":"web_search","description":"搜索互联网信息(新闻/百科/实时事件)",
        "parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
    {"type":"function","function":{"name":"get_weather","description":"查询某城市天气",
        "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}},
    {"type":"function","function":{"name":"get_stock","description":"查询股票价格",
        "parameters":{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}}},
    {"type":"function","function":{"name":"get_crypto","description":"查询加密货币价格",
        "parameters":{"type":"object","properties":{"coin":{"type":"string"}},"required":["coin"]}}},
    {"type":"function","function":{"name":"calculate","description":"数学计算",
        "parameters":{"type":"object","properties":{"expression":{"type":"string"}},"required":["expression"]}}},
    {"type":"function","function":{"name":"search_train","description":"查询高铁时刻表",
        "parameters":{"type":"object","properties":{"from_city":{"type":"string"},"to_city":{"type":"string"}},"required":["from_city","to_city"]}}},
    {"type":"function","function":{"name":"query_movie","description":"查询电影信息",
        "parameters":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}}},
]

# v3 canonical 12 SHOULD_CALL questions
QS = [
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


def call(model_id, prompt):
    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": prompt}],
        "tools": TOOLS,
        "tool_choice": "auto",
        "max_tokens": 600,
        "temperature": 0.3,
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type":"application/json","Authorization":f"Bearer {KEY}"},
        method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.load(r)
        ms = int((time.time()-t0)*1000)
        msg = d.get("choices",[{}])[0].get("message",{}) or {}
        tc = msg.get("tool_calls") or []
        return {
            "ok": True,
            "tcalls": len(tc),
            "tool_names": [x.get("function",{}).get("name") for x in tc],
            "content": (msg.get("content") or "")[:200],
            "reasoning_len": len(msg.get("reasoning_content") or ""),
            "ms": ms,
            "usage": d.get("usage", {}),
        }
    except urllib.error.HTTPError as e:
        try: body = e.read().decode("utf-8","replace")[:200]
        except: body = ""
        return {"ok": False, "err": f"HTTP {e.code}: {body}", "ms": int((time.time()-t0)*1000)}
    except Exception as e:
        return {"ok": False, "err": f"{type(e).__name__}: {str(e)[:160]}", "ms": int((time.time()-t0)*1000)}


def main():
    rows = []
    n_trials = 2

    for m_cfg in MODELS:
        print(f"\n=== {m_cfg['name']} ({m_cfg['model']}) ===", flush=True)
        for trial in range(n_trials):
            print(f"\n  trial {trial+1}/{n_trials}:", flush=True)
            for qid, q in QS:
                r = call(m_cfg['model'], q)
                if r.get("ok"):
                    score = 1 if r["tcalls"] > 0 else 0
                else:
                    score = None
                rec = {"model": m_cfg["name"], "trial": trial, "qid": qid, "score": score, **r}
                rows.append(rec)

                tag = "🛠" if r.get("tcalls",0) > 0 else "📝" if r.get("content") else "❌"
                tn = ",".join(r.get("tool_names",[]) or [])
                err = f" [{r.get('err','')[:60]}]" if not r.get("ok") else ""
                think = f" (think={r.get('reasoning_len',0)})" if r.get("reasoning_len",0) else ""
                print(f"    {qid:3s} {tag} tc={r.get('tcalls','?')} ms={r.get('ms','?')} [{tn}]{think}{err}", flush=True)
                time.sleep(0.5)

    # Aggregate per model per question
    print(f"\n\n{'='*90}\nA/B comparison · Qwen 3.5 vs 3.6 35B-A3B (12 SHOULD_CALL × {n_trials} trials)\n{'='*90}", flush=True)
    print(f"{'qid':<5} | {'Q3.5 0/1/2':<12} | {'Q3.6 0/1/2':<12} | Δ recall", flush=True)
    print("-" * 60, flush=True)
    for qid, _ in QS:
        q35 = [r for r in rows if r["qid"]==qid and r["model"]=="Qwen3.5-35B-A3B" and r["score"] is not None]
        q36 = [r for r in rows if r["qid"]==qid and r["model"]=="Qwen3.6-35B-A3B" and r["score"] is not None]
        s35 = sum(r["score"] for r in q35)
        s36 = sum(r["score"] for r in q36)
        d35 = s35 / len(q35) if q35 else 0
        d36 = s36 / len(q36) if q36 else 0
        delta = (d36 - d35) * 100
        print(f"{qid:<5} | {s35}/{len(q35)} ({d35:.0%})   | {s36}/{len(q36)} ({d36:.0%})   | {delta:+.0f}pp", flush=True)

    # Overall
    q35 = [r for r in rows if r["model"]=="Qwen3.5-35B-A3B" and r["score"] is not None]
    q36 = [r for r in rows if r["model"]=="Qwen3.6-35B-A3B" and r["score"] is not None]
    s35 = sum(r["score"] for r in q35)
    s36 = sum(r["score"] for r in q36)
    print(f"\nOverall:")
    print(f"  Qwen 3.5-35B-A3B: {s35}/{len(q35)} ({s35/max(len(q35),1):.1%}) recall")
    print(f"  Qwen 3.6-35B-A3B: {s36}/{len(q36)} ({s36/max(len(q36),1):.1%}) recall")
    print(f"  Δ: {(s36/max(len(q36),1) - s35/max(len(q35),1))*100:+.1f} pp")

    # Latency stats
    lat35 = [r["ms"] for r in q35 if r.get("ms")]
    lat36 = [r["ms"] for r in q36 if r.get("ms")]
    if lat35 and lat36:
        print(f"\nLatency (median):")
        print(f"  Qwen 3.5: {median(lat35):.0f} ms")
        print(f"  Qwen 3.6: {median(lat36):.0f} ms")

    # Reasoning length stats
    rl35 = [r["reasoning_len"] for r in q35 if r.get("reasoning_len",0) > 0]
    rl36 = [r["reasoning_len"] for r in q36 if r.get("reasoning_len",0) > 0]
    print(f"\nThinking output:")
    print(f"  Qwen 3.5 reasoning_content: {len(rl35)}/{len(q35)} responses, median {median(rl35) if rl35 else 0} chars")
    print(f"  Qwen 3.6 reasoning_content: {len(rl36)}/{len(q36)} responses, median {median(rl36) if rl36 else 0} chars")

    # Save
    out = Path(__file__).parent / f"qwen35_vs_36_siliconflow_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    out.write_text(json.dumps({
        "ts": datetime.now().isoformat(),
        "n_trials": n_trials,
        "questions": [q[0] for q in QS],
        "models": [m["model"] for m in MODELS],
        "rows": rows,
    }, ensure_ascii=False, indent=2))
    print(f"\n💾 saved → {out}", flush=True)


if __name__ == "__main__":
    main()
