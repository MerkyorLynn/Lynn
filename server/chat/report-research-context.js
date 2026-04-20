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

const STOCK_COMPANY_RE = /[\u4e00-\u9fa5A-Za-z]{2,18}(?:科技|股份|电子|智能|软件|证券|银行|集团|药业|医药|能源|材料|半导体|光电|电气|通信|汽车|机器人|芯片|电力|股份)/;
const STOCK_ANALYSIS_RE = /(?:股票|股价|个股|A股|a股|科创板|创业板|沪深|标的|走势|怎么看|技术面|基本面|估值|市值|总股本|PE|PB|PS|资金|资金流|财报|研报|公告|解禁|减持|支撑位|压力位|K线|k线|均线|成交量|成交额|筹码|止损|止盈|仓位|目标价|三种情景|操作计划|未来1-3个月)/i;
const GENERIC_RESEARCH_RE = /(?=.*(?:调研|研究|分析|评估|对比|比较|判断|怎么看|报告|预测|整理|汇总))(?=.*(?:最新|数据|资料|来源|公司|行业|市场|政策|公告|财报|研报|楼盘|房价|成交|竞品|价格|估值|市值|PDF|文档|报表|合同|产品|品牌))/i;
const WEATHER_LOOKUP_RE = /(?:天气|气温|温度|预报|冷不冷|热不热|下雨|下雪|多少度|几度|紫外线|空气质量|湿度|风力|体感)/i;
const SPORTS_LOOKUP_RE = /(?:比分|赛程|排名|战绩|湖人|勇士|NBA|CBA|英超|中超|欧冠|世界杯|比赛结果)/i;
const MARKET_LOOKUP_RE = /(?:金价|黄金|白银|油价|原油|汇率|美元|人民币|指数|基金|ETF|etf|股价|股票|行情|收盘|涨跌|现价|最新价|美股|港股|A股|a股|纳指|道指|标普|AAPL|TSLA|NVDA|MSFT|GOOGL|AMZN|META|\$[A-Z]{1,5}\b)/i;
const LIVE_NEWS_LOOKUP_RE = /(?=.*(?:今天|今日|今晚|最新|实时|进展|消息|新闻|报道|发生|了吗|如何|怎么样|快讯|热点))(?=.*(?:AI|人工智能|科技|大模型|模型|Gemini|OpenAI|Anthropic|Claude|芯片|半导体|机器人|美伊|伊朗|美国|中东|巴以|以色列|巴勒斯坦|俄乌|俄罗斯|乌克兰|关税|制裁|冲突|停火|谈判|选举|地震|台风|事故|发布|宣布|外交|战争|袭击|股市|市场|公司|政策))/i;
const EXTERNAL_RESEARCH_INTENT_RE = /(?:最新|实时|今天|今日|联网|搜索|查询|查一下|找一下|资料|来源|链接|官网|网页|公开信息|公告|财报|研报|新闻|政策|PDF|文档|市场数据|行业数据|竞品)/i;
const LOCAL_OFFICE_TASK_RE = /(?:会议记录|会议纪要|行动项|负责人|截止时间|风险|经营分析|环比|增长率|根据数据|下面会议|Q[1-4]|报价模板|客户\s*[A-Z]\b)/i;

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
  const re = /\n\d+\.\s+([A-Z]{1,6})\s+最近可用行情\n来源：([^\n]+)\n(https?:\/\/\S+)\n-\s+价格:\s*([^\n]+)\n-\s+时间戳:\s*([^\n]+)(?:\n-\s+开盘\/最高\/最低:\s*([^\n]+))?/g;
  for (const match of String(context || "").matchAll(re)) {
    items.push({
      symbol: match[1],
      source: match[2],
      url: match[3],
      price: match[4],
      timestamp: match[5],
      range: match[6] || "",
    });
  }
  return items;
}

function buildDirectMarketAnswer(context) {
  const items = parseStooqItems(context);
  if (!items.length) return "";
  const rows = items.map((item) => {
    return [
      `**${item.symbol}**`,
      `- 最新价：$${item.price}`,
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
  if (kind === "market" && /AAPL|TSLA|股价|行情|报价|最新价|最近可用/i.test(prompt)) {
    return buildDirectMarketAnswer(context);
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
