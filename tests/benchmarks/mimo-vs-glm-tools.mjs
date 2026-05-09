#!/usr/bin/env node
/**
 * MiMo (web_search 联网插件) vs GLM-5.1 (web_search 内置工具) — V8 4 道 tool 题对比
 *
 * 不参与横评,单纯评估:
 *   - 是否真联网拿到实时数据
 *   - 速度 / 准确性 / 高峰超时
 *
 * 用于决策:Lynn brain 这个月默认模型是否换 MiMo 2.5 Pro
 */
import fs from "node:fs";
import path from "node:path";

function loadEnv() {
  const env = {};
  const fp = path.join(process.env.HOME, ".lynn/brain.env");
  for (const line of fs.readFileSync(fp, "utf-8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const [k, ...rest] = s.split("=");
    env[k.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  return env;
}
const ENV = loadEnv();
const requireEnv = (name) => {
  const value = process.env[name] || ENV[name];
  if (!value) throw new Error(`${name} is required; refusing to run benchmark with a hardcoded key.`);
  return value;
};

const TOOL_CASES = [
  {
    id: "T07",
    name: "财经实时性",
    prompt: "【T07】查今天 AAPL 和 TSLA 最新股价或最近可用行情,给时间戳、来源,提醒是否构成投资建议。",
    pass_re: /(?:AAPL|苹果).*?\$?\d+(?:\.\d+)?|(?:TSLA|特斯拉).*?\$?\d+/i,
    needs: ["AAPL", "TSLA", "股价/价格/数字"],
  },
  {
    id: "T08",
    name: "新闻实时性",
    prompt: "【T08】给今天科技/AI 领域 2 条重要新闻,每条含发生日期、来源链接、为什么重要。无法联网请明确说明。",
    pass_re: /20(?:25|26).?\d{1,2}.?\d{1,2}|(?:今天|昨天|本周|近日|刚刚)/,
    needs: ["2 条新闻", "日期", "来源链接"],
  },
  {
    id: "A4",
    name: "多工具编排",
    prompt: "帮我查今天 AAPL 股价、北京天气、上证指数,综合:(a) 美股收盘时北京天气 (b) 今天 A 股涨还是跌 (c) 明早 8 点从北京出差去上海是否合适。",
    pass_re: /(?:AAPL|苹果).*\d/i,
    needs: ["AAPL 股价", "北京天气", "上证指数", "综合分析"],
  },
  {
    id: "RT-CLOUD",
    name: "天气查询",
    prompt: "用工具查一下今天上海天气。",
    pass_re: /(?:上海).*?(?:-?\d+(?:\.\d+)?\s*(?:°\s*C|°C|℃|度)|\d+\s*~\s*\d+\s*(?:°C|℃|度)|晴|多云|阴|小雨|中雨|大雨|阵雨|雷雨|暴雨|降雨|降水)/,
    needs: ["上海天气", "温度/天气描述"],
  },
];

// MiMo with web_search plugin (主 endpoint + sk- key + force_search)
async function callMimo(prompt, timeoutMs = 90000) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${requireEnv("MIMO_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "mimo-v2.5-pro",
        messages: [{ role: "user", content: prompt }],
        tools: [{
          type: "web_search",
          max_keyword: 3,
          force_search: true,
          limit: 5,
        }],
        max_completion_tokens: 4096,
        temperature: 0.3,
        thinking: { type: "disabled" },
      }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, ms: Date.now() - t0, error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` };
    const data = await resp.json();
    const msg = data.choices?.[0]?.message;
    const content = msg?.content || msg?.reasoning_content || "";
    const ann = msg?.annotations?.length || 0;
    const ws = data?.usage?.web_search_usage;
    return { ok: true, ms: Date.now() - t0, full: content, annotations: ann, web_search: ws };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, ms: Date.now() - t0, error: `${e.name}: ${e.message}` };
  }
}

// GLM with web_search built-in
async function callGlm(prompt, timeoutMs = 120000) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${requireEnv("ZHIPU_CODING_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "GLM-5.1",
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search", web_search: { enable: true, search_result: true } }],
        max_tokens: 4096,
        temperature: 0.3,
      }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, ms: Date.now() - t0, error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` };
    const data = await resp.json();
    const msg = data.choices?.[0]?.message;
    const content = msg?.content || "";
    return { ok: true, ms: Date.now() - t0, full: content };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, ms: Date.now() - t0, error: `${e.name}: ${e.message}` };
  }
}

async function runProvider(name, callFn) {
  console.log(`\n=== ${name} ===`);
  const results = [];
  for (const c of TOOL_CASES) {
    process.stdout.write(`  [${c.id.padEnd(8)}] ${c.name.padEnd(10)} ... `);
    const r = await callFn(c.prompt);
    let pass = false;
    let why = "";
    if (!r.ok) {
      why = r.error.slice(0, 60);
    } else {
      pass = c.pass_re.test(r.full);
      const meta = [];
      if (r.annotations !== undefined) meta.push(`ann=${r.annotations}`);
      if (r.web_search) meta.push(`ws=${r.web_search.tool_usage}/${r.web_search.page_usage}`);
      why = (pass ? "matched pattern" : "no match") + (meta.length ? " " + meta.join(",") : "");
    }
    console.log(`${pass ? "PASS" : "FAIL"}  ${r.ms}ms  ${why}`);
    results.push({ id: c.id, pass, ms: r.ms, error: r.error || null, raw: (r.full || "").slice(0, 2000), annotations: r.annotations, web_search: r.web_search });
    await new Promise((res) => setTimeout(res, 500));
  }
  const passN = results.filter((r) => r.pass).length;
  const okN = results.filter((r) => !r.error).length;
  const avgMs = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);
  console.log(`  Total: pass ${passN}/${results.length} · ok ${okN}/${results.length} · avg ${avgMs}ms`);
  return { name, passN, okN, total: results.length, avgMs, results };
}

async function main() {
  console.log("MiMo (联网插件) vs GLM-5.1 (web_search) — V8 4 道 tool 题");
  const mimo = await runProvider("MiMo 2.5 Pro + webSearch", callMimo);
  const glm = await runProvider("GLM-5.1 + web_search", callGlm);

  console.log("\n" + "=".repeat(60));
  console.log("Summary:");
  console.log(`  ${mimo.name.padEnd(35)} pass=${mimo.passN}/${mimo.total} ok=${mimo.okN}/${mimo.total} avg=${mimo.avgMs}ms`);
  console.log(`  ${glm.name.padEnd(35)} pass=${glm.passN}/${glm.total} ok=${glm.okN}/${glm.total} avg=${glm.avgMs}ms`);

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = `tests/benchmarks/output/mimo-vs-glm-tools-${ts}.json`;
  fs.writeFileSync(out, JSON.stringify({ mimo, glm }, null, 2));
  console.log(`\nSaved: ${out}`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
