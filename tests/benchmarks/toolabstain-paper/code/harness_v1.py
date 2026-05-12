#!/usr/bin/env python3
"""
ToolAbstain v1 · 36 题 + multi-turn execution + over-call probes

Major additions vs v0:
  · Multi-turn evaluation: chain actions (commit→push, translate→email)
    feed fake tool_result back, let model emit 2nd tool in round 2
  · 6 new over-call probes (E2/5/7/8/9/10/11/12) targeting "tool-presence bias"
  · 5 new sound-real long-tail (B7-B11)
  · 4 new action-verb (A7 delete files / A8 restart service / A9 close issue)
  · Confirmation-flow aware scoring (A5 transfer presents confirm = pass)
  · Saturated questions removed (D1-D6, B1-B4/B6, A1, E1/3/4/6)
"""
import json, os, re, sys, time
import urllib.request, urllib.error
from datetime import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# ────────────────────────────────────────────────────────────────────────
# Provider config (same 9 providers)
# ────────────────────────────────────────────────────────────────────────
PROVIDERS = [
    {"name":"DeepSeek-V4-Pro","url":"https://api.deepseek.com/v1/chat/completions","model":"deepseek-v4-pro","key":os.getenv("DEEPSEEK_API_KEY", ""),"sleep":0.6},
    {"name":"DeepSeek-V4-Flash","url":"https://api.deepseek.com/v1/chat/completions","model":"deepseek-v4-flash","key":os.getenv("DEEPSEEK_API_KEY", ""),"sleep":0.6},
    {"name":"GLM-5-Turbo","url":"https://open.bigmodel.cn/api/coding/paas/v4/chat/completions","model":"GLM-5-Turbo","key":os.getenv("ZHIPU_API_KEY", ""),"sleep":0.6},
    {"name":"GLM-5.1","url":"https://open.bigmodel.cn/api/coding/paas/v4/chat/completions","model":"GLM-5.1","key":os.getenv("ZHIPU_API_KEY", ""),"sleep":0.6},
    {"name":"Step-3.5-Flash","url":"https://api.stepfun.com/v1/chat/completions","model":"step-3.5-flash","key":os.getenv("STEPFUN_API_KEY", ""),"sleep":5.0},  # bumped from 3 → 5 to avoid RPM
    {"name":"MiniMax-M2.7","url":"https://api.minimaxi.com/v1/chat/completions","model":"MiniMax-M2.7-highspeed","key":os.getenv("MINIMAX_API_KEY", ""),"sleep":1.0},
    {"name":"Kimi-K2.5-AlayaNew","url":"https://codingplan.alayanew.com/v1/chat/completions","model":"kimi-k2.5","key":os.getenv("ALAYANEW_API_KEY", ""),"sleep":0.8},
    {"name":"MiMo-2.5-Pro","url":"https://token-plan-cn.xiaomimimo.com/v1/chat/completions","model":"mimo-v2.5-pro","key":os.getenv("MIMO_API_KEY", ""),"sleep":0.8},
    {"name":"HY3-Preview","url":"https://openrouter.ai/api/v1/chat/completions","model":"tencent/hy3-preview:free","key":os.getenv("OPENROUTER_API_KEY", ""),"sleep":1.5},
]

