#!/usr/bin/env python3
"""Re-test the 5 suspect cases (Kimi/HY3 W1+W2 + Kimi CTRL) with 3 retries each
to disambiguate transient API errors from systematic refusal."""
import json, os, time, urllib.request, urllib.error, sys
from datetime import datetime
from pathlib import Path

TOOLS = [
    {"type":"function","function":{"name":"web_search","description":"搜索互联网信息(新闻/百科/实时事件)","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
    {"type":"function","function":{"name":"get_weather","description":"查询某城市天气","parameters":{"type":"object","properties":{"city":{"type":"string"},"days":{"type":"integer","default":1}},"required":["city"]}}},
    {"type":"function","function":{"name":"get_stock","description":"查询股票价格","parameters":{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}}},
    {"type":"function","function":{"name":"get_crypto","description":"查询加密货币价格","parameters":{"type":"object","properties":{"coin":{"type":"string"}},"required":["coin"]}}},
    {"type":"function","function":{"name":"calculate","description":"数学计算","parameters":{"type":"object","properties":{"expression":{"type":"string"}},"required":["expression"]}}},
    {"type":"function","function":{"name":"search_train","description":"查询高铁时刻表","parameters":{"type":"object","properties":{"from_city":{"type":"string"},"to_city":{"type":"string"},"date":{"type":"string"}},"required":["from_city","to_city"]}}},
    {"type":"function","function":{"name":"query_movie","description":"查询电影信息","parameters":{"type":"object","properties":{"title":{"type":"string"},"year":{"type":"integer"}},"required":["title"]}}},
    {"type":"function","function":{"name":"send_email","description":"发送邮件","parameters":{"type":"object","properties":{"to":{"type":"string"},"subject":{"type":"string"},"body":{"type":"string"}},"required":["to","subject","body"]}}},
    {"type":"function","function":{"name":"extract_entities","description":"从文本中提取人名/地名/机构名","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}},
    {"type":"function","function":{"name":"summarize","description":"总结长文本","parameters":{"type":"object","properties":{"text":{"type":"string"},"max_words":{"type":"integer","default":200}},"required":["text"]}}},
]

PROVIDERS_BY_NAME = {
    "Kimi-K2.5-via-AlayaNew": {
        "url": "https://codingplan.alayanew.com/v1/chat/completions",
        "model": "kimi-k2.5",
        "key": os.getenv("ALAYANEW_API_KEY", ""),
    },
    "HY3-Preview": {
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "tencent/hy3-preview:free",
        "key": os.getenv("OPENROUTER_API_KEY", ""),
    },
}

QUESTIONS = {
    "W1": "帮我同时查阿里、腾讯、美团三家今天的股价和涨跌幅。",
    "W2": "帮我订一张后天从北京到上海的高铁票，10 点之后出发，二等座。",
    "CTRL_CREATIVE": "请写一首 8 句关于'中年危机'的现代诗，不要用排比句。",
    "CTRL_KNOWLEDGE": "请用 100 字解释什么是熵增定律，不要给例子，只讲核心物理含义。",
}

SUSPECTS = [
    ("Kimi-K2.5-via-AlayaNew", "W1"),
    ("Kimi-K2.5-via-AlayaNew", "W2"),
    ("Kimi-K2.5-via-AlayaNew", "CTRL_CREATIVE"),
    ("Kimi-K2.5-via-AlayaNew", "CTRL_KNOWLEDGE"),
    ("HY3-Preview", "W1"),
    ("HY3-Preview", "W2"),
]

def call(prov_name, qid, retry_idx, timeout=60):
    p = PROVIDERS_BY_NAME[prov_name]
    payload = {
        "model": p["model"],
        "messages": [{"role": "user", "content": QUESTIONS[qid]}],
        "tools": TOOLS,
        "tool_choice": "auto",
        "max_tokens": 500,
        "temperature": 0.3,
        "stream": False,
    }
    req = urllib.request.Request(p["url"], data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type":"application/json","Authorization":f"Bearer {p['key']}"}, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.load(r)
        ms = int((time.time()-t0)*1000)
        msg = data.get("choices",[{}])[0].get("message",{}) or {}
        tc = msg.get("tool_calls") or []
        return {"ok": True, "ms": ms, "tcalls": len(tc),
                "tool_names": [t.get("function",{}).get("name") for t in tc],
                "content": msg.get("content") or ""}
    except urllib.error.HTTPError as e:
        return {"ok": False, "ms": int((time.time()-t0)*1000), "err": f"HTTP {e.code}"}
    except Exception as e:
        return {"ok": False, "ms": int((time.time()-t0)*1000), "err": f"{type(e).__name__}: {str(e)[:80]}"}


def main():
    out = {"ts": datetime.now().isoformat(), "results": []}
    for prov, qid in SUSPECTS:
        print(f"\n=== {prov} / {qid} ({QUESTIONS[qid][:30]}...) ===", flush=True)
        for i in range(3):
            r = call(prov, qid, i)
            tag = "🛠" if r.get("tcalls",0) > 0 else "📝" if r.get("content","") else "❌"
            err = f" err={r.get('err')}" if not r.get("ok") else ""
            tn = ",".join(r.get("tool_names",[]) or []) if r.get("ok") else ""
            chead = (r.get("content") or "")[:80].replace("\n", " ")
            print(f"  retry#{i} {tag} ms={r.get('ms')} tcalls={r.get('tcalls','?')} tools=[{tn}] clen={len(r.get('content',''))}{err}", flush=True)
            if chead:
                print(f"     content: {chead!r}", flush=True)
            out["results"].append({"provider": prov, "qid": qid, "retry": i, **r})
            time.sleep(2.5)

    save = Path(__file__).parent / f"retry_suspects_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    save.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"\n💾 {save}")

    # tally
    print("\n========== TALLY (3 retries each) ==========")
    print(f"{'Provider':<26} {'QID':<14} {'tool_emit':<10} {'verbose':<10} {'empty/err':<10}")
    by_pair = {}
    for r in out["results"]:
        k = (r["provider"], r["qid"])
        by_pair.setdefault(k, []).append(r)
    for (prov, qid), rs in by_pair.items():
        emit = sum(1 for r in rs if r.get("ok") and r.get("tcalls",0) > 0)
        verbose = sum(1 for r in rs if r.get("ok") and r.get("tcalls",0) == 0 and r.get("content"))
        empty = sum(1 for r in rs if (not r.get("ok")) or (r.get("ok") and r.get("tcalls",0)==0 and not r.get("content")))
        print(f"{prov:<26} {qid:<14} {emit}/3        {verbose}/3        {empty}/3")

if __name__ == "__main__":
    main()
