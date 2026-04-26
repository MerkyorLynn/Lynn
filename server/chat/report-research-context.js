import { createStockMarketTool } from "../../lib/tools/stock-market.js";
import {
  createLiveNewsTool,
  createSportsScoreTool,
  createWeatherTool,
} from "../../lib/tools/realtime-info.js";
import { fetchWebContent } from "../../lib/tools/web-fetch.js";
import { runSearchQuery } from "../../lib/tools/web-search.js";
import { inferReportPromptKind } from "../../shared/report-normalizer.js";

const MAX_CONTEXT_CHARS = 9000;
const SEARCH_TIMEOUT_MS = 9000;
const FETCH_TIMEOUT_MS = 7000;
const STOCK_MARKET_TIMEOUT_MS = 12000;
const REALTIME_TOOL_TIMEOUT_MS = 12000;

const KNOWN_STOCK_NAME_TO_CODE = new Map([
  ["华丰科技", "688629"],
]);

const GLOBAL_STOCK_QUOTE_RE = /\b[A-Z]{1,5}\b|\b\d{4,5}\s*\.?\s*HK\b|腾讯控股|腾讯|阿里巴巴|美团|小米集团|苹果|英伟达|微软|谷歌|亚马逊|特斯拉/i;
const STOCK_COMPANY_RE = /[\u4e00-\u9fa5A-Za-z]{2,18}(?:科技|股份|电子|智能|软件|证券|银行|集团|药业|医药|能源|材料|半导体|光电|电气|通信|汽车|机器人|芯片|电力|股份)/;
const STOCK_ANALYSIS_RE = /(?:股票|股价|个股|A股|a股|科创板|创业板|沪深|标的|走势|怎么看|技术面|基本面|估值|市值|总股本|PE|PB|PS|资金|资金流|财报|研报|公告|解禁|减持|支撑位|压力位|K线|k线|均线|成交量|成交额|筹码|止损|止盈|仓位|目标价|三种情景|操作计划|未来1-3个月)/i;
const GENERIC_RESEARCH_RE = /(?=.*(?:调研|研究|分析|评估|对比|比较|判断|怎么看|报告|预测|整理|汇总))(?=.*(?:最新|数据|资料|来源|公司|行业|市场|政策|公告|财报|研报|楼盘|房价|成交|竞品|价格|估值|市值|PDF|文档|报表|合同|产品|品牌))/i;
const WEATHER_LOOKUP_RE = /(?:天气|气温|温度|预报|冷不冷|热不热|下雨|下雪|多少度|几度|紫外线|空气质量|湿度|风力|体感)/i;
const SPORTS_LOOKUP_RE = /(?:比分|赛程|排名|战绩|湖人|勇士|NBA|CBA|英超|中超|欧冠|世界杯|比赛结果)/i;
const MARKET_LOOKUP_RE = /(?:金价|黄金|白银|油价|原油|汇率|美元|人民币|指数|基金|ETF|etf|股价|行情|收盘|涨跌|现价|报价)/i;
const LIVE_NEWS_LOOKUP_RE = /(?=.*(?:今天|今日|今晚|最新|实时|进展|消息|新闻|报道|发生|了吗|如何|怎么样|快讯|热点))(?=.*(?:AI|人工智能|科技|大模型|模型|Gemini|OpenAI|Anthropic|Claude|芯片|半导体|机器人|美伊|伊朗|美国|中东|巴以|以色列|巴勒斯坦|俄乌|俄罗斯|乌克兰|关税|制裁|冲突|停火|谈判|选举|地震|台风|事故|发布|宣布|外交|战争|袭击|股市|市场|公司|政策))/i;
const SIMPLE_STOCK_QUOTE_RE = /(?:股价|现价|最新价|行情|报价|涨跌幅|成交额|换手率).{0,80}(?:多少|是多少|给|只给|直接给|来源|数字)|(?:只给|直接给).{0,80}(?:价格|现价|涨跌幅|成交额|换手率|来源|数字)/i;
const STOCK_DEEP_INTENT_RE = /(?:怎么看|分析|研究|调研|报告|预测|走势|未来|基本面|技术面|估值|市值|区间|资金|资金流|财报|研报|公告|解禁|减持|支撑位|压力位|K线|k线|均线|成交量|筹码|止损|止盈|仓位|目标价|三种情景|操作计划|风险|买|卖|投资)/i;
const MARKET_DEEP_INTENT_RE = /(?:分析|研究|调研|报告|预测|走势|未来|原因|影响|策略|操作|买|卖|投资|基本面|技术面|支撑|压力|估值|市值|区间|怎么看待)/i;