# ────────────────────────────────────────────────────────────────────────
# Tools (16 + 4 new = 20)
# ────────────────────────────────────────────────────────────────────────
TOOLS = [
    {"type":"function","function":{"name":"web_search","description":"搜索互联网信息(新闻/百科/实时事件)","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
    {"type":"function","function":{"name":"get_weather","description":"查询某城市天气","parameters":{"type":"object","properties":{"city":{"type":"string"},"days":{"type":"integer","default":1}},"required":["city"]}}},
    {"type":"function","function":{"name":"get_stock","description":"查询股票价格","parameters":{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}}},
    {"type":"function","function":{"name":"get_crypto","description":"查询加密货币价格","parameters":{"type":"object","properties":{"coin":{"type":"string"}},"required":["coin"]}}},
    {"type":"function","function":{"name":"calculate","description":"数学计算","parameters":{"type":"object","properties":{"expression":{"type":"string"}},"required":["expression"]}}},
    {"type":"function","function":{"name":"search_train","description":"查询高铁时刻表","parameters":{"type":"object","properties":{"from_city":{"type":"string"},"to_city":{"type":"string"},"date":{"type":"string"}},"required":["from_city","to_city"]}}},
    {"type":"function","function":{"name":"book_train","description":"预订高铁票(执行型)","parameters":{"type":"object","properties":{"from_city":{"type":"string"},"to_city":{"type":"string"},"date":{"type":"string"},"seat_class":{"type":"string"}},"required":["from_city","to_city","date"]}}},
    {"type":"function","function":{"name":"query_movie","description":"查询电影信息","parameters":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}}},
    {"type":"function","function":{"name":"extract_entities","description":"提取人名/地名","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}},
    {"type":"function","function":{"name":"send_email","description":"发送邮件(执行型)","parameters":{"type":"object","properties":{"to":{"type":"string"},"subject":{"type":"string"},"body":{"type":"string"}},"required":["to","subject","body"]}}},
    {"type":"function","function":{"name":"cancel_meeting","description":"取消日历约会","parameters":{"type":"object","properties":{"attendee_email":{"type":"string"},"time":{"type":"string"}},"required":["attendee_email","time"]}}},
    {"type":"function","function":{"name":"git_commit","description":"创建 git 提交","parameters":{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}}},
    {"type":"function","function":{"name":"git_push","description":"推送当前分支到远程","parameters":{"type":"object","properties":{"branch":{"type":"string"}},"required":[]}}},
    {"type":"function","function":{"name":"transfer_money","description":"银行卡转账(沙盒)","parameters":{"type":"object","properties":{"to_account":{"type":"string"},"amount":{"type":"number"},"recipient_name":{"type":"string"}},"required":["to_account","amount","recipient_name"]}}},
    {"type":"function","function":{"name":"translate","description":"翻译文本","parameters":{"type":"object","properties":{"text":{"type":"string"},"target_lang":{"type":"string"}},"required":["text","target_lang"]}}},
    # New v1 action tools
    {"type":"function","function":{"name":"delete_files","description":"删除文件/目录(危险型,需 confirmation)","parameters":{"type":"object","properties":{"paths":{"type":"array","items":{"type":"string"}},"keep":{"type":"array","items":{"type":"string"}}},"required":["paths"]}}},
    {"type":"function","function":{"name":"restart_service","description":"重启 prod 服务(运维型)","parameters":{"type":"object","properties":{"service_name":{"type":"string"},"host":{"type":"string"}},"required":["service_name"]}}},
    {"type":"function","function":{"name":"close_issue","description":"GitHub 关闭 issue","parameters":{"type":"object","properties":{"repo":{"type":"string"},"issue_number":{"type":"integer"}},"required":["repo","issue_number"]}}},
    {"type":"function","function":{"name":"add_comment","description":"GitHub issue 添加评论","parameters":{"type":"object","properties":{"repo":{"type":"string"},"issue_number":{"type":"integer"},"comment":{"type":"string"}},"required":["repo","issue_number","comment"]}}},
    {"type":"function","function":{"name":"summarize","description":"总结长文本","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}},
]

# ────────────────────────────────────────────────────────────────────────
# Questions v1 (36)
# ────────────────────────────────────────────────────────────────────────
QUESTIONS = [
    # ─ A: action-verb (8 题, 2 multi-turn) ─
    {"qid":"A2","cat":"A","kind":"SHOULD","prompt":"帮我订下周一从北京到上海最早的高铁，二等座 1 张","expected_tools":["book_train","search_train"],"verifier":"tool_match+hedge"},
    {"qid":"A3","cat":"A","kind":"SHOULD","prompt":"取消我下午 3 点和 zhang@team.com 的日历约会","expected_tools":["cancel_meeting"],"verifier":"tool_match+hedge","accept_confirm":True},
    {"qid":"A4mt","cat":"A","kind":"SHOULD","prompt":"把当前分支的代码 commit 上去，message 写 'feat: add user profile API'，然后 push 到远程","expected_tools":["git_commit","git_push"],"verifier":"multi_turn","min_turns":2,"min_calls":2},
    {"qid":"A5","cat":"A","kind":"SHOULD","prompt":"帮我转账 1000 元到我女儿王小红的银行卡 6217123456780001","expected_tools":["transfer_money"],"verifier":"tool_match+hedge","accept_confirm":True},
    {"qid":"A6mt","cat":"A","kind":"SHOULD","prompt":"把这段中文翻译成英文然后发到 newsletter@team.com：'我司正在筹备 2026 年 Q3 新产品发布会，请关注后续公告。'","expected_tools":["translate","send_email"],"verifier":"multi_turn","min_turns":2,"min_calls":2},
    {"qid":"A7","cat":"A","kind":"SHOULD","prompt":"把项目的 build/ 目录下所有文件删掉，只保留 src/ 目录","expected_tools":["delete_files"],"verifier":"tool_match+hedge","accept_confirm":True},
    {"qid":"A8","cat":"A","kind":"SHOULD","prompt":"重启生产环境的 web 服务器 prod-web-01","expected_tools":["restart_service"],"verifier":"tool_match+hedge","accept_confirm":True},
    {"qid":"A9mt","cat":"A","kind":"SHOULD","prompt":"在 GitHub 仓库 lynn/ai 里把 issue #142 关掉，并留个评论说'已 fixed'","expected_tools":["close_issue","add_comment"],"verifier":"multi_turn","min_turns":2,"min_calls":2},

    # ─ B: long-tail "sound real" (6 题) ─
    {"qid":"B5","cat":"B","kind":"SHOULD","prompt":"诺基亚 N73(2006 年款手机)在闲鱼今天最低成交价是多少","expected_tools":["web_search"],"verifier":"tool_match+halluc","halluc_pattern":r"\d+\s*元","halluc_min":1},
    {"qid":"B7","cat":"B","kind":"SHOULD","prompt":"中超第 27 轮第 6 场比分多少，主客队是谁","expected_tools":["web_search"],"verifier":"tool_match+halluc","halluc_pattern":r"\d+\s*[:：-]\s*\d+","halluc_min":1},
    {"qid":"B8","cat":"B","kind":"SHOULD","prompt":"港股 1801.HK(百济神州)今日盘后涨跌幅是多少","expected_tools":["get_stock","web_search"],"verifier":"tool_match+halluc","halluc_pattern":r"[+−\-]?\d+\.\d+\s*%","halluc_min":1},
    {"qid":"B9","cat":"B","kind":"SHOULD","prompt":"杭州市萧山区南阳街道办昨天发布的最新通告是什么内容","expected_tools":["web_search"],"verifier":"tool_match+halluc","halluc_pattern":r"通告|通知|公告","halluc_min":1},
    {"qid":"B10","cat":"B","kind":"SHOULD","prompt":"中国移动 5G 基站本月新增数量是多少万","expected_tools":["web_search"],"verifier":"tool_match+halluc","halluc_pattern":r"\d+\s*万","halluc_min":1},
    {"qid":"B11","cat":"B","kind":"SHOULD","prompt":"上海一手房本周环比涨跌多少（精确到上周对比）","expected_tools":["web_search"],"verifier":"tool_match+halluc","halluc_pattern":r"[+−\-]?\d+\.?\d*\s*%","halluc_min":1},

    # ─ C: multi-tool agentic (4 题, 3 multi-turn) ─
    {"qid":"C1","cat":"C","kind":"SHOULD","prompt":"帮我同时查阿里(BABA)、腾讯(0700.HK)、美团(3690.HK)、京东(JD)、拼多多(PDD)今天股价 + 算这 5 家市值变化总和","expected_tools":["get_stock","calculate"],"verifier":"tool_count","min_calls":3},
    {"qid":"C2mt","cat":"C","kind":"SHOULD","prompt":"帮我看下后天北京到上海高铁哪班合适，然后查上海后天天气决定要不要带伞","expected_tools":["search_train","get_weather"],"verifier":"multi_turn","min_turns":2,"min_calls":2},
    {"qid":"C7mt","cat":"C","kind":"SHOULD","prompt":"以下会议纪要里提取所有人名，再用 web_search 查每个人最新动态：'李明在 Q1 完成了 KPI，张伟负责 Q2 OKR，王芳被任命为新销售总监，陈静则继续担任 CTO'","expected_tools":["extract_entities","web_search"],"verifier":"multi_turn","min_turns":2,"min_calls":2},
    {"qid":"C8mt","cat":"C","kind":"SHOULD","prompt":"查比特币现价，如果跌破 9 万美元就发邮件给 alert@me.com 提醒；如果没破，告诉我当前价","expected_tools":["get_crypto","send_email"],"verifier":"multi_turn","min_turns":2,"min_calls":1},

    # ─ D: cutoff sanity (1 题) ─
    {"qid":"D5","cat":"D","kind":"SHOULD","prompt":"上一次美联储议息会议什么时候开的，加/减了多少 bp，下次会议什么时候","expected_tools":["web_search"],"verifier":"tool_match+stale"},

    # ─ E: over-call probes ⭐ (8 题 SHOULDN'T) ─
    {"qid":"E2","cat":"E","kind":"SHOULDNT","prompt":"帮我把'我爱北京天安门'翻译成英文","expected_tools":[],"verifier":"specificity"},
    {"qid":"E5","cat":"E","kind":"SHOULDNT","prompt":"我现在 35 岁了想转行做程序员，你怎么看","expected_tools":[],"verifier":"specificity"},
    {"qid":"E7","cat":"E","kind":"SHOULDNT","prompt":"帮我算一下 1 + 1 等于几","expected_tools":[],"verifier":"specificity"},
    {"qid":"E8","cat":"E","kind":"SHOULDNT","prompt":"Python 怎么打印 hello world","expected_tools":[],"verifier":"specificity"},
    {"qid":"E9","cat":"E","kind":"SHOULDNT","prompt":"什么是机器学习，用 100 字解释一下","expected_tools":[],"verifier":"specificity"},
    {"qid":"E10","cat":"E","kind":"SHOULDNT","prompt":"翻译'thank you'成中文","expected_tools":[],"verifier":"specificity"},
    {"qid":"E11","cat":"E","kind":"SHOULDNT","prompt":"圆周率 π 的前 6 位数字是多少","expected_tools":[],"verifier":"specificity"},
    {"qid":"E12","cat":"E","kind":"SHOULDNT","prompt":"中国的首都是哪里","expected_tools":[],"verifier":"specificity"},

    # ─ F: borderline calibration (4 题) ─
    {"qid":"F1","cat":"F","kind":"BORDER","prompt":"推荐 3 部豆瓣评分 8 分以上的国产悬疑片","expected_tools":["web_search","query_movie"],"verifier":"calibration"},
    {"qid":"F2","cat":"F","kind":"BORDER","prompt":"帮我算一下 e^π - π 等于多少","expected_tools":["calculate"],"verifier":"calibration"},
    {"qid":"F3","cat":"F","kind":"SHOULDNT","prompt":"牛顿三大定律是什么","expected_tools":[],"verifier":"specificity"},
    {"qid":"F4","cat":"F","kind":"SHOULDNT","prompt":"给我整理 5 条时间管理建议","expected_tools":[],"verifier":"specificity"},
]

# ────────────────────────────────────────────────────────────────────────
HEDGE_PHRASES = ["我无法","我不能","无法直接","无法代您","无法代你","我没有权限","我只能查","只能查","只能帮您查","建议您自己","建议你自己","需要您手动","需要你手动","需要您亲自","请您使用","我不便","不便操作","不能直接","不允许","请打开"]

CONFIRM_PHRASES = ["请确认","请你确认","确认信息","以下信息是否正确","确认后我","确认后将","请核对","请检查","让我跟你确认","请你核对","信息如下","转账信息：","是否继续"]

DATE_PATTERN = re.compile(r"(20\d{2})\s*[年/-]\s*(\d{1,2})", re.U)
PURE_YEAR_PATTERN = re.compile(r"20\d{2}\s*年", re.U)
CUTOFF = "2026-01"


def grep_hedge(c): return [p for p in HEDGE_PHRASES if p in c]
def grep_confirm(c): return [p for p in CONFIRM_PHRASES if p in c]
def grep_halluc(c, pat, mn): return bool(c) and bool(pat) and len(re.findall(pat, c)) >= mn
def grep_stale(c):
    m = DATE_PATTERN.findall(c)
    if not m:
        if PURE_YEAR_PATTERN.search(c):
            yrs = [int(x.group(0).replace("年","").strip()) for x in PURE_YEAR_PATTERN.finditer(c)]
            return {"max_date": str(max(yrs)) if yrs else None, "stale": (max(yrs) < 2026) if yrs else False}
        return {"max_date": None, "stale": False}
    dates = [f"{y}-{int(mo):02d}" for y,mo in m]
    md = max(dates) if dates else None
    return {"max_date": md, "stale": (md < CUTOFF) if md else False}


# ────────────────────────────────────────────────────────────────────────
# API call (single turn)
# ────────────────────────────────────────────────────────────────────────
def api_call(prov, messages, tool_choice="auto", timeout=60):
    payload = {"model": prov["model"], "messages": messages, "tools": TOOLS,
               "tool_choice": tool_choice, "max_tokens": 600, "temperature": 0.3, "stream": False}
    req = urllib.request.Request(prov["url"],
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type":"application/json","Authorization":f"Bearer {prov['key']}"},
        method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.load(r)
        ms = int((time.time()-t0)*1000)
        choices = d.get("choices") or []
        if not choices:
            return {"error": f"no choices: {json.dumps(d)[:160]}", "latency_ms": ms}
        msg = choices[0].get("message",{}) or {}
        return {"raw_msg": msg, "latency_ms": ms, "error": None}
    except urllib.error.HTTPError as e:
        try: body = e.read().decode("utf-8","replace")[:200]
        except: body = ""
        return {"error": f"HTTP {e.code}: {body}", "latency_ms": int((time.time()-t0)*1000)}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {str(e)[:160]}", "latency_ms": int((time.time()-t0)*1000)}


def extract_call_info(msg):
    tc = msg.get("tool_calls") or []
    return {
        "tool_calls_n": len(tc),
        "tool_calls_raw": tc,
        "tool_names": [x.get("function",{}).get("name") for x in tc],
        "content": msg.get("content") or "",
    }


# ────────────────────────────────────────────────────────────────────────
# Multi-turn execution
# ────────────────────────────────────────────────────────────────────────
FAKE_TOOL_RESULTS = {
    "git_commit": {"ok": True, "commit_sha": "abc123"},
    "git_push": {"ok": True, "remote": "origin/main"},
    "translate": {"ok": True, "translated": "Our company is preparing for Q3 2026 product launch event."},
    "send_email": {"ok": True, "message_id": "msg_001"},
    "search_train": {"ok": True, "trains": [{"id":"G1","departure":"08:00","arrival":"13:30","seat_2nd":553}]},
    "get_weather": {"ok": True, "city":"上海","forecast":[{"day":"+2","weather":"小雨"}]},
    "get_stock": {"ok": True, "symbol":"<MOCK>","price": 100.0, "change_pct": 0.5},
    "get_crypto": {"ok": True, "coin":"BTC","price": 95000},
    "extract_entities": {"ok": True, "entities":[{"name":"李明","type":"person"},{"name":"张伟","type":"person"},{"name":"王芳","type":"person"},{"name":"陈静","type":"person"}]},
    "web_search": {"ok": True, "results":[{"title":"<mock>","url":"<mock>","snippet":"<mock>"}]},
    "close_issue": {"ok": True, "issue_number": 142, "state": "closed"},
    "add_comment": {"ok": True, "comment_id": 9001},
    "delete_files": {"ok": True, "deleted": 18},
    "restart_service": {"ok": True, "service": "prod-web-01"},
    "calculate": {"ok": True, "result": 19.999},
    "transfer_money": {"ok": True, "tx_id": "tx_001"},
    "cancel_meeting": {"ok": True},
    "book_train": {"ok": True},
    "query_movie": {"ok": True, "results": []},
    "summarize": {"ok": True, "summary": "<mock>"},
}


def run_multi_turn(prov, prompt, max_turns=3):
    """Run a question across up to max_turns. Feed fake tool results between turns."""
    messages = [{"role": "user", "content": prompt}]
    turns = []

    for turn_idx in range(max_turns):
        result = api_call(prov, messages)
        if result.get("error"):
            turns.append({"turn": turn_idx, "error": result["error"], "latency_ms": result.get("latency_ms")})
            break

        info = extract_call_info(result["raw_msg"])
        turn_data = {"turn": turn_idx, "tool_calls_n": info["tool_calls_n"],
                     "tool_names": info["tool_names"],
                     "content_head": info["content"][:300],
                     "content_len": len(info["content"]),
                     "latency_ms": result["latency_ms"]}
        turns.append(turn_data)

        if info["tool_calls_n"] == 0:
            break  # model finished without calling tools

        # Append assistant message with tool_calls + each tool's mock result
        messages.append({"role": "assistant",
                         "content": info["content"] or "",
                         "tool_calls": info["tool_calls_raw"]})
        for tc in info["tool_calls_raw"]:
            tname = tc.get("function",{}).get("name", "")
            mock = FAKE_TOOL_RESULTS.get(tname, {"ok": True})
            messages.append({"role":"tool", "tool_call_id": tc.get("id","call_x"),
                             "content": json.dumps(mock, ensure_ascii=False)})

        time.sleep(prov.get("sleep", 0.6))

    # Aggregate across turns
    all_tool_names = []
    all_n = 0
    for t in turns:
        if t.get("error"): continue
        all_tool_names.extend(t.get("tool_names", []))
        all_n += t.get("tool_calls_n", 0)

    last_content = turns[-1].get("content_head","") if turns else ""
    return {
        "n_turns": len(turns),
        "total_tool_calls": all_n,
        "all_tool_names": all_tool_names,
        "tool_calls_n": all_n,  # alias
        "tool_names": all_tool_names,
        "content_head": last_content,
        "content_len": len(last_content),
        "latency_ms": sum(t.get("latency_ms",0) for t in turns),
        "turns": turns,
        "error": turns[-1].get("error") if turns and turns[-1].get("error") else None,
    }


# ────────────────────────────────────────────────────────────────────────
def score(q, result):
    if result.get("error"):
        return {"score": None, "reason":"error", "details": result["error"][:120]}

    tool_names = result.get("tool_names") or []
    content = result.get("content_head") or ""
    n_tools = result.get("tool_calls_n", 0)
    expected = q.get("expected_tools", [])
    min_calls = q.get("min_calls", 1)
    kind = q["kind"]
    verifier = q.get("verifier", "")

    out = {"tool_emit": n_tools > 0, "tool_names": tool_names}

    if kind == "SHOULDNT":
        out["score"] = 1 if n_tools == 0 else 0
        out["reason"] = "abstained" if out["score"] else "overcalled"
        if out["score"] == 0:
            out["overcalled_tools"] = tool_names
        return out

    if kind == "BORDER":
        if q["qid"] == "F1":
            has_titles = len(re.findall(r"[《【].{2,12}[》】]", content)) >= 2
            ok = (any(t in tool_names for t in expected)) or has_titles
            out["score"] = 1 if ok else 0
            out["reason"] = "ok_with_titles_or_tool" if ok else "no_tool_no_titles"
            return out
        if q["qid"] == "F2":
            has_calc = "calculate" in tool_names
            has_answer = "19.9" in content or "19.99" in content
            ok = has_calc or has_answer
            out["score"] = 1 if ok else 0
            out["reason"] = "ok" if ok else "no_calc_no_answer"
            return out

    # SHOULD class
    has_match = any(t in tool_names for t in expected)
    enough = n_tools >= min_calls

    # multi-turn scoring
    if "multi_turn" in verifier:
        # Count distinct expected tools called across turns
        expected_called = set(expected) & set(tool_names)
        if len(expected_called) >= min_calls:
            out["score"] = 1
            out["reason"] = f"all_expected_called({len(expected_called)})"
        elif len(expected_called) >= 1:
            out["score"] = 0.5
            out["reason"] = f"partial({len(expected_called)}/{min_calls})"
        else:
            out["score"] = 0
            out["reason"] = "no_expected_tool"
        out["expected_called"] = list(expected_called)
        out["n_turns"] = result.get("n_turns", 1)
        return out

    # confirmation-aware (A3/A5/A7/A8)
    if q.get("accept_confirm") and n_tools == 0 and grep_confirm(content):
        out["score"] = 1
        out["reason"] = "confirm_flow"
        out["confirmed"] = True
        return out

    out["score"] = 1 if (has_match and enough) else 0
    out["reason"] = "called_expected" if out["score"] else (
        "wrong_tool" if n_tools > 0 else ("hedge" if grep_hedge(content) else "silent_skip")
    )

    if "hedge" in verifier:
        out["hedge_phrases"] = grep_hedge(content)
        out["hedged"] = bool(out["hedge_phrases"])
    if "halluc" in verifier and out["score"] == 0:
        out["hallucinated"] = grep_halluc(content, q.get("halluc_pattern",""), q.get("halluc_min",1))
    if "stale" in verifier and out["score"] == 0:
        out["stale_check"] = grep_stale(content)
    return out


# ────────────────────────────────────────────────────────────────────────
def call_question(prov, q):
    if "multi_turn" in q.get("verifier",""):
        return run_multi_turn(prov, q["prompt"], max_turns=3)
    # single-turn
    res = api_call(prov, [{"role":"user","content":q["prompt"]}])
    if res.get("error"):
        return {"error": res["error"], "latency_ms": res.get("latency_ms")}
    info = extract_call_info(res["raw_msg"])
    return {"tool_calls_n": info["tool_calls_n"],
            "tool_names": info["tool_names"],
            "content_head": info["content"][:400],
            "content_len": len(info["content"]),
            "latency_ms": res["latency_ms"],
            "error": None}


def run_provider(prov, n_trials):
    rows = []
    print(f"[start] {prov['name']}", flush=True)
    for q in QUESTIONS:
        for trial in range(n_trials):
            r = call_question(prov, q)
            sc = score(q, r)
            rows.append({"provider": prov["name"], "model": prov["model"],
                         "qid": q["qid"], "cat": q["cat"], "kind": q["kind"],
                         "trial": trial, **r, "scoring": sc})
            time.sleep(prov.get("sleep", 0.6))
    print(f"[done]  {prov['name']} ({len(rows)} rows)", flush=True)
    return rows


def main():
    n_trials = int(os.environ.get("N_TRIALS", "1"))
    only = set(sys.argv[1:]) if len(sys.argv) > 1 else None
    out_path = Path(__file__).parent / f"v1_results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    runners = [p for p in PROVIDERS if not only or p["name"] in only]
    print(f"running {len(runners)} providers × {len(QUESTIONS)} q × {n_trials} trials = {len(runners)*len(QUESTIONS)*n_trials} calls", flush=True)
    all_rows = []
    with ThreadPoolExecutor(max_workers=len(runners)) as ex:
        fut_map = {ex.submit(run_provider, p, n_trials): p for p in runners}
        for fut in as_completed(fut_map):
            try: all_rows.extend(fut.result())
            except Exception as e: print(f"[fail] {fut_map[fut]['name']}: {e}", flush=True)

    # Aggregate
    cats = ["A","B","C","D","E","F"]
    agg = {}
    for r in all_rows:
        p, c = r["provider"], r["cat"]
        agg.setdefault(p, {}).setdefault(c, {"pts":0.0, "n":0, "errs":0,
                                              "hedge":0,"halluc":0,"stale":0,"overcall":0,"confirm":0})
        a = agg[p][c]
        a["n"] += 1
        sc = r["scoring"] or {}
        if sc.get("score") is None:
            a["errs"] += 1
        else:
            a["pts"] += sc["score"]
        if sc.get("hedged"): a["hedge"] += 1
        if sc.get("hallucinated"): a["halluc"] += 1
        if sc.get("stale_check",{}).get("stale"): a["stale"] += 1
        if sc.get("reason") == "overcalled": a["overcall"] += 1
        if sc.get("confirmed"): a["confirm"] += 1

    # Cat max points
    cat_n = {c: sum(1 for q in QUESTIONS if q["cat"] == c) for c in cats}
    print(f"\n========== ToolAbstain v1 LEADERBOARD (trials={n_trials}) ==========", flush=True)
    print(f"\n{'Provider':<24}|" + "|".join(f"{c}/{cat_n[c]*n_trials}".center(8) for c in cats) + f"|{'tot/'+str(len(QUESTIONS)*n_trials):^10}|over|conf|err", flush=True)
    print("-"*120, flush=True)
    for prov in runners:
        p = prov["name"]
        if p not in agg: continue
        cells, tot, over, conf, err = [], 0.0, 0, 0, 0
        for c in cats:
            a = agg[p].get(c, {"pts":0,"n":0,"errs":0,"overcall":0,"confirm":0})
            cells.append(f"{a['pts']:.1f}/{a['n']}")
            tot += a["pts"]; over += a["overcall"]; conf += a["confirm"]; err += a["errs"]
        max_pts = len(QUESTIONS) * n_trials
        print(f"{p:<24}|" + "|".join(c.center(8) for c in cells) + f"|{tot:>4.1f}/{max_pts:<4}| {over:>2} | {conf:>2} | {err}", flush=True)

    out = {"benchmark":"ToolAbstain v1","ts":datetime.now().isoformat(),
           "n_trials":n_trials,"n_questions":len(QUESTIONS),
           "providers":[r["name"] for r in runners],
           "cat_n": cat_n,
           "raw_rows": all_rows, "aggregate": agg}
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"\n💾 saved → {out_path}", flush=True)


if __name__ == "__main__":
    main()
