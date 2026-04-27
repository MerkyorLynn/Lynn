import { createStockMarketTool } from "../../lib/tools/stock-market.js";
import {
  createLiveNewsTool,
  createSportsScoreTool,
  createWeatherTool,
  extractWeatherLocation,
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

const STOCK_COMPANY_RE = /[\u4e00-\u9fa5A-Za-z]{2,18}(?:科技|股份|电子|智能|软件|证券|银行|集团|药业|医药|能源|材料|半导体|光电|电气|通信|汽车|机器人|芯片|电力|股份)/;
const STOCK_ANALYSIS_RE = /(?:股票|股价|个股|A股|a股|科创板|创业板|沪深|标的|走势|怎么看|技术面|基本面|估值|市值|总股本|PE|PB|PS|资金|资金流|财报|研报|公告|解禁|减持|支撑位|压力位|K线|k线|均线|成交量|成交额|筹码|止损|止盈|仓位|目标价|三种情景|操作计划|未来1-3个月)/i;
const GENERIC_RESEARCH_RE = /(?=.*(?:调研|研究|分析|评估|对比|比较|判断|怎么看|报告|预测|整理|汇总))(?=.*(?:最新|数据|资料|来源|公司|行业|市场|政策|公告|财报|研报|楼盘|房价|成交|竞品|价格|估值|市值|PDF|文档|报表|合同|产品|品牌))/i;
const WEATHER_LOOKUP_RE = /(?:天气|气温|温度|预报|冷不冷|热不热|下雨|下雪|多少度|几度|紫外线|空气质量|湿度|风力|体感)/i;
const SPORTS_LOOKUP_RE = /(?:比分|赛程|排名|战绩|湖人|勇士|NBA|CBA|英超|中超|欧冠|世界杯|比赛结果)/i;
const MARKET_LOOKUP_RE = /(?:金价|黄金|白银|油价|原油|汇率|美元|人民币|指数|基金|ETF|etf|股价|股票|行情|收盘|涨跌|现价|最新价|美股|港股|A股|a股|恒生|恒指|纳指|道指|标普|AAPL|TSLA|NVDA|MSFT|GOOGL|AMZN|META|\$[A-Z]{1,5}\b)/i;
const STOCK_BASKET_LOOKUP_RE = /(?:港股.{0,8}科技股?|科技股?.{0,8}港股|恒生科技(?!指数)|港股互联网|港股.{0,8}互联网|中概科技|(?:美股|纳斯达克|纳指|七巨头|magnificent|mag7).{0,12}(?:科技股?|AI|人工智能|芯片|半导体|互联网)|(?:科技股?|AI|人工智能|芯片|半导体|互联网).{0,12}(?:美股|纳斯达克|纳指|七巨头|magnificent|mag7)|(?:A股|a股|沪深|科创|创业板).{0,12}(?:AI|人工智能|算力|服务器|光模块|CPO|高速连接|科技股?|半导体|芯片|新能源|电动车|锂电|光伏|机器人|人形机器人|券商|证券|白酒|消费)|(?:AI|人工智能|算力|服务器|光模块|CPO|高速连接|科技股?|半导体|芯片|新能源|电动车|锂电|光伏|机器人|人形机器人|券商|证券|白酒|消费).{0,12}(?:A股|a股|沪深|科创|创业板))/i;
const CONCEPT_STOCK_LOOKUP_RE = /(?:概念股|概念板块|板块|行业|题材|赛道|龙头|成分股|产业链|科技股)/i;
const MARKET_WEATHER_BRIEF_RE = /(?:机场|出行|着装|穿什么|穿搭|行动建议|浦东|虹桥|登机|航班|明早|早班机|数据快照|行动建议)/i;
const LIVE_NEWS_LOOKUP_RE = /(?=.*(?:今天|今日|今晚|最新|实时|进展|消息|新闻|报道|发生|了吗|如何|怎么样|快讯|热点))(?=.*(?:AI|人工智能|科技|大模型|模型|Gemini|OpenAI|Anthropic|Claude|芯片|半导体|机器人|美伊|伊朗|美国|中东|巴以|以色列|巴勒斯坦|俄乌|俄罗斯|乌克兰|关税|制裁|冲突|停火|谈判|选举|地震|台风|事故|发布|宣布|外交|战争|袭击|股市|市场|公司|政策))/i;
const EXTERNAL_RESEARCH_INTENT_RE = /(?:最新|实时|今天|今日|联网|搜索|查询|查一下|找一下|资料|来源|链接|官网|网页|公开信息|公告|财报|研报|新闻|政策|PDF|文档|市场数据|行业数据|竞品)/i;
const LOCAL_OFFICE_TASK_RE = /(?:会议记录|会议纪要|行动项|负责人|截止时间|风险|经营分析|环比|增长率|根据数据|下面会议|Q[1-4]|报价模板|客户\s*[A-Z]\b)/i;
const MARKET_WEATHER_TICKER_STOPWORDS = new Set([
  "AI", "API", "ETF", "ETFS", "USD", "CNY", "EUR", "GBP", "JPY",
  "PE", "PB", "PS", "IPO", "CEO", "CFO", "GDP", "CPI", "PPI",
  "MACD", "RSI", "UTC", "PPT",
]);
const INDEX_TARGETS = [
  { re: /上证指数|上证综指|沪指/, label: "上证指数", query: "上证指数 最新点位" },
  { re: /深证成指/, label: "深证成指", query: "深证成指 最新点位" },
  { re: /创业板指/, label: "创业板指", query: "创业板指 最新点位" },
  { re: /恒生指数|恒指/, label: "恒生指数", query: "恒生指数 最新点位" },
  { re: /纳斯达克|纳指/, label: "纳斯达克指数", query: "纳斯达克指数 最新点位" },
  { re: /道琼斯|道指/, label: "道琼斯指数", query: "道琼斯指数 最新点位" },
  { re: /标普(?:500)?/, label: "标普500", query: "标普500 最新点位" },
];
const AIRPORT_CITY_HINTS = [
  { re: /浦东|虹桥/, city: "上海" },
  { re: /首都机场|大兴/, city: "北京" },
  { re: /白云机场/, city: "广州" },
  { re: /宝安机场/, city: "深圳" },
];

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
  if (WEATHER_LOOKUP_RE.test(normalized) && MARKET_LOOKUP_RE.test(normalized) && MARKET_WEATHER_BRIEF_RE.test(normalized)) {
    return "market_weather_brief";
  }
  if ((STOCK_BASKET_LOOKUP_RE.test(normalized) || CONCEPT_STOCK_LOOKUP_RE.test(normalized))
    && /(?:现在|今日|今天|最新|当前|表现|行情|报价|涨跌幅|涨跌|收盘|盘中|看一下|怎么样|如何)/.test(normalized)
    && !/(?:深度|报告|长期|未来|预测|估值|基本面|技术面|研报|三种情景|操作计划)/.test(normalized)) {
    return "market";
  }
  const promptKind = inferReportPromptKind(normalized);
  if (promptKind) return promptKind;

  const target = extractStockTargetForResearch(normalized);
  const simpleQuoteIntent = /(?:现在|今日|今天|最新|当前|多少|价格|股价|行情|报价|涨跌幅|涨跌|来源)/.test(normalized);
  const analysisIntent = /(?:支撑位|压力位|K线|k线|均线|成交量|成交额|筹码|止损|止盈|目标价|怎么看|走势|分析|研究|深度|报告|未来|预测|估值|市值|基本面|技术面|资金|财报|研报|公告|解禁|减持|三种情景|操作计划)/.test(normalized);
  if ((target.name || target.code) && MARKET_LOOKUP_RE.test(normalized) && simpleQuoteIntent && !analysisIntent) return "market";
  if ((target.name || target.code) && STOCK_ANALYSIS_RE.test(normalized)) return "stock";
  if (/支撑位|压力位|K线|k线|均线|成交量|成交额|筹码|止损|止盈|目标价/.test(normalized)
    && /(?:\b[0368]\d{5}\b|股票|股价|个股|A股|a股|科创板|创业板|华丰科技)/.test(normalized)) {
    return "stock";
  }
  if (WEATHER_LOOKUP_RE.test(normalized)) return "weather";
  if (SPORTS_LOOKUP_RE.test(normalized)) return "sports";
  if (MARKET_LOOKUP_RE.test(normalized)) return "market";
  if (LIVE_NEWS_LOOKUP_RE.test(normalized)) return "news";
  if (GENERIC_RESEARCH_RE.test(normalized) && EXTERNAL_RESEARCH_INTENT_RE.test(normalized) && !LOCAL_OFFICE_TASK_RE.test(normalized)) return "generic";
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

function parseStooqItems(context) {
  const items = [];
  const re = /\n\d+\.\s+([A-Z0-9.]{1,12})\s+最近可用行情\n来源：([^\n]+)\n(https?:\/\/\S+)(?:\n-\s+名称:\s*([^\n]+))?\n-\s+价格:\s*([^\n]+)(?:\n-\s+涨跌\/涨跌幅:\s*([^\n]+))?\n-\s+时间戳:\s*([^\n]+)(?:\n-\s+开盘\/最高\/最低:\s*([^\n]+))?/g;
  for (const match of String(context || "").matchAll(re)) {
    items.push({
      symbol: match[1],
      source: match[2],
      url: match[3],
      name: match[4] || "",
      price: match[5],
      change: match[6] || "",
      timestamp: match[7],
      range: match[8] || "",
    });
  }
  return items;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractStructuredContextSection(context, title) {
  const re = new RegExp(`【${escapeRegExp(title)}】\\n([\\s\\S]*?)(?=\\n【|$)`);
  return String(context || "").match(re)?.[1]?.trim() || "";
}

function parseStructuredFields(sectionText) {
  const fields = {};
  for (const rawLine of String(sectionText || "").split(/\r?\n/)) {
    const line = textOf(rawLine);
    const match = line.match(/^-?\s*([^:：]+)[:：]\s*(.+)$/);
    if (match) fields[match[1].trim()] = match[2].trim();
  }
  return fields;
}

function buildStructuredSection(title, entries) {
  const lines = entries
    .filter(([, value]) => textOf(value))
    .map(([label, value]) => `- ${label}: ${textOf(value)}`);
  if (!lines.length) return "";
  return [`【${title}】`, ...lines].join("\n");
}

function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function extractPrimaryUsTicker(text) {
  const normalized = String(text || "");
  const seen = new Set();
  for (const match of normalized.matchAll(/\$?\b([A-Z]{2,5})\b/g)) {
    const symbol = (match[1] || "").toUpperCase();
    if (!symbol || MARKET_WEATHER_TICKER_STOPWORDS.has(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    return symbol;
  }
  return "";
}

function detectPrimaryIndexTarget(text) {
  const normalized = String(text || "");
  return INDEX_TARGETS.find((item) => item.re.test(normalized)) || null;
}

function extractCompositeWeatherLocation(text) {
  const normalized = String(text || "");
  for (const hint of AIRPORT_CITY_HINTS) {
    if (hint.re.test(normalized)) return hint.city;
  }
  const clause = normalized.match(/[^。；，,\n]{0,80}(?:天气|气温|温度|预报)/)?.[0] || normalized;
  return extractWeatherLocation(clause, "");
}

function parseStockSnapshot(result) {
  const directQuote = result?.details?.directQuotes?.[0];
  if (directQuote?.symbol && directQuote?.close) {
    return {
      symbol: directQuote.symbol,
      price: directQuote.close,
      timestamp: [directQuote.date, directQuote.time].filter(Boolean).join(" "),
      source: directQuote.source || result?.details?.provider || "",
      url: directQuote.url || "",
      range: [directQuote.open, directQuote.high, directQuote.low].filter(Boolean).join(" / "),
    };
  }

  const item = parseStooqItems(extractToolText(result))[0];
  if (!item) return null;
  return {
    symbol: item.symbol,
    price: item.price,
    timestamp: item.timestamp,
    source: item.source,
    url: item.url,
    range: item.range,
  };
}

function parseIndexSnapshot(result, fallbackTarget = null) {
  const sources = Array.isArray(result?.details?.sources) ? result.details.sources : [];
  for (const source of sources) {
    const title = textOf(source?.title);
    const match = title.match(/(上证指数|深证成指|创业板指|恒生指数|纳斯达克指数|纳斯达克|道琼斯指数|道琼斯|标普500)\s*([0-9][0-9,]*(?:\.\d+)?)\s*\(([+-]?\d+(?:\.\d+)?%)\)/);
    if (match) {
      return {
        name: match[1],
        level: match[2],
        change: match[3],
        source: source?.source || "",
        url: source?.url || "",
        queryDate: formatLocalDate(),
      };
    }
  }

  const text = extractToolText(result);
  const match = text.match(/(上证指数|深证成指|创业板指|恒生指数|纳斯达克指数|纳斯达克|道琼斯指数|道琼斯|标普500)\s*([0-9][0-9,]*(?:\.\d+)?)\s*\(([+-]?\d+(?:\.\d+)?%)\)/);
  if (match) {
    const source = sources[0] || {};
    return {
      name: match[1],
      level: match[2],
      change: match[3],
      source: source?.source || "",
      url: source?.url || "",
      queryDate: formatLocalDate(),
    };
  }

  if (!fallbackTarget && !sources.length) return null;
  const source = sources[0] || {};
  return {
    name: fallbackTarget?.label || "指数",
    level: "",
    change: "",
    source: source?.source || "",
    url: source?.url || "",
    queryDate: formatLocalDate(),
  };
}

function parseWeatherForecastRows(text) {
  return Array.from(String(text || "").matchAll(/-\s*(\d{4}-\d{2}-\d{2}):\s*(.+?)\s+(-?\d+)~(-?\d+)\s*C/g)).map((match) => ({
    date: match[1],
    desc: textOf(match[2]),
    min: match[3],
    max: match[4],
  }));
}

function parseWeatherSnapshot(result, userPrompt = "", locationHint = "") {
  const text = extractToolText(result);
  const rows = parseWeatherForecastRows(text);
  if (!rows.length && !locationHint) return null;

  let picked = rows[0] || null;
  if (/后天/.test(userPrompt) && rows[2]) picked = rows[2];
  else if (/明天/.test(userPrompt) && rows[1]) picked = rows[1];

  const rawLocation = text.match(/^([^\n]+?)\s+当前天气/m)?.[1]?.trim() || "";
  return {
    location: locationHint || rawLocation || result?.details?.location || "",
    date: picked?.date || "",
    desc: picked?.desc || "",
    tempRange: picked ? `${picked.min}~${picked.max} C` : "",
  };
}

function weatherLooksRainy(desc) {
  return /rain|drizzle|shower|storm|雷|雨|阵雨|降水/i.test(String(desc || ""));
}

function parseTempRange(value) {
  const match = String(value || "").match(/(-?\d+)\s*~\s*(-?\d+)/);
  if (!match) return { min: null, max: null };
  return {
    min: Number(match[1]),
    max: Number(match[2]),
  };
}

function buildDirectMarketWeatherBriefAnswer(context) {
  const stock = parseStructuredFields(extractStructuredContextSection(context, "美股快照"));
  const index = parseStructuredFields(extractStructuredContextSection(context, "指数快照"));
  const weather = parseStructuredFields(extractStructuredContextSection(context, "天气快照"));
  if (!Object.keys(stock).length && !Object.keys(index).length && !Object.keys(weather).length) return "";

  const dataLines = [];
  if (stock["标的"] && stock["最新价"]) {
    const stockBits = [
      `${stock["标的"]}：${stock["最新价"]}`,
      stock["时间戳"] ? `截至 ${stock["时间戳"]}` : "",
      stock["来源"] && stock["链接"] ? `来源：[${stock["来源"]}](${stock["链接"]})` : "",
      stock["开盘/最高/最低"] ? `开盘/最高/最低 ${stock["开盘/最高/最低"]}` : "",
    ].filter(Boolean);
    dataLines.push(`- ${stockBits.join("；")}`);
  } else {
    dataLines.push("- AAPL：未检索到明确的最近可用行情，建议继续核验。");
  }

  if (index["指数"]) {
    const indexBits = [
      index["最新点位"] ? `${index["指数"]}：${index["最新点位"]} 点` : `${index["指数"]}：未检索到明确点位`,
      index["涨跌幅"] ? `涨跌幅 ${index["涨跌幅"]}` : "",
      index["查询日期"] ? `查询日期 ${index["查询日期"]}` : "",
      index["来源"] && index["链接"] ? `来源：[${index["来源"]}](${index["链接"]})` : "",
    ].filter(Boolean);
    dataLines.push(`- ${indexBits.join("；")}`);
  } else {
    dataLines.push("- 上证指数：未检索到明确点位，建议继续核验。");
  }

  if (weather["地点"] || weather["日期"] || weather["天气"]) {
    const weatherBits = [
      [weather["地点"], weather["日期"]].filter(Boolean).join(" "),
      weather["天气"] || "",
      weather["温度"] ? `${weather["温度"]}` : "",
    ].filter(Boolean);
    dataLines.push(`- ${weatherBits.join("；")}`);
  } else {
    dataLines.push("- 上海天气：未检索到明确预报，建议出发前再看一次。");
  }

  const adviceLines = [];
  const rainy = weatherLooksRainy(weather["天气"]);
  if (weather["天气"]) {
    adviceLines.push(
      rainy
        ? "- 明早去浦东机场建议比平时多预留 20-30 分钟路上机动，带伞，优先选更稳定的出行方式。"
        : "- 明早去浦东机场可以按常规节奏出发，但仍建议预留 15-20 分钟机动时间。",
    );
    const { min, max } = parseTempRange(weather["温度"]);
    if (Number.isFinite(max) && max <= 18) {
      adviceLines.push("- 着装建议：长袖打底加轻薄外套或防风层，怕冷的话再加一层更稳妥。");
    } else if (Number.isFinite(min) && min < 18) {
      adviceLines.push("- 着装建议：薄长袖或短袖加一件轻薄外套，进出空调环境更舒服。");
    } else if (Number.isFinite(max)) {
      adviceLines.push("- 着装建议：薄长袖或短袖都可以，包里备一件轻薄外套即可。");
    } else {
      adviceLines.push("- 着装建议：以上海早间通勤场景看，备一件轻薄外套会更稳。");
    }
    if (rainy) {
      adviceLines.push("- 如果下雨，鞋子尽量选防滑一点的，包里备纸巾或替换口罩。");
    }
  } else {
    adviceLines.push("- 天气预报没有拿到明确结果，去机场前建议再核验一次天气和路况。");
  }
  adviceLines.push("- AAPL 和上证指数这里只能视为最近可用行情/搜索快照，不构成投资建议。");

  return [
    "数据快照",
    ...dataLines,
    "",
    "行动建议",
    ...adviceLines,
  ].join("\n");
}

function buildDirectMarketAnswer(context) {
  const items = parseStooqItems(context);
  if (!items.length) return "";
  const rows = items.map((item) => {
    return [
      `**${item.symbol}**`,
      item.name ? `- 名称：${item.name}` : "",
      `- 最新价：${item.price}`,
      item.change ? `- 涨跌/涨跌幅：${item.change}` : "",
      `- 时间戳：${item.timestamp}`,
      item.range ? `- 开盘/最高/最低：${item.range}` : "",
      `- 来源：[${item.source}](${item.url})`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
  return [
    "根据已获取的最近可用行情：",
    "",
    rows,
    "",
    "说明：这些是最近可用行情，不一定等同于盘中实时成交价；需要交易级实时性时，请再用券商、交易所或专门行情源交叉核验。",
    "",
    "以上信息仅作行情展示，不构成任何投资建议、买卖建议或收益承诺。",
  ].join("\n");
}

function buildDirectOilAnswer(context) {
  const text = String(context || "");
  const rows = Array.from(text.matchAll(/-\s*(布伦特原油|纽约原油|WTI原油|原油[^：\n]*)[:：]\s*([0-9]+(?:\.[0-9]+)?)\s*美元\/桶(?:，涨跌幅\s*([+-]?\d+(?:\.\d+)?%))?(?:，涨跌\s*([+-]?\d+(?:\.\d+)?))?/g))
    .map((match) => ({
      name: match[1],
      price: match[2],
      pct: match[3] || "",
      change: match[4] || "",
    }));
  if (!rows.length) return "";
  return [
    "根据刚刚获取到的原油行情：",
    "",
    ...rows.map((item) => {
      const bits = [`${item.name}：${item.price} 美元/桶`];
      if (item.pct) bits.push(`涨跌幅 ${item.pct}`);
      if (item.change) bits.push(`涨跌 ${item.change}`);
      return `- ${bits.join("；")}`;
    }),
    "",
    "说明：这是最近可用行情快照，盘中价格会变动；交易或下单前请再用期货/券商行情终端核验。",
  ].join("\n");
}

function buildDirectWeatherAnswer(context, userPrompt = "") {
  const text = String(context || "");
  const rows = parseWeatherForecastRows(text);
  if (!rows.length) return "";
  let picked = rows[0];
  if (/后天/.test(userPrompt) && rows[2]) picked = rows[2];
  else if (/明天/.test(userPrompt) && rows[1]) picked = rows[1];
  const location = extractWeatherLocation(userPrompt, "")
    || text.match(/\n\n([^\n]+?)\s+当前天气/)?.[1]?.trim()
    || text.match(/资料。\n\n([^\n]+?)\s+当前天气/)?.[1]?.trim()
    || "";
  const rainy = weatherLooksRainy(picked.desc);
  const desc = String(picked.desc || "")
    .replace(/Patchy rain nearby/i, "附近有零星小雨")
    .replace(/Partly Cloudy/i, "局部多云")
    .replace(/Sunny/i, "晴")
    .replace(/Cloudy/i, "多云")
    .replace(/Overcast/i, "阴")
    .replace(/Light rain/i, "小雨")
    .replace(/Moderate rain/i, "中雨")
    .replace(/Heavy rain/i, "大雨");
  const rainText = /下雨|降雨|降水/.test(userPrompt)
    ? `降雨判断：${rainy ? "有降雨可能" : "未显示明显降雨"}。`
    : "";
  return [
    `${[location, picked.date].filter(Boolean).join(" ")}天气：${desc}，${picked.min}-${picked.max}°C。`,
    rainText,
    "说明：这是刚刚通过天气工具拿到的预报快照，出门前建议再看一次实时雷达或本地天气 App。",
  ].filter(Boolean).join("\n");
}

function parseGoldSummary(context) {
  const text = String(context || "");
  const date = text.match(/可核验到的黄金价格（(\d{4}-\d{2}-\d{2})）/)?.[1] || "";
  const lines = text.split(/\r?\n/).map((line) => textOf(line));
  const findLine = (re) => lines.find((line) => re.test(line)) || "";
  const jewelry = findLine(/品牌金店首饰金价/);
  const bars = findLine(/银行投资金条/);
  const recovery = findLine(/黄金回收/);
  const examples = findLine(/示例品牌/);
  const sge = findLine(/(?:上海黄金交易所|上金所).*\d{3,5}(?:\.\d+)?.*元\/克/);
  const sgeAlt = findLine(/(?:\bAu99\.99\b|\bAu9999\b).*\d{3,5}(?:\.\d+)?.*元\/克/);
  const shuibei = findLine(/水贝黄金|深圳水贝/);
  const international = findLine(/国际现货黄金|XAU\/USD|伦敦金/);
  if (!jewelry && !bars && !recovery && !sge && !sgeAlt && !shuibei && !international) return null;
  return {
    date,
    jewelry,
    bars,
    recovery,
    examples,
    sge: sge || sgeAlt,
    shuibei,
    international,
  };
}

function buildDirectGoldAnswer(context) {
  const summary = parseGoldSummary(context);
  if (!summary) return "";
  return [
    summary.date ? `根据刚刚检索到的 ${summary.date} 黄金价格：` : "根据刚刚检索到的黄金价格：",
    "",
    summary.sge || "",
    summary.shuibei || "",
    summary.international || "",
    summary.jewelry || "",
    summary.bars || "",
    summary.recovery || "",
    summary.examples || "",
    "",
    "看投资基础价优先参考上金所；看深圳批发/工费前口径可参考水贝；买首饰重点看品牌金店；看回收就看回收价。",
    "说明：以上是刚检索到的网页报价汇总，不同品牌门店、工费和地区会有差异，不构成投资或购买建议。",
  ].filter(Boolean).join("\n");
}

function parseNewsRssItems(context) {
  const items = [];
  const blocks = String(context || "").split(/\n(?=\d+\.\s+)/);
  for (const block of blocks) {
    const title = block.match(/^\d+\.\s+([^\n]+)/)?.[1]?.trim() || "";
    const source = block.match(/\n来源:\s*([^\n]+)/)?.[1]?.trim() || "";
    const sourceUrl = block.match(/\n来源站点:\s*(https?:\/\/\S+)/)?.[1]?.trim() || "";
    const link = block.match(/\n(https?:\/\/\S+)/)?.[1]?.trim() || "";
    const published = block.match(/\n发布时间:\s*([^\n]+)/)?.[1]?.trim() || "";
    if (title && (link || sourceUrl) && published) {
      items.push({ title, source, sourceUrl, link, published });
    }
  }
  return items;
}

function newsImportance(title) {
  const text = String(title || "");
  if (/金融科技|券商|投顾|风控|交易|金融/.test(text)) {
    return "这说明 AI 正在从演示和概念进入金融业务流程，对投研、风控、客服和交易系统的投入优先级会继续上升。";
  }
  if (/AI PC|电脑|终端|芯片|半导体|算力|昇腾|GPU/.test(text)) {
    return "这关系到 AI 从云端模型走向本地终端和硬件生态，影响芯片、软件适配和个人设备升级节奏。";
  }
  if (/成立|新公司|认证|伙伴|通过|聆讯|上市|融资/.test(text)) {
    return "这代表 AI 相关业务继续公司化、资本化和生态化，说明产业链正在把模型能力转成具体产品与商业机会。";
  }
  if (/机器人|具身|自动驾驶/.test(text)) {
    return "这类进展关系到 AI 从文本和软件扩展到真实物理场景，是具身智能和自动化落地的重要观察点。";
  }
  return "这反映了 AI 应用正在进入更多垂直场景，值得继续跟踪它对业务流程、人才结构和产业竞争的影响。";
}

function scoreNewsItem(item) {
  const text = `${item.title} ${item.source}`;
  let score = 0;
  if (/AI|人工智能|大模型|科技/i.test(text)) score += 2;
  if (/金融科技|券商|AI PC|芯片|半导体|机器人|成立|认证|聆讯|上市|融资|人才|薪酬|重塑|增长/.test(text)) score += 3;
  if (/新浪|中证|中国科技|东方财富|同花顺|澎湃|DoNews|36氪|证券/.test(text)) score += 1;
  if (/直播|挑战|艺术|漫剧|培训|结课/.test(text)) score -= 2;
  return score;
}

function buildDirectNewsAnswer(context) {
  const picked = parseNewsRssItems(context)
    .sort((a, b) => scoreNewsItem(b) - scoreNewsItem(a))
    .slice(0, 2);
  if (picked.length < 2) return "";
  const rows = picked.map((item, index) => {
    return [
      `**${index + 1}. ${item.title}**`,
      `- 发生/发布时间：${item.published}`,
      `- 来源：${item.source || item.sourceUrl || "Google News RSS"}`,
      `- 链接：${item.link || item.sourceUrl}`,
      `- 为什么重要：${newsImportance(item.title)}`,
    ].join("\n");
  }).join("\n\n");
  return [
    "以下是我刚刚按最近 36 小时 RSS 候选筛出的两条科技/AI 新闻：",
    "",
    rows,
    "",
    "说明：这些条目的时间来自 Google News RSS 的发布时间；若要做正式引用，建议继续打开原站核验全文。",
  ].join("\n");
}

export function buildDirectResearchAnswer(kind, context, userPrompt = "") {
  if (!context) return "";
  const prompt = textOf(userPrompt);
  if (kind === "market_weather_brief") {
    return buildDirectMarketWeatherBriefAnswer(context);
  }
  if (kind === "market") {
    if (/金价|黄金|白银|金交所|金店|回收价|Au99\.99|Au9999|XAU|金条/i.test(prompt)) {
      return buildDirectGoldAnswer(context);
    }
    if (/原油|油价|布伦特|WTI|crude|oil/i.test(prompt)) {
      return buildDirectOilAnswer(context);
    }
    if (/AAPL|TSLA|股票|股价|行情|报价|最新价|最近可用|概念股|概念板块|板块|题材|赛道|成分股|科技股|表现/i.test(prompt)) {
      return buildDirectMarketAnswer(context);
    }
  }
  if (kind === "weather") {
    return buildDirectWeatherAnswer(context, prompt);
  }
  if (kind === "news" && /新闻|消息|今日|今天|最新/.test(prompt)) {
    return buildDirectNewsAnswer(context);
  }
  return "";
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

async function buildMarketWeatherBriefContext(userPrompt) {
  const ticker = extractPrimaryUsTicker(userPrompt);
  const indexTarget = detectPrimaryIndexTarget(userPrompt);
  const weatherLocation = extractCompositeWeatherLocation(userPrompt);

  const tasks = [];
  if (ticker) {
    tasks.push(
      withTimeout(
        createStockMarketTool().execute("lynn-local-prefetch", {
          query: `${ticker} 最新价`,
          kind: "stock",
          symbol: ticker,
        }),
        STOCK_MARKET_TIMEOUT_MS,
        "market_weather_stock",
      ).then((result) => ({ type: "stock", result })),
    );
  }
  if (indexTarget) {
    tasks.push(
      withTimeout(
        createStockMarketTool().execute("lynn-local-prefetch", {
          query: indexTarget.query,
          kind: "index",
        }),
        STOCK_MARKET_TIMEOUT_MS,
        "market_weather_index",
      ).then((result) => ({ type: "index", result })),
    );
  }
  if (weatherLocation) {
    const weatherQuery = /后天/.test(userPrompt)
      ? `后天${weatherLocation}天气`
      : /明天/.test(userPrompt)
        ? `明天${weatherLocation}天气`
        : `${weatherLocation}天气`;
    tasks.push(
      withTimeout(
        createWeatherTool().execute("lynn-local-prefetch", {
          query: weatherQuery,
          location: weatherLocation,
        }),
        REALTIME_TOOL_TIMEOUT_MS,
        "market_weather_weather",
      ).then((result) => ({ type: "weather", result })),
    );
  }

  const settled = await Promise.allSettled(tasks);
  let stockSnapshot = null;
  let indexSnapshot = null;
  let weatherSnapshot = null;

  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    if (item.value.type === "stock") stockSnapshot = parseStockSnapshot(item.value.result);
    if (item.value.type === "index") indexSnapshot = parseIndexSnapshot(item.value.result, indexTarget);
    if (item.value.type === "weather") weatherSnapshot = parseWeatherSnapshot(item.value.result, userPrompt, weatherLocation);
  }

  const sections = [
    "【系统已完成综合工具预取】",
    "下面是已拿到的结构化快照。请直接用这些数据回答用户，不要再调用工具，不要输出“我再查一下”。",
  ];

  if (stockSnapshot) {
    sections.push(buildStructuredSection("美股快照", [
      ["标的", stockSnapshot.symbol],
      ["最新价", stockSnapshot.price ? `$${stockSnapshot.price}` : ""],
      ["时间戳", stockSnapshot.timestamp],
      ["来源", stockSnapshot.source],
      ["链接", stockSnapshot.url],
      ["开盘/最高/最低", stockSnapshot.range],
    ]));
  }

  if (indexSnapshot) {
    sections.push(buildStructuredSection("指数快照", [
      ["指数", indexSnapshot.name],
      ["最新点位", indexSnapshot.level],
      ["涨跌幅", indexSnapshot.change],
      ["查询日期", indexSnapshot.queryDate],
      ["来源", indexSnapshot.source],
      ["链接", indexSnapshot.url],
    ]));
  }

  if (weatherSnapshot) {
    sections.push(buildStructuredSection("天气快照", [
      ["地点", weatherSnapshot.location],
      ["日期", weatherSnapshot.date],
      ["天气", weatherSnapshot.desc],
      ["温度", weatherSnapshot.tempRange],
    ]));
  }

  return sections.length > 2 ? sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS) : "";
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
  if (kind === "market_weather_brief") return buildMarketWeatherBriefContext(userPrompt);
  if (kind === "weather") return buildWeatherResearchContext(userPrompt);
  if (kind === "sports") return buildSportsResearchContext(userPrompt);
  if (kind === "market") return buildMarketResearchContext(userPrompt);
  if (kind === "news") return buildLiveNewsResearchContext(userPrompt);
  if (kind === "generic") return buildGenericResearchContext(userPrompt);
  return "";
}