function textOf(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function compactLines(lines, maxChars = 2600) {
  const out = [];
  let used = 0;
  for (const line of lines.map(textOf).filter(Boolean)) {
    const next = line.length + 1;
    if (used + next > maxChars) break;
    out.push(line);
    used += next;
  }
  return out.join("\n");
}

function extractUsefulResearchLines(text, query, maxLines = 5) {
  const queryTerms = String(query || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  const priorityRe = /(?:现价|收盘|涨跌|涨幅|跌幅|成交|换手|市盈率|PE|估值|财报|营收|净利润|毛利率|订单|客户|公告|解禁|减持|研报|机构|资金|主力|龙虎榜|K线|均线|MACD|RSI|支撑|压力|目标价|风险|容积率|绿化率|均价|挂牌|成交价|山景|海景|景观|物业|楼龄|地铁|配套)/i;
  const seen = new Set();
  return String(text || "")
    .split(/\r?\n/)
    .map(textOf)
    .filter((line) => line.length >= 18 && line.length <= 260)
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      if (priorityRe.test(line)) return true;
      return queryTerms.some((term) => line.includes(term)) && /\d/.test(line);
    })
    .slice(0, maxLines);
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function extractStockTargetForResearch(text) {
  const source = String(text || "");
  const code = source.match(/\b([0368]\d{5})\b/)?.[1] || "";
  for (const [name, mappedCode] of KNOWN_STOCK_NAME_TO_CODE) {
    if (source.includes(name)) return { name, code: code || mappedCode };
  }

  const name = source.match(STOCK_COMPANY_RE)?.[0] || "";
  if (name || code) return { name, code };
  return { name: "", code: "" };
}

export function inferReportResearchKind(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return "";
  const promptKind = inferReportPromptKind(normalized);
  if (promptKind) return promptKind;

  const target = extractStockTargetForResearch(normalized);
  if (((target.name || target.code) || GLOBAL_STOCK_QUOTE_RE.test(normalized)) && SIMPLE_STOCK_QUOTE_RE.test(normalized) && !STOCK_DEEP_INTENT_RE.test(normalized)) {
    return "market";
  }
  if ((target.name || target.code) && STOCK_ANALYSIS_RE.test(normalized)) return "stock";
  if (/支撑位|压力位|K线|k线|均线|成交量|成交额|筹码|止损|止盈|目标价/.test(normalized)
    && /(?:\b[0368]\d{5}\b|股票|股价|个股|A股|a股|科创板|创业板|华丰科技)/.test(normalized)) {
    return "stock";
  }
  if (WEATHER_LOOKUP_RE.test(normalized)) return "weather";
  if (SPORTS_LOOKUP_RE.test(normalized)) return "sports";
  if (MARKET_LOOKUP_RE.test(normalized)) return "market";
  if (LIVE_NEWS_LOOKUP_RE.test(normalized)) return "news";
  if (GENERIC_RESEARCH_RE.test(normalized)) return "generic";
  return "";
}

function buildStockQueries(target, userPrompt) {
  const targetText = [target.name, target.code].filter(Boolean).join(" ");
  const base = targetText || textOf(userPrompt).slice(0, 60);
  const prompt = textOf(userPrompt);
  const broad = /怎么看|深度|报告|未来|走势|预测|分析|研究|调研/.test(prompt);
  const wantsValuation = broad || /估值|市值|总股本|目标价|PE|PB|PS|利润|收入|可比|倍数|区间/.test(prompt);
  const wantsFundamentals = broad || /基本面|财报|公告|业绩|订单|客户|行业|景气|毛利|净利|营收|现金流/.test(prompt);
  const wantsTechnical = broad || /技术|支撑|压力|K线|k线|均线|成交|量能|筹码|缺口|MACD|RSI|止损|止盈|仓位/.test(prompt);
  const wantsRisks = broad || /风险|解禁|减持|质押|监管|退潮|回撤|利空/.test(prompt);
  const queries = [`${base} 最新股价 行情 市值 总股本 交易数据`];
  if (wantsFundamentals) queries.push(`${base} 最新财报 公告 业绩 营收 净利润 毛利率 订单 客户 行业`);
  if (wantsValuation) queries.push(`${base} 估值 市值 PE PB PS 可比公司 目标价 利润预测 研报`);
  if (wantsTechnical) queries.push(`${base} 技术走势 支撑位 压力位 K线 均线 成交量 筹码 资金流向`);
  if (wantsRisks) queries.push(`${base} 解禁 减持 风险 科创板`);
  return [...new Set(queries)].slice(0, 5);
}

function buildRealEstateQueries(userPrompt) {
  const prompt = textOf(userPrompt).slice(0, 120);
  return [
    `${prompt} 容积率 绿化率 山海景观 二手房价格`,
    "深圳蛇口 鸣溪谷 山语海 兰溪谷一期 容积率 绿化率 均价",
    "深圳蛇口 低密 山海景观 楼盘 容积率 绿化率 二手房价格",
    "蛇口 兰溪谷 鲸山觐海 双玺 伍兹 南海玫瑰园 容积率 绿化率 价格",
  ];
}

function buildGenericResearchQueries(userPrompt) {
  const prompt = textOf(userPrompt).slice(0, 120);
  return [
    `${prompt} 最新 资料 数据 来源`,
    `${prompt} 官方 公告 报告 文档`,
    `${prompt} 分析 观点 对比 风险`,
  ];
}

async function searchSummary(query, sceneHint) {
  try {
    const result = await withTimeout(runSearchQuery(query, 4, { sceneHint }), SEARCH_TIMEOUT_MS, "search");
    const provider = result.provider || "search";
    const rows = (result.results || []).slice(0, 4).map((item, idx) => {
      return [
        `${idx + 1}. ${item.title || item.url}`,
        item.url ? `   URL: ${item.url}` : "",
        item.snippet ? `   摘要: ${item.snippet}` : "",
      ].filter(Boolean).join("\n");
    });
    let fetchedLines = "";
    const firstUrl = result.results?.[0]?.url;
    if (firstUrl) {
      try {
        const fetched = await withTimeout(fetchWebContent(firstUrl, 3600), FETCH_TIMEOUT_MS, "fetch");
        const lines = extractUsefulResearchLines(fetched.text || "", query, 5);
        if (lines.length) fetchedLines = `首条结果深读摘录：\n${lines.map((line) => `- ${line}`).join("\n")}`;
      } catch {
        // 搜索摘要仍可用，深读失败不阻断整轮回答。
      }
    }
    return [`查询：${query}`, `来源：${provider}`, compactLines(rows, 1600), fetchedLines].filter(Boolean).join("\n");
  } catch (err) {
    return [`查询：${query}`, `结果：搜索失败或超时（${err.message || err}）`].join("\n");
  }
}

async function buildStockResearchContext(text, userPrompt) {
  const target = extractStockTargetForResearch(text);
  if (!target.name && !target.code) return "";

  const queryTarget = [target.name, target.code].filter(Boolean).join(" ");
  const sections = [
    "【系统已完成的自适应股票研究资料预取】",
    "下面是回答前按用户命题动态获取的行情/公告/研报/技术面/风险线索。请围绕用户问的点回答，不要强行套固定股票报告模板，也不要输出“我搜一下/我来查询/继续查吗”这类未完成承诺。",
    "如果用户只问压力位/支撑位，就重点回答技术证据和触发/失效条件；如果问估值/市值区间，就重点回答假设、计算路径、可比锚和区间；如果问整体怎么看，再自然覆盖基本面、估值、技术面、资金情绪、情景和风险。",
    "必要时你可以自己用 bash 跑临时 Python/Node 脚本处理抓取文本、去重资料、制表或计算区间；资料不足时必须标注【待核验】，并向用户索要具体截图、链接、导出数据、PDF 或假设参数。",
    `识别标的：${target.name || "待核验"}${target.code ? `（${target.code}）` : ""}`,
  ];

  const marketPromise = (async () => {
    const tool = createStockMarketTool();
    const market = await withTimeout(
      tool.execute("lynn-report-prefetch", {
        query: `${queryTarget} 最新股价 行情 财报 业绩`,
        kind: "stock",
        symbol: target.code || "",
      }),
      STOCK_MARKET_TIMEOUT_MS,
      "stock_market",
    );
    const marketText = market?.content?.map((item) => item?.text || "").filter(Boolean).join("\n");
    return marketText
      ? `\n【行情快照】\n${marketText.slice(0, 2600)}`
      : "\n【行情快照】\n行情工具未返回可用文本。";
  })().catch((err) => `\n【行情快照】\n行情工具失败或超时：${err.message || err}`);

  const searchesPromise = Promise.all(buildStockQueries(target, userPrompt).map((query) => searchSummary(query, "finance")));
  const [marketSection, searches] = await Promise.all([marketPromise, searchesPromise]);
  sections.push(marketSection);
  sections.push(`\n【补充搜索线索】\n${searches.join("\n\n")}`);
  return sections.join("\n").slice(0, MAX_CONTEXT_CHARS);
}

async function buildRealEstateResearchContext(userPrompt) {
  const sections = [
    "【系统已完成的楼盘对标资料预取】",
    "下面是回答前按用户命题获取的楼盘/容积率/绿化率/价格搜索线索。请围绕用户问的指标自然组织答案，不要强行套固定楼盘报告模板，也不要在信息缺口处停止。",
    "若数据不完整，必须标注【待核验】，并继续给出基于已验证信息的候选、匹配度、价格区间和核验建议；缺成交、户型、楼层、视野或预算时，明确向用户要具体截图或约束。",
  ];
  const searches = await Promise.all(buildRealEstateQueries(userPrompt).map((query) => searchSummary(query, "research")));
  sections.push(`\n【补充搜索线索】\n${searches.join("\n\n")}`);
  return sections.join("\n").slice(0, MAX_CONTEXT_CHARS);
}

async function buildGenericResearchContext(userPrompt) {
  const sections = [
    "【系统已完成的自适应研究资料预取】",
    "下面是回答前按用户命题获取的搜索线索。请围绕用户真正的问题自然延展：先说明资料路径和证据，再给结论；不要强行套固定模板。",
    "如果需要计算、去重、制表或解析长文本，可以自己用 bash 跑临时 Python/Node 脚本。资料不足时，先给已验证部分，再明确向用户索要具体截图、链接、导出文件、PDF 或假设参数。",
  ];
  const searches = await Promise.all(buildGenericResearchQueries(userPrompt).map((query) => searchSummary(query, "research")));
  sections.push(`\n【补充搜索线索】\n${searches.join("\n\n")}`);
  return sections.join("\n").slice(0, MAX_CONTEXT_CHARS);
}

function extractToolText(result) {
  return (result?.content || [])
    .map((item) => item?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function buildRealtimeToolContext({ title, toolFactory, params, timeoutMs = REALTIME_TOOL_TIMEOUT_MS } = {}) {
  const tool = toolFactory();
  const result = await withTimeout(
    tool.execute("lynn-local-prefetch", params || {}),
    timeoutMs,
    tool.name || "realtime_tool",
  );
  const text = extractToolText(result);
  if (!text) return "";
  return [
    title || "【系统已完成实时工具预取】",
    "下面是真实工具已经返回的资料。请直接基于这些资料回答用户，不要再调用工具、不要模拟工具调用、不要输出“我搜一下/我来查询”。",
    "如果资料不足以得出确定结论，请明确说明“未检索到明确证据/需继续核验”，并告诉用户还需要补充什么来源。",
    "",
    text,
  ].join("\n").slice(0, MAX_CONTEXT_CHARS);
}

async function buildWeatherResearchContext(userPrompt) {
  return buildRealtimeToolContext({
    title: "【系统已完成天气工具预取】",
    toolFactory: createWeatherTool,
    params: { query: userPrompt },
  });
}

async function buildSportsResearchContext(userPrompt) {
  return buildRealtimeToolContext({
    title: "【系统已完成体育比分工具预取】",
    toolFactory: createSportsScoreTool,
    params: { query: userPrompt, maxResults: 5 },
  });
}

async function buildMarketResearchContext(userPrompt) {
  return buildRealtimeToolContext({
    title: "【系统已完成行情工具预取】",
    toolFactory: createStockMarketTool,
    params: { query: userPrompt },
    timeoutMs: STOCK_MARKET_TIMEOUT_MS,
  });
}

function sectionBetween(text, start, end = "") {
  const source = String(text || "");
  const from = source.indexOf(start);
  if (from < 0) return "";
  const to = end ? source.indexOf(end, from + start.length) : -1;
  return source.slice(from + start.length, to > from ? to : undefined);
}

function cleanBulletLine(line) {
  return String(line || "")
    .replace(/^\s*[-•]\s*/, "")
    .replace(/，来源\s*[^，。)）\n]+/g, "")
    .replace(/（来源\s*[^)）]+[)）]/g, "")
    .replace(/，时间\s*\d{8,14}/g, "")
    .trim();
}

