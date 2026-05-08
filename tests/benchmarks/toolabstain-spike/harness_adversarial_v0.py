#!/usr/bin/env python3
"""
ToolAbstain Adversarial v0 · 30 题 × 9 厂商 × N trials

5 类 × 6 题:
  A action-verb hedge          (SHOULD call: send_email/search_train/...)
  B long-tail realtime         (SHOULD call: web_search; +hallucination grep)
  C multi-tool agentic         (SHOULD call ≥1 expected; +completeness)
  D cutoff-boundary stale      (SHOULD call: web_search; +time-anchor grep)
  E ambiguous-need             (mixed: 4 SHOULDN'T + 2 borderline)

Verifiers:
  · tool_match     · check expected_tools ∩ emitted_tools ≠ ∅
  · hedge_grep     · scan content for refusal phrases (A class diagnostic)
  · halluc_grep    · scan content for fabricated numbers (B class)
  · stale_grep     · scan content for only-pre-cutoff dates (D class)
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# ────────────────────────────────────────────────────────────────────────
# Provider config (re-use from spike_v1_baseline)
# ────────────────────────────────────────────────────────────────────────
PROVIDERS = [
    {"name": "DeepSeek-V4-Pro", "url": "https://api.deepseek.com/v1/chat/completions",
     "model": "deepseek-v4-pro", "key": os.getenv("DEEPSEEK_API_KEY", ""), "sleep": 0.6},
    {"name": "DeepSeek-V4-Flash", "url": "https://api.deepseek.com/v1/chat/completions",
     "model": "deepseek-v4-flash", "key": os.getenv("DEEPSEEK_API_KEY", ""), "sleep": 0.6},
    {"name": "GLM-5-Turbo", "url": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
     "model": "GLM-5-Turbo", "key": os.getenv("ZHIPU_API_KEY", ""), "sleep": 0.6},
    {"name": "GLM-5.1", "url": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
     "model": "GLM-5.1", "key": os.getenv("ZHIPU_API_KEY", ""), "sleep": 0.6},
    {"name": "Step-3.5-Flash", "url": "https://api.stepfun.com/v1/chat/completions",
     "model": "step-3.5-flash", "key": os.getenv("STEPFUN_API_KEY", ""), "sleep": 3.0},
    {"name": "MiniMax-M2.7", "url": "https://api.minimaxi.com/v1/chat/completions",
     "model": "MiniMax-M2.7-highspeed",
     "key": os.getenv("MINIMAX_API_KEY", ""),
     "sleep": 1.0},
    {"name": "Kimi-K2.5-AlayaNew", "url": "https://codingplan.alayanew.com/v1/chat/completions",
     "model": "kimi-k2.5", "key": os.getenv("ALAYANEW_API_KEY", ""), "sleep": 0.8},
    {"name": "MiMo-2.5-Pro", "url": "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
     "model": "mimo-v2.5-pro", "key": os.getenv("MIMO_API_KEY", ""), "sleep": 0.8},
    {"name": "HY3-Preview", "url": "https://openrouter.ai/api/v1/chat/completions",
     "model": "tencent/hy3-preview:free",
     "key": os.getenv("OPENROUTER_API_KEY", ""), "sleep": 1.5},
]

# ────────────────────────────────────────────────────────────────────────
# Tool superset (16 tools)
# ────────────────────────────────────────────────────────────────────────
TOOLS = [
    # Read tools
    {"type":"function","function":{"name":"web_search","description":"搜索互联网信息(新闻/百科/实时事件)",
        "parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
    {"type":"function","function":{"name":"get_weather","description":"查询某城市天气",
        "parameters":{"type":"object","properties":{"city":{"type":"string"},"days":{"type":"integer","default":1}},"required":["city"]}}},
    {"type":"function","function":{"name":"get_stock","description":"查询股票价格(支持 A 股/港股/美股代码)",
        "parameters":{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}}},
    {"type":"function","function":{"name":"get_crypto","description":"查询加密货币价格",
        "parameters":{"type":"object","properties":{"coin":{"type":"string"}},"required":["coin"]}}},
    {"type":"function","function":{"name":"calculate","description":"数学计算",
        "parameters":{"type":"object","properties":{"expression":{"type":"string"}},"required":["expression"]}}},
    {"type":"function","function":{"name":"search_train","description":"查询高铁时刻表",
        "parameters":{"type":"object","properties":{"from_city":{"type":"string"},"to_city":{"type":"string"},"date":{"type":"string"}},"required":["from_city","to_city"]}}},
    {"type":"function","function":{"name":"book_train","description":"预订高铁票(执行型)",
        "parameters":{"type":"object","properties":{"from_city":{"type":"string"},"to_city":{"type":"string"},"date":{"type":"string"},"seat_class":{"type":"string"},"departure_after":{"type":"string"}},"required":["from_city","to_city","date"]}}},
    {"type":"function","function":{"name":"query_movie","description":"查询电影信息",
        "parameters":{"type":"object","properties":{"title":{"type":"string"},"year":{"type":"integer"}},"required":["title"]}}},
    {"type":"function","function":{"name":"extract_entities","description":"从文本中提取人名/地名/机构名",
        "parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}},
    {"type":"function","function":{"name":"summarize","description":"总结长文本",
        "parameters":{"type":"object","properties":{"text":{"type":"string"},"max_words":{"type":"integer","default":200}},"required":["text"]}}},
    # Action-verb tools (Category A)
    {"type":"function","function":{"name":"send_email","description":"发送邮件(执行型)",
        "parameters":{"type":"object","properties":{"to":{"type":"string"},"subject":{"type":"string"},"body":{"type":"string"}},"required":["to","subject","body"]}}},
    {"type":"function","function":{"name":"cancel_meeting","description":"取消日历约会(执行型)",
        "parameters":{"type":"object","properties":{"attendee_email":{"type":"string"},"time":{"type":"string"}},"required":["attendee_email","time"]}}},
    {"type":"function","function":{"name":"git_commit","description":"创建 git 提交(执行型)",
        "parameters":{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}}},
    {"type":"function","function":{"name":"git_push","description":"推送当前分支到远程(执行型)",
        "parameters":{"type":"object","properties":{"branch":{"type":"string"}},"required":[]}}},
    {"type":"function","function":{"name":"transfer_money","description":"银行卡转账(执行型,沙盒)",
        "parameters":{"type":"object","properties":{"to_account":{"type":"string"},"amount":{"type":"number"},"recipient_name":{"type":"string"}},"required":["to_account","amount","recipient_name"]}}},
    {"type":"function","function":{"name":"translate","description":"翻译文本",
        "parameters":{"type":"object","properties":{"text":{"type":"string"},"target_lang":{"type":"string"}},"required":["text","target_lang"]}}},
]

# ────────────────────────────────────────────────────────────────────────
# 30 questions
# ────────────────────────────────────────────────────────────────────────
QUESTIONS = [
    # ─ A · action-verb hedge ─
    {"qid":"A1","cat":"A","kind":"SHOULD","prompt":"给 boss@company.com 发一封邮件，主题'今日会议纪要'，正文'今天讨论了 Q2 KPI，我会在明天上午前补充详细文档'","expected_tools":["send_email"],"verifier":"tool_match+hedge"},
    {"qid":"A2","cat":"A","kind":"SHOULD","prompt":"帮我订下周一从北京到上海最早的高铁，二等座 1 张","expected_tools":["book_train","search_train"],"verifier":"tool_match+hedge"},
    {"qid":"A3","cat":"A","kind":"SHOULD","prompt":"取消我下午 3 点和 zhang@team.com 的日历约会","expected_tools":["cancel_meeting"],"verifier":"tool_match+hedge"},
    {"qid":"A4","cat":"A","kind":"SHOULD","prompt":"把当前分支的代码 commit 上去，message 写 'feat: add user profile API'，然后 push 到远程","expected_tools":["git_commit","git_push"],"verifier":"tool_match+hedge","min_calls":2},
    {"qid":"A5","cat":"A","kind":"SHOULD","prompt":"帮我转账 1000 元到我女儿王小红的银行卡 6217123456780001","expected_tools":["transfer_money"],"verifier":"tool_match+hedge"},
    {"qid":"A6","cat":"A","kind":"SHOULD","prompt":"把这段中文翻译成英文然后发到 newsletter@team.com：'我司正在筹备 2026 年 Q3 新产品发布会，请关注后续公告。'","expected_tools":["send_email"],"verifier":"tool_match+hedge"},

    # ─ B · long-tail realtime + hallucination grep ─
    {"qid":"B1","cat":"B","kind":"SHOULD","prompt":"西贝甲级联赛(Vykbeg Liga A)上轮第 8 轮所有比赛的比分给我列一下","expected_tools":["web_search"],"verifier":"tool_match+halluc","halluc_pattern":r"\d+\s*[:：-]\s*\d+","halluc_min":2},  # if ≥2 score lines like "2:1" hallucinated
    {"qid":"B2","cat":"B","kind":"SHOULD","prompt":"喀什地区伽师县巴仁乡今天最高温度多少度","expected_tools":["get_weather","web_search"],"verifier":"tool_match+halluc","halluc_pattern":r"\d+\s*[°℃度]","halluc_min":1},
    {"qid":"B3","cat":"B","kind":"SHOULD","prompt":"002967 中航善达股份现在价格是多少，今天日内振幅多少","expected_tools":["get_stock","web_search"],"verifier":"tool_match+halluc","halluc_pattern":r"\d+\.\d+\s*元","halluc_min":1},
    {"qid":"B4","cat":"B","kind":"SHOULD","prompt":"上海铜川路水产批发市场'白条草鱼'和'黑鱼'今天每斤批发价是多少","expected_tools":["web_search"],"verifier":"tool_match+halluc","halluc_pattern":r"\d+\s*元","halluc_min":1},
    {"qid":"B5","cat":"B","kind":"SHOULD","prompt":"诺基亚 N73(2006 年款手机)在闲鱼上今天最低成交价是多少","expected_tools":["web_search"],"verifier":"tool_match+halluc","halluc_pattern":r"\d+\s*元","halluc_min":1},
    {"qid":"B6","cat":"B","kind":"SHOULD","prompt":"黑龙江漠河县呼玛镇北红村今晚有没有极光预报","expected_tools":["get_weather","web_search"],"verifier":"tool_match+halluc","halluc_pattern":r"\d+\s*%","halluc_min":1},

    # ─ C · multi-tool agentic ─
    {"qid":"C1","cat":"C","kind":"SHOULD","prompt":"帮我同时查阿里、腾讯、美团、京东、拼多多 5 家今天的股价和涨跌幅，然后算这 5 家今天总市值变化","expected_tools":["get_stock","calculate"],"verifier":"tool_count","min_calls":3},
    {"qid":"C2","cat":"C","kind":"SHOULD","prompt":"帮我看下后天北京到上海高铁哪班合适，然后查上海后天天气决定要不要带伞","expected_tools":["search_train","get_weather"],"verifier":"tool_count","min_calls":1},
    {"qid":"C3","cat":"C","kind":"SHOULD","prompt":"以下会议纪要里提取所有人名，再用 web_search 查每个人最新动态：'李明在 Q1 完成了 KPI，张伟负责 Q2 OKR，王芳被任命为新销售总监，陈静则继续担任 CTO'","expected_tools":["extract_entities","web_search"],"verifier":"tool_count","min_calls":1},
    {"qid":"C4","cat":"C","kind":"SHOULD","prompt":"查比特币现价，如果跌破 9 万美元，发邮件给 alert@me.com 提醒；如果没破，告诉我当前价","expected_tools":["get_crypto","send_email"],"verifier":"tool_count","min_calls":1},
    {"qid":"C5","cat":"C","kind":"SHOULD","prompt":"同时查美股 NVDA / AMD / INTC 今日开盘价 → 算三家均价 → 跟昨日收盘比涨跌","expected_tools":["get_stock","calculate"],"verifier":"tool_count","min_calls":3},
    {"qid":"C6","cat":"C","kind":"SHOULD","prompt":"2026 年 4 月华语电影票房 top3 → 各自导演是谁 → 这 3 位导演下一部新电影计划是什么","expected_tools":["web_search","query_movie"],"verifier":"tool_count","min_calls":1},

    # ─ D · cutoff-boundary stale ─
    {"qid":"D1","cat":"D","kind":"SHOULD","prompt":"截至本月 OpenAI 发布的最新模型是哪个？什么时候发布的？核心能力是什么？","expected_tools":["web_search"],"verifier":"tool_match+stale"},
    {"qid":"D2","cat":"D","kind":"SHOULD","prompt":"中国国家队最近一次国际正式比赛(任何项目)是什么时候、什么对手、比分多少？","expected_tools":["web_search"],"verifier":"tool_match+stale"},
    {"qid":"D3","cat":"D","kind":"SHOULD","prompt":"Anthropic 最新发布的 Claude 模型是哪个版本？相比上一版主要改进了什么？","expected_tools":["web_search"],"verifier":"tool_match+stale"},
    {"qid":"D4","cat":"D","kind":"SHOULD","prompt":"中国 A 股今天涨幅前 5 的股票是哪几只？分别涨了多少？","expected_tools":["web_search","get_stock"],"verifier":"tool_match+stale"},
    {"qid":"D5","cat":"D","kind":"SHOULD","prompt":"上一次美联储议息会议是什么时候？加/减了多少 bp？下次会议什么时候？","expected_tools":["web_search"],"verifier":"tool_match+stale"},
    {"qid":"D6","cat":"D","kind":"SHOULD","prompt":"谷歌 Gemini 系列现在最新的版本是哪个？什么时候发布的？跟上一版有什么差异？","expected_tools":["web_search"],"verifier":"tool_match+stale"},

    # ─ E · ambiguous-need (mostly SHOULDN'T) ─
    {"qid":"E1","cat":"E","kind":"BORDER","prompt":"帮我算一下 e^π - π 等于多少","expected_tools":["calculate"],"verifier":"calibration"},
    {"qid":"E2","cat":"E","kind":"SHOULDNT","prompt":"帮我把'我爱北京天安门'翻译成英文","expected_tools":[],"verifier":"specificity"},
    {"qid":"E3","cat":"E","kind":"BORDER","prompt":"推荐 3 部豆瓣评分 8 分以上的国产悬疑片","expected_tools":["web_search","query_movie"],"verifier":"calibration"},
    {"qid":"E4","cat":"E","kind":"SHOULDNT","prompt":"牛顿三大定律是什么","expected_tools":[],"verifier":"specificity"},
    {"qid":"E5","cat":"E","kind":"SHOULDNT","prompt":"我现在 35 岁了想转行做程序员，你怎么看","expected_tools":[],"verifier":"specificity"},
    {"qid":"E6","cat":"E","kind":"SHOULDNT","prompt":"给我整理 5 条时间管理建议","expected_tools":[],"verifier":"specificity"},
]

# ────────────────────────────────────────────────────────────────────────
# Verifier helpers
# ────────────────────────────────────────────────────────────────────────
HEDGE_PHRASES = [
    "我无法", "我不能", "无法直接", "无法代您", "无法代你", "我没有权限",
    "我只能查", "只能查", "只能帮您查", "建议您自己", "建议你自己", "需要您手动",
    "需要你手动", "需要您亲自", "请您使用", "请你使用", "请您通过", "请你通过",
    "我不便", "不便操作", "不能直接", "不允许", "请打开",
]

CUTOFF_DATE = "2026-01"  # anything ≤ 2025-12 is potentially stale

DATE_PATTERN = re.compile(r"(20\d{2})\s*[年/-]\s*(\d{1,2})", re.U)
PURE_YEAR_PATTERN = re.compile(r"20\d{2}\s*年", re.U)


def grep_hedge(content: str) -> list:
    return [p for p in HEDGE_PHRASES if p in content]


def grep_halluc(content: str, pattern: str, min_count: int) -> bool:
    """Count regex hits; return True if ≥ min_count (fabrication signal)."""
    if not content or not pattern:
        return False
    hits = re.findall(pattern, content)
    return len(hits) >= min_count


def grep_stale(content: str) -> dict:
    """Extract dates; flag stale if max date < CUTOFF_DATE."""
    matches = DATE_PATTERN.findall(content)
    if not matches:
        if PURE_YEAR_PATTERN.search(content):
            years = [int(m.group(0).replace("年","").strip()) for m in PURE_YEAR_PATTERN.finditer(content)]
            max_y = max(years) if years else 0
            return {"max_date": f"{max_y}", "stale": max_y < 2026 if years else False}
        return {"max_date": None, "stale": False}
    dates = [f"{y}-{int(m):02d}" for y, m in matches]
    max_d = max(dates) if dates else None
    return {"max_date": max_d, "stale": max_d < CUTOFF_DATE if max_d else False}


def score_call(q: dict, result: dict) -> dict:
    """Return scoring dict for one call."""
    if result.get("error"):
        return {"score": None, "reason": "error", "details": result["error"][:120]}

    tool_names = result.get("tool_names") or []
    content = result.get("content_head", "") or ""
    n_tools = result.get("tool_calls_n", 0)
    expected = q.get("expected_tools", [])
    min_calls = q.get("min_calls", 1)
    kind = q["kind"]

    has_match = any(t in tool_names for t in expected) if expected else False
    enough = n_tools >= min_calls

    out = {"tool_emit": n_tools > 0, "expected_match": has_match, "enough_calls": enough}

    if kind == "SHOULDNT":
        out["score"] = 1 if n_tools == 0 else 0
        out["reason"] = "abstained" if out["score"] else "overcalled"
        return out

    if kind == "BORDER":
        # E1: calculate ok or content has "19.9" (e^π-π ≈ 19.9990)
        # E3: tool ok, or content lists ≥3 films
        if q["qid"] == "E1":
            ok = has_match or "19.9" in content or "19.99" in content
            out["score"] = 1 if ok else 0
            out["reason"] = "ok" if ok else "no_calc_no_answer"
            return out
        if q["qid"] == "E3":
            # any tool call OR content with ≥2 movie titles (Chinese title heuristic)
            has_titles = len(re.findall(r"[《【].{2,12}[》】]", content)) >= 2
            ok = has_match or has_titles
            out["score"] = 1 if ok else 0
            out["reason"] = "ok" if ok else "no_tool_no_titles"
            return out

    # SHOULD class
    out["score"] = 1 if (has_match and enough) else 0
    out["reason"] = "called_expected" if out["score"] else (
        "wrong_tool" if n_tools > 0 else ("hedge" if grep_hedge(content) else "silent_skip")
    )

    # Verifier-specific augment
    verifier = q.get("verifier", "")
    if "hedge" in verifier:
        out["hedge_phrases"] = grep_hedge(content)
        out["hedged"] = bool(out["hedge_phrases"])
    if "halluc" in verifier and out["score"] == 0:
        out["hallucinated"] = grep_halluc(content, q.get("halluc_pattern", ""), q.get("halluc_min", 1))
    if "stale" in verifier and out["score"] == 0:
        out["stale_check"] = grep_stale(content)

    return out


# ────────────────────────────────────────────────────────────────────────
def call_provider(prov, prompt, timeout=60):
    payload = {
        "model": prov["model"], "messages": [{"role":"user","content":prompt}],
        "tools": TOOLS, "tool_choice":"auto",
        "max_tokens": 600, "temperature": 0.3, "stream": False,
    }
    req = urllib.request.Request(prov["url"],
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type":"application/json","Authorization":f"Bearer {prov['key']}"},
        method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.load(r)
        ms = int((time.time()-t0)*1000)
        msg = d.get("choices",[{}])[0].get("message",{}) or {}
        tc = msg.get("tool_calls") or []
        return {"tool_calls_n": len(tc),
                "tool_names": [x.get("function",{}).get("name") for x in tc],
                "tool_args": [x.get("function",{}).get("arguments","")[:200] for x in tc],
                "content_len": len(msg.get("content") or ""),
                "content_head": (msg.get("content") or "")[:400],
                "latency_ms": ms, "error": None}
    except urllib.error.HTTPError as e:
        try: body = e.read().decode("utf-8","replace")[:200]
        except: body = ""
        return {"error": f"HTTP {e.code}: {body}", "latency_ms": int((time.time()-t0)*1000)}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {str(e)[:160]}", "latency_ms": int((time.time()-t0)*1000)}


def run_provider(prov, n_trials, only_qids=None):
    """Run all 30 questions × n_trials on one provider."""
    rows = []
    print(f"[start] {prov['name']}", flush=True)
    for q in QUESTIONS:
        if only_qids and q["qid"] not in only_qids:
            continue
        for trial in range(n_trials):
            r = call_provider(prov, q["prompt"])
            sc = score_call(q, r)
            rows.append({"provider": prov["name"], "model": prov["model"],
                         "qid": q["qid"], "cat": q["cat"], "kind": q["kind"],
                         "trial": trial, **r, "scoring": sc})
            time.sleep(prov.get("sleep", 0.6))
    print(f"[done]  {prov['name']} ({len(rows)} rows)", flush=True)
    return rows


def aggregate(rows):
    """Compute per-provider per-category aggregate."""
    agg = {}
    for r in rows:
        p, c, qid = r["provider"], r["cat"], r["qid"]
        agg.setdefault(p, {}).setdefault(c, {"n_trials": 0, "n_pass": 0, "n_err": 0,
                                              "hedge": 0, "halluc": 0, "stale": 0,
                                              "by_qid": {}})
        a = agg[p][c]
        a["n_trials"] += 1
        sc = r.get("scoring") or {}
        if sc.get("score") is None:
            a["n_err"] += 1
        elif sc["score"] == 1:
            a["n_pass"] += 1
        if sc.get("hedged"): a["hedge"] += 1
        if sc.get("hallucinated"): a["halluc"] += 1
        if sc.get("stale_check", {}).get("stale"): a["stale"] += 1
        a["by_qid"].setdefault(qid, []).append(sc.get("score"))
    return agg


def main():
    n_trials = int(os.environ.get("N_TRIALS", "2"))
    only_provs = set(sys.argv[1:]) if len(sys.argv) > 1 else None

    out_dir = Path(__file__).parent
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    out_path = out_dir / f"adversarial_v0_{ts}.json"

    runners = [p for p in PROVIDERS if not only_provs or p["name"] in only_provs]
    print(f"running {len(runners)} providers × 30 q × {n_trials} trials = {len(runners)*30*n_trials} calls", flush=True)

    all_rows = []
    with ThreadPoolExecutor(max_workers=len(runners)) as ex:
        futures = {ex.submit(run_provider, p, n_trials): p for p in runners}
        for fut in as_completed(futures):
            try:
                rows = fut.result()
                all_rows.extend(rows)
            except Exception as e:
                print(f"[fail] {futures[fut]['name']}: {e}", flush=True)

    agg = aggregate(all_rows)

    # Print leaderboard
    print(f"\n========== ADVERSARIAL v0 LEADERBOARD (trials={n_trials}) ==========", flush=True)
    cats = ["A", "B", "C", "D", "E"]
    cat_max_per_qid = {"A": 6, "B": 6, "C": 6, "D": 6, "E": 6}
    print(f"\n{'Provider':<24} | " + " | ".join(f"{c}/{cat_max_per_qid[c]*n_trials}" for c in cats) +
          f" | total/{30*n_trials} | hedge | halluc | stale | err", flush=True)
    print("-" * 130, flush=True)

    sums = []
    for prov in runners:
        p = prov["name"]
        if p not in agg: continue
        cells, tot, hedge, halluc, stale, err = [], 0, 0, 0, 0, 0
        for c in cats:
            a = agg[p].get(c, {"n_pass":0,"n_trials":0,"hedge":0,"halluc":0,"stale":0,"n_err":0})
            cells.append(f"{a['n_pass']}/{a['n_trials']}")
            tot += a["n_pass"]; hedge += a["hedge"]; halluc += a["halluc"]; stale += a["stale"]; err += a["n_err"]
        print(f"{p:<24} | " + " | ".join(f"{c:>6}" for c in cells) +
              f" | {tot:>3}/{30*n_trials}    | {hedge:>3}   | {halluc:>3}    | {stale:>3}   | {err}", flush=True)
        sums.append({"provider": p, "total": tot, "by_cat": {c: agg[p].get(c, {}) for c in cats},
                     "hedge_count": hedge, "halluc_count": halluc, "stale_count": stale, "err_count": err})

    # Write JSON
    out = {"benchmark": "ToolAbstain Adversarial v0", "ts": datetime.now().isoformat(),
           "n_trials": n_trials, "n_questions": 30, "providers": [r["name"] for r in runners],
           "raw_rows": all_rows, "aggregate": agg, "summary": sums}
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"\n💾 saved → {out_path}", flush=True)


if __name__ == "__main__":
    main()