function extractFirstLine(text, re) {
  return String(text || "").match(re)?.[1]?.trim() || "";
}

function summarizePriceRange(section) {
  const rows = [...String(section || "").matchAll(/-\s*([^:\n]+):\s*([0-9]+(?:\.[0-9]+)?)\s*元\/克/g)]
    .map((match) => ({ name: match[1].trim(), price: Number(match[2]) }))
    .filter((row) => row.name && Number.isFinite(row.price));
  if (!rows.length) return "";
  const min = rows.reduce((a, b) => (a.price <= b.price ? a : b));
  const max = rows.reduce((a, b) => (a.price >= b.price ? a : b));
  if (rows.length === 1 || min.price === max.price) return `${rows[0].price} 元/克（${rows[0].name}）`;
  return `${min.price}-${max.price} 元/克（${min.name}~${max.name}）`;
}

function summarizeMarketContext(userPrompt, context) {
  const prompt = String(userPrompt || "");
  const text = String(context || "");

  if (text.includes("【直连 A 股报价】")) {
    const quote = extractFirstLine(text, /【直连 A 股报价】\s*\n-\s*([^\n]+)/);
    return quote ? `${cleanBulletLine(quote)}。` : "";
  }

  if (text.includes("【直连美股/港股报价】")) {
    const rows = sectionBetween(text, "【直连美股/港股报价】", "财经/行情快照")
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*-\s*(.+)$/)?.[1]?.trim() || "")
      .filter(Boolean)
      .map(cleanBulletLine);
    if (rows.length) return `${rows.join("；")}。`;
  }

  if (text.includes("【直连贵金属报价】")) {
    const xau = extractFirstLine(text, /国际现货黄金 XAU:\s*([^\n]+)/);
    const brand = summarizePriceRange(sectionBetween(text, "品牌金店首饰金价:", "银行投资金条:"));
    const bank = summarizePriceRange(sectionBetween(text, "银行投资金条:", "黄金回收:"));
    const recycle = summarizePriceRange(sectionBetween(text, "黄金回收:", "财经/行情快照"));
    const parts = [];
    if (xau) parts.push(`国际金价约 ${cleanBulletLine(xau)}`);
    if (brand) parts.push(`品牌金饰约 ${brand}`);
    if (bank) parts.push(`银行投资金条约 ${bank}`);
    if (recycle) parts.push(`黄金回收约 ${recycle}`);
    if (parts.length) return `${parts.join("；")}。不同门店和地区工费会有差异。`;
  }

  if (text.includes("【直连原油报价】")) {
    const wantsBrent = /布伦特|brent/i.test(prompt);
    const brent = extractFirstLine(text, /-\s*(布伦特原油期货:[^\n]+)/);
    const wti = extractFirstLine(text, /-\s*(WTI 原油期货:[^\n]+)/);
    if (wantsBrent && brent) return `${cleanBulletLine(brent)}。`;
    const rows = [brent, wti].filter(Boolean).map(cleanBulletLine);
    if (rows.length) return `${rows.join("；")}。`;
  }

  return "";
}

export function buildDirectRealtimeAnswer(userPrompt, context) {
  const kind = inferReportResearchKind(userPrompt);
  if (kind !== "market") return "";
  if (MARKET_DEEP_INTENT_RE.test(String(userPrompt || ""))) return "";
  return summarizeMarketContext(userPrompt, context);
}

async function buildLiveNewsResearchContext(userPrompt) {
  return buildRealtimeToolContext({
    title: "【系统已完成实时新闻工具预取】",
    toolFactory: createLiveNewsTool,
    params: { query: userPrompt, maxResults: 5 },
  });
}

export async function buildReportResearchContext(text, opts = {}) {
  const userPrompt = opts.userPrompt || text;
  const kind = inferReportResearchKind(text);
  if (kind === "stock") return buildStockResearchContext(text, userPrompt);
  if (kind === "real_estate") return buildRealEstateResearchContext(userPrompt);
  if (kind === "weather") return buildWeatherResearchContext(userPrompt);
  if (kind === "sports") return buildSportsResearchContext(userPrompt);
  if (kind === "market") return buildMarketResearchContext(userPrompt);
  if (kind === "news") return buildLiveNewsResearchContext(userPrompt);
  if (kind === "generic") return buildGenericResearchContext(userPrompt);
  return "";
}
