/**
 * stock-market.js — 轻量财经/行情工具
 *
 * 目标：不给用户额外增加 key 配置压力，优先复用 Lynn 现有搜索/抓取链路，
 * 为金价、股价、指数、基金、汇率、原油等常见场景提供结构化可读结果。
 */

import { Type } from "@sinclair/typebox";
import { getLocale, t } from "../../server/i18n.js";
import { runSearchQuery } from "./web-search.js";
import { fetchWebContent } from "./web-fetch.js";

const DEFAULT_FETCH_COUNT = 2;
const GOLD_FETCH_COUNT = 8;
const MAX_FETCH_LENGTH = 3600;
const MAX_LINES_PER_SOURCE = 4;
const STOOQ_TIMEOUT_MS = 6500;

const US_STOCK_NAME_TO_SYMBOL = new Map([
  ["苹果", "AAPL"],
  ["apple", "AAPL"],
  ["特斯拉", "TSLA"],
  ["tesla", "TSLA"],
  ["英伟达", "NVDA"],
  ["辉达", "NVDA"],
  ["nvidia", "NVDA"],
  ["微软", "MSFT"],
  ["microsoft", "MSFT"],
  ["谷歌", "GOOGL"],
  ["alphabet", "GOOGL"],
  ["亚马逊", "AMZN"],
  ["amazon", "AMZN"],
  ["meta", "META"],
  ["脸书", "META"],
]);

const HK_STOCK_NAME_TO_SYMBOL = new Map([
  ["腾讯控股", "00700"],
  ["腾讯", "00700"],
  ["阿里巴巴", "09988"],
  ["阿里", "09988"],
  ["美团", "03690"],
  ["小米集团", "01810"],
  ["小米", "01810"],
  ["快手", "01024"],
  ["京东集团", "09618"],
  ["京东", "09618"],
]);

const TICKER_STOPWORDS = new Set([
  "AI", "API", "ETF", "ETFS", "USD", "CNY", "EUR", "GBP", "JPY",
  "PE", "PB", "PS", "IPO", "CEO", "CFO", "GDP", "CPI", "PPI",
  "MACD", "RSI", "US", "CN", "HK",
]);

const KNOWN_US_STOCK_SYMBOLS = new Set([...US_STOCK_NAME_TO_SYMBOL.values()]);

const FINANCE_LOOKUP_CONTEXT_RE =
  /(?:股票|股价|行情|最新价|现价|收盘|开盘|涨跌|成交|市值|美股|港股|A股|a股|纳斯达克|纽交所|道指|标普|纳指|ticker|symbol|stock|share|price|quote|market|nasdaq|nyse)/i;
const NON_FINANCE_QUOTE_CONTEXT_RE =
  /(?:报价模板|报价单|销售报价|客户报价|统一报价|报价流程|方案报价|采购报价|合同报价|客户\s*[A-Z]\b|会议记录|会议纪要|行动项|负责人|截止时间)/i;

function isZhLocale() {
  return String(getLocale?.() || "").startsWith("zh");
}

function detectKind(query, explicitKind = "") {
  const forced = String(explicitKind || "").trim().toLowerCase();
  if (forced) return forced;
  const text = String(query || "").toLowerCase();
  if (/(?:金价|黄金|白银|\bau\b|\bxau\b|\bgold\b|\bsilver\b)/i.test(text)) return "gold";
  if (/(?:汇率|美元|人民币|日元|欧元|英镑|\bfx\b|\busd\b|\bcny\b|\beur\b|\bgbp\b|\bjpy\b)/i.test(text)) return "fx";
  if (/(?:原油|油价|布伦特|\bwti\b|\bcrude\b|\boil\b)/i.test(text)) return "oil";
  if (/(?:基金|净值|\betf\b|\blof\b|\bfof\b)/i.test(text)) return "fund";
  if (/(?:指数|上证|深证|创业板|恒生|纳指|道指|标普|\bindex\b)/i.test(text)) return "index";
  return "stock";
}

function buildQuery(query, kind, market = "", symbol = "") {
  const raw = String(query || "").trim();
  const marketText = String(market || "").trim();
  const symbolText = String(symbol || "").trim();
  const suffix = [];
  if (symbolText) suffix.push(symbolText);
  if (marketText) suffix.push(marketText);

  if (kind === "gold") {
    suffix.push("国际金价 上海黄金交易所 腾讯自选股 新浪财经");
  } else if (kind === "index") {
    suffix.push("指数 行情 腾讯自选股 新浪财经 东方财富");
  } else if (kind === "fund") {
    suffix.push("基金 净值 天天基金 新浪财经");
  } else if (kind === "fx") {
    suffix.push("汇率 行情 新浪财经 Investing");
  } else if (kind === "oil") {
    suffix.push("原油 行情 新浪财经 Investing");
  } else {
    suffix.push("股票 行情 腾讯自选股 新浪财经 东方财富");
  }

  return [raw, ...suffix].filter(Boolean).join(" ");
}

function keywordScore(kind, line) {
  const text = String(line || "");
  let score = 0;
  if (/\d/.test(text)) score += 2;
  if (/涨|跌|涨跌|涨幅|跌幅|最新|现价|报价|收盘|开盘|美元|元\/克|盎司|点|%/.test(text)) score += 2;
  if (kind === "gold" && /(金价|黄金|白银|au|xau|伦敦金|沪金)/i.test(text)) score += 4;
  if (kind === "index" && /(指数|上证|深证|创业板|恒生|纳指|道指|标普)/i.test(text)) score += 4;
  if (kind === "fund" && /(基金|净值|估值|涨跌幅)/i.test(text)) score += 4;
  if (kind === "fx" && /(汇率|美元|人民币|日元|欧元|英镑|usd|cny|eur|gbp|jpy)/i.test(text)) score += 4;
  if (kind === "oil" && /(原油|布伦特|wti|油价)/i.test(text)) score += 4;
  if (kind === "stock" && /(股票|股价|港股|美股|a股|最新价|成交额|成交量)/i.test(text)) score += 4;
  return score;
}

function normalizeLine(line) {
  return String(line || "")
    .replace(/\s+/g, " ")
    .replace(/[|│┃]/g, " ")
    .trim();
}

function toFiniteNumber(value) {
  const n = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function formatPrice(value, digits = 2) {
  const n = toFiniteNumber(value);
  if (!Number.isFinite(n)) return "";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

function extractSection(text, startRe, endReList = []) {
  const source = String(text || "");
  const startMatch = startRe.exec(source);
  if (!startMatch) return "";
  const start = startMatch.index + startMatch[0].length;
  const tail = source.slice(start);
  let end = tail.length;
  for (const re of endReList) {
    const match = re.exec(tail);
    if (match && match.index < end) end = match.index;
  }
  return tail.slice(0, end);
}

function dedupeByName(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item?.name || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeStrings(items = []) {
  const seen = new Set();
  return items
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function summarizeRange(items = []) {
  const priced = items
    .map((item) => ({ ...item, numericPrice: toFiniteNumber(item.price) }))
    .filter((item) => Number.isFinite(item.numericPrice));
  if (!priced.length) return null;
  const sorted = [...priced].sort((a, b) => a.numericPrice - b.numericPrice);
  return {
    min: sorted[0].numericPrice,
    minName: sorted[0].name,
    max: sorted[sorted.length - 1].numericPrice,
    maxName: sorted[sorted.length - 1].name,
  };
}

function numberInRange(value, min, max) {
  const n = toFiniteNumber(value);
  return Number.isFinite(n) && n >= min && n <= max;
}

function normalizeDateToken(token = "") {
  const raw = String(token || "").trim();
  const match = raw.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) return "";
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function normalizeSgeName(raw = "") {
  const text = String(raw || "").toUpperCase();
  if (text.includes("100G")) return "Au100g";
  if (text.includes("9995")) return "Au9995";
  if (text.includes("9999")) return "Au9999";
  if (text.includes("99.99")) return "Au99.99";
  return "Au99.99";
}

function hasGoldEvidence(signals) {
  return Boolean(
    signals?.sgeLines?.length
    || signals?.shuibeiLines?.length
    || signals?.internationalLines?.length
    || signals?.jewelry?.length
    || signals?.bars?.length
    || signals?.recovery?.length,
  );
}

function hasPriorityGoldEvidence(signals) {
  return Boolean(
    signals?.sgeLines?.length
    || signals?.shuibeiLines?.length,
  );
}

function countPriorityGoldEvidence(signals) {
  let count = 0;
  if (signals?.sgeLines?.length) count += 1;
  if (signals?.shuibeiLines?.length) count += 1;
  return count;
}

function mergeGoldSignals(sources = []) {
  const merged = {
    jewelry: [],
    jewelryRange: null,
    bars: [],
    barRange: null,
    recovery: [],
    goldRecovery: null,
    date: "",
    sgeLines: [],
    shuibeiLines: [],
    internationalLines: [],
  };

  for (const source of sources) {
    const signals = source?.goldSignals;
    if (!signals) continue;
    if (!merged.date && signals.date) merged.date = signals.date;
    merged.jewelry.push(...(signals.jewelry || []));
    merged.bars.push(...(signals.bars || []));
    merged.recovery.push(...(signals.recovery || []));
    merged.sgeLines.push(...(signals.sgeLines || []));
    merged.shuibeiLines.push(...(signals.shuibeiLines || []));
    merged.internationalLines.push(...(signals.internationalLines || []));
  }

  merged.jewelry = dedupeByName(merged.jewelry);
  merged.bars = dedupeByName(merged.bars);
  merged.recovery = dedupeByName(merged.recovery);
  merged.sgeLines = dedupeStrings(merged.sgeLines);
  merged.shuibeiLines = dedupeStrings(merged.shuibeiLines);
  merged.internationalLines = dedupeStrings(merged.internationalLines);
  merged.jewelryRange = summarizeRange(merged.jewelry);
  merged.barRange = summarizeRange(merged.bars);
  merged.goldRecovery = merged.recovery.find((item) => /黄金回收/.test(item.name)) || merged.recovery[0] || null;

  return merged;
}

function extractGoldSignals(text) {
  const source = String(text || "");
  if (!source) return null;

  const date = normalizeDateToken(source.match(/\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/)?.[0] || "");

  const jewelrySection = extractSection(
    source,
    /各品牌黄金首饰金店报价/,
    [/实物黄金定价依据/, /银行投资金条价格/, /今日黄金回收价格/],
  );
  const bankSection = extractSection(
    source,
    /银行投资金条价格/,
    [/今日黄金回收价格/, /实物黄金定价依据/],
  );
  const recoverySection = extractSection(
    source,
    /今日黄金回收价格/,
    [/实物黄金定价依据/, /登录\/注册/, /©/],
  );

  const jewelry = dedupeByName(Array.from(jewelrySection.matchAll(
    /([^\s/()]{2,20}(?:黄金|珠宝|凤祥|周生生|周六福|潮宏基|至尊))(?:\s+\([^)]+\))?\s+(\d+(?:\.\d+)?)\s+(?:\d+(?:\.\d+)?|-)\s+(?:\d+(?:\.\d+)?|-)\s+元\/克\s+(\d{4}-\d{2}-\d{2})/g,
  )).map((match) => ({
    name: match[1],
    price: match[2],
    date: match[3],
  })));

  const bars = dedupeByName(Array.from(bankSection.matchAll(
    /([^\s/()]{2,30}金条)(?:\s+\([^)]+\))?\s+(\d+(?:\.\d+)?)/g,
  )).map((match) => ({
    name: match[1],
    price: match[2],
  })));

  const recovery = dedupeByName(Array.from(recoverySection.matchAll(
    /([^\s/()]{2,24}回收)(?:\s+\([^)]+\))?\s+(\d+(?:\.\d+)?)\s+元\/克(?:\s+(\d{4}-\d{2}-\d{2}))?/g,
  )).map((match) => ({
    name: match[1],
    price: match[2],
    date: match[3] || "",
  })));

  const sgeLines = dedupeStrings([
    ...Array.from(source.matchAll(
      /(?:上海黄金交易所|上金所)[^\n]{0,40}?(Au?99\.99|Au?9999|Au100g|黄金9999|黄金9995)[^\n]{0,40}?(\d{3,5}(?:\.\d+)?)(?:\s*元\/克)?/gi,
    )).map((match) => {
      const price = match[2];
      if (!numberInRange(price, 300, 3000)) return "";
      return `上海黄金交易所 ${normalizeSgeName(match[1] || "")} ${formatPrice(price)} 元/克`;
    }),
    ...Array.from(source.matchAll(
      /(^|\n)\s*(Au?99\.99|Au?9999|Au100g|黄金9999|黄金9995)\s*[：: ]\s*(\d{3,5}(?:\.\d+)?)(?:\s*元\/克)?/gim,
    )).map((match) => {
      const price = match[3];
      if (!numberInRange(price, 300, 3000)) return "";
      return `上海黄金交易所 ${normalizeSgeName(match[2] || "")} ${formatPrice(price)} 元/克`;
    }),
  ]);

  const shuibeiLines = dedupeStrings([
    ...Array.from(source.matchAll(
      /(?:深圳)?水贝(?:黄金|金价|批发价)?[^\n]{0,30}?(?:(\d{3,5}(?:\.\d+)?)\s*[-~—至到]\s*(\d{3,5}(?:\.\d+)?)(?:\s*元\/克)?|(\d{3,5}(?:\.\d+)?)(?:\s*元\/克)?)/gi,
    )).map((match) => {
      const min = match[1];
      const max = match[2];
      const single = match[3];
      if (numberInRange(min, 300, 1600) && numberInRange(max, 300, 1600)) {
        return `深圳水贝黄金 ${formatPrice(min)}-${formatPrice(max)} 元/克`;
      }
      if (numberInRange(single, 300, 1600)) {
        return `深圳水贝黄金 ${formatPrice(single)} 元/克`;
      }
      return "";
    }),
    ...Array.from(source.matchAll(
      /(?:深圳)?水贝今日金价[\s\S]{0,260}?黄金[^\d]{0,20}(\d{3,5}(?:\.\d+)?)\s*元\/克/gi,
    )).map((match) => {
      const price = match[1];
      if (!numberInRange(price, 300, 1600)) return "";
      return `深圳水贝黄金 ${formatPrice(price)} 元/克`;
    }),
    ...Array.from(source.matchAll(
      /水贝金价网[\s\S]{0,260}?水贝[^\d]{0,20}(\d{3,5}(?:\.\d+)?)\s*元\/克/gi,
    )).map((match) => {
      const price = match[1];
      if (!numberInRange(price, 300, 1600)) return "";
      return `深圳水贝黄金 ${formatPrice(price)} 元/克`;
    }),
  ]);

  const internationalLines = dedupeStrings(Array.from(source.matchAll(
    /(?:XAU\/USD|国际现货黄金|现货黄金|伦敦金|COMEX黄金)[^\n]{0,40}?(\d{4}(?:\.\d+)?)(?:\s*(?:美元\/盎司|USD\/oz|usd\/oz|盎司))?/gi,
  )).map((match) => {
    const price = match[1];
    if (!numberInRange(price, 1000, 5000)) return "";
    return `国际现货黄金（XAU/USD） ${formatPrice(price)} 美元/盎司`;
  }));

  if (!jewelry.length && !bars.length && !recovery.length && !sgeLines.length && !shuibeiLines.length && !internationalLines.length) return null;

  const jewelryRange = summarizeRange(jewelry);
  const barRange = summarizeRange(bars);
  const goldRecovery = recovery.find((item) => /黄金回收/.test(item.name)) || recovery[0] || null;
  const dated = jewelry.find((item) => item.date)?.date
    || recovery.find((item) => item.date)?.date
    || date;

  return {
    jewelry,
    jewelryRange,
    bars,
    barRange,
    recovery,
    goldRecovery,
    date: dated,
    sgeLines,
    shuibeiLines,
    internationalLines,
  };
}

function buildGoldSummary(sources = []) {
  const signals = mergeGoldSignals(sources);
  if (!hasGoldEvidence(signals)) return "";

  const lines = [];
  const dateLine = signals.date ? `可核验到的黄金价格（${signals.date}）：` : "可核验到的黄金价格：";
  lines.push(dateLine);

  for (const line of signals.sgeLines.slice(0, 2)) {
    lines.push(`- ${line}`);
  }
  if (signals.shuibeiLines.length) {
    lines.push(`- ${signals.shuibeiLines[0]}`);
  }
  if (signals.internationalLines.length) {
    lines.push(`- ${signals.internationalLines[0]}`);
  }
  if (signals.jewelryRange) {
    lines.push(
      `- 品牌金店首饰金价：${formatPrice(signals.jewelryRange.min)}-${formatPrice(signals.jewelryRange.max)} 元/克（${signals.jewelryRange.minName} ~ ${signals.jewelryRange.maxName}）`,
    );
  }
  if (signals.barRange) {
    lines.push(
      `- 银行投资金条：${formatPrice(signals.barRange.min)}-${formatPrice(signals.barRange.max)} 元/克（${signals.barRange.minName} ~ ${signals.barRange.maxName}）`,
    );
  }
  if (signals.goldRecovery) {
    lines.push(`- 黄金回收：约 ${formatPrice(signals.goldRecovery.price)} 元/克`);
  }
  const examples = signals.jewelry.slice(0, 4).map((item) => `${item.name} ${formatPrice(item.price)}`);
  if (examples.length) {
    lines.push(`- 示例品牌：${examples.join("，")} 元/克`);
  }
  return lines.join("\n");
}

async function fetchJsonWithTimeout(url, ms, headers = {}) {
  const timer = timeoutSignal(ms);
  try {
    const resp = await fetch(url, {
      signal: timer.signal,
      headers: { "User-Agent": "Lynn/MarketQuote", ...headers },
    });
    if (!resp.ok) throw new Error(`${url} ${resp.status}`);
    return await resp.json();
  } finally {
    timer.clear();
  }
}

async function fetchTextWithTimeout(url, ms, headers = {}, encoding = "utf-8") {
  const timer = timeoutSignal(ms);
  try {
    const resp = await fetch(url, {
      signal: timer.signal,
      headers: { "User-Agent": "Lynn/MarketQuote", ...headers },
    });
    if (!resp.ok) throw new Error(`${url} ${resp.status}`);
    if (encoding && encoding.toLowerCase() !== "utf-8") {
      const bytes = await resp.arrayBuffer();
      return new TextDecoder(encoding).decode(bytes);
    }
    return await resp.text();
  } finally {
    timer.clear();
  }
}

async function fetchUsdCnyRate() {
  const json = await fetchJsonWithTimeout("https://open.er-api.com/v6/latest/USD", 4500);
  const rate = Number(json?.rates?.CNY);
  if (!Number.isFinite(rate)) throw new Error("USD/CNY unavailable");
  return {
    rate,
    updatedAt: json.time_last_update_utc || "",
    source: "open.er-api.com",
  };
}

async function fetchGoldApiMarketSource() {
  const [gold, silver, fx] = await Promise.all([
    fetchJsonWithTimeout("https://api.gold-api.com/price/XAU", 4500),
    fetchJsonWithTimeout("https://api.gold-api.com/price/XAG", 4500).catch(() => null),
    fetchUsdCnyRate(),
  ]);
  const goldUsdOz = Number(gold?.price);
  if (!Number.isFinite(goldUsdOz)) return null;
  const goldCnyGram = goldUsdOz * fx.rate / 31.1034768;
  const lines = [
    `国际现货黄金（XAU/USD） ${formatPrice(goldCnyGram)} 元/克（约 ${formatPrice(goldUsdOz)} 美元/盎司，USD/CNY ${fx.rate.toFixed(4)}）`,
    gold?.updatedAt ? `更新时间：${gold.updatedAt}` : "",
  ].filter(Boolean);
  if (silver?.price) {
    const silverCnyGram = Number(silver.price) * fx.rate / 31.1034768;
    if (Number.isFinite(silverCnyGram)) {
      lines.push(`国际现货白银（XAG/USD） ${formatPrice(silverCnyGram)} 元/克（约 ${formatPrice(silver.price)} 美元/盎司）`);
    }
  }
  return {
    title: "Gold API 实时贵金属报价",
    url: "https://api.gold-api.com/price/XAU",
    snippet: lines.join("；"),
    lines,
    goldSignals: {
      jewelry: [],
      jewelryRange: null,
      bars: [],
      barRange: null,
      recovery: [],
      goldRecovery: null,
      date: normalizeDateToken(gold?.updatedAt || "") || normalizeDateToken(new Date().toISOString()),
      sgeLines: [],
      shuibeiLines: [],
      internationalLines: [lines[0]],
    },
    source: "gold-api.com",
    host: "api.gold-api.com",
  };
}

function buildGoldQueries(query, market = "", symbol = "") {
  const raw = String(query || "").trim();
  return [...new Set([
    buildQuery(query, "gold", market, symbol),
    `${raw} 上海黄金交易所 Au99.99 Au9999 今日行情`,
    `${raw} 深圳水贝黄金 今日价格 批发价`,
    `${raw} XAU/USD 国际现货黄金 今日价格`,
  ].filter(Boolean))];
}

function parseSinaFuturesQuote(raw, fallbackSymbol = "") {
  const match = String(raw || "").match(/=\"([^\"]*)\"/);
  const parts = (match?.[1] || "").split(",");
  const price = toFiniteNumber(parts[0]);
  if (!Number.isFinite(price)) return null;
  const prev = toFiniteNumber(parts[7]);
  const change = Number.isFinite(prev) ? price - prev : null;
  const pct = Number.isFinite(change) && prev ? `${change >= 0 ? "+" : ""}${((change / prev) * 100).toFixed(2)}%` : "";
  return {
    symbol: fallbackSymbol,
    name: parts[13] || fallbackSymbol,
    price: formatPrice(price, 3),
    high: formatPrice(parts[4], 3),
    low: formatPrice(parts[5], 3),
    time: [parts[12], parts[6]].filter(Boolean).join(" "),
    previous: Number.isFinite(prev) ? formatPrice(prev, 3) : "",
    change: Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${formatPrice(change, 3)}` : "",
    pct,
  };
}

async function fetchSinaFuturesQuote(symbol) {
  const raw = await fetchTextWithTimeout(`https://hq.sinajs.cn/list=${symbol}`, 4500, {
    Referer: "https://finance.sina.com.cn/",
  }, "gbk");
  return parseSinaFuturesQuote(raw, symbol);
}

async function collectOilDirectQuotes(query) {
  const text = String(query || "");
  const targets = [];
  if (/布伦特|brent|oil/i.test(text)) targets.push("hf_OIL");
  if (/WTI|纽约原油|美油|crude|CL\b/i.test(text)) targets.push("hf_CL");
  if (!targets.length) targets.push("hf_OIL");
  const settled = await Promise.allSettled([...new Set(targets)].map(fetchSinaFuturesQuote));
  return settled.map((item) => item.status === "fulfilled" ? item.value : null).filter(Boolean);
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < String(line || "").length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function hasFinanceLookupIntent(query, explicitSymbol = "") {
  const text = String(query || "");
  if (String(explicitSymbol || "").trim()) return true;
  if (NON_FINANCE_QUOTE_CONTEXT_RE.test(text) && !FINANCE_LOOKUP_CONTEXT_RE.test(text)) return false;
  if (FINANCE_LOOKUP_CONTEXT_RE.test(text)) return true;
  if (/\$[A-Z]{1,5}(?:\.[A-Z]{1,3})?\b/.test(text)) return true;
  for (const [name, symbol] of US_STOCK_NAME_TO_SYMBOL) {
    if (text.toLowerCase().includes(name.toLowerCase())) return true;
    if (new RegExp(`\\b${symbol}\\b`, "i").test(text)) return true;
  }
  return false;
}

function extractUsStockSymbols(query, explicitSymbol = "") {
  const symbols = [];
  const text = String(query || "");
  const financeContext = hasFinanceLookupIntent(text, explicitSymbol);
  const add = (value, { explicit = false, dollar = false, known = false } = {}) => {
    const normalized = String(value || "").trim().toUpperCase().replace(/^\$/, "");
    if (!/^[A-Z]{1,5}(?:\.[A-Z]{1,3})?$/.test(normalized)) return;
    const bare = normalized.split(".")[0];
    if (TICKER_STOPWORDS.has(bare)) return;
    if (!explicit && !dollar && !known && !financeContext) return;
    if (bare.length === 1 && !explicit && !dollar) return;
    if (!symbols.includes(bare)) symbols.push(bare);
  };

  add(explicitSymbol, { explicit: true });
  for (const [name, symbol] of US_STOCK_NAME_TO_SYMBOL) {
    if (text.toLowerCase().includes(name.toLowerCase())) add(symbol, { known: true });
  }
  for (const match of text.matchAll(/\$?\b([A-Z]{1,5})(?:\.[A-Z]{1,3})?\b/g)) {
    const raw = match[0] || "";
    const bare = (match[1] || "").toUpperCase();
    add(bare, { dollar: raw.startsWith("$"), known: KNOWN_US_STOCK_SYMBOLS.has(bare) });
  }
  return symbols.slice(0, 6);
}

async function fetchStooqQuote(symbol) {
  const bare = String(symbol || "").trim().toUpperCase().replace(/^\$/, "").split(".")[0];
  if (!bare) return null;
  const timer = timeoutSignal(STOOQ_TIMEOUT_MS);
  try {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(`${bare}.us`.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
    const resp = await fetch(url, {
      signal: timer.signal,
      headers: { "User-Agent": "Lynn/MarketQuote" },
    });
    if (!resp.ok) throw new Error(`Stooq ${resp.status}`);
    const csv = await resp.text();
    const [headerLine, dataLine] = csv.trim().split(/\r?\n/);
    const headers = parseCsvLine(headerLine);
    const values = parseCsvLine(dataLine);
    const row = Object.fromEntries(headers.map((key, index) => [key, values[index] || ""]));
    if (!row.Symbol || row.Close === "N/D" || !Number.isFinite(Number(row.Close))) return null;
    return {
      symbol: bare,
      stooqSymbol: row.Symbol,
      date: row.Date || "",
      time: row.Time || "",
      open: row.Open || "",
      high: row.High || "",
      low: row.Low || "",
      close: row.Close || "",
      volume: row.Volume || "",
      source: "Stooq",
      url: `https://stooq.com/q/?s=${encodeURIComponent(`${bare}.us`.toLowerCase())}`,
      currency: "USD",
    };
  } finally {
    timer.clear();
  }
}

async function collectStooqQuotes(query, explicitSymbol = "") {
  const symbols = extractUsStockSymbols(query, explicitSymbol);
  if (!symbols.length) return [];
  const settled = await Promise.allSettled(symbols.map((symbol) => fetchStooqQuote(symbol)));
  return settled
    .map((item) => item.status === "fulfilled" ? item.value : null)
    .filter(Boolean);
}

function extractHongKongStockSymbols(query, explicitSymbol = "") {
  const symbols = [];
  const text = String(query || "");
  const add = (value) => {
    const raw = String(value || "").trim().toUpperCase();
    const match = raw.match(/^(\d{4,5})(?:\.HK)?$/);
    if (!match) return;
    const symbol = match[1].padStart(5, "0");
    if (!symbols.includes(symbol)) symbols.push(symbol);
  };

  add(explicitSymbol);
  for (const [name, symbol] of HK_STOCK_NAME_TO_SYMBOL) {
    if (text.includes(name)) add(symbol);
  }
  for (const match of text.matchAll(/\b(\d{4,5})\.HK\b/gi)) {
    add(match[1]);
  }
  return symbols.slice(0, 4);
}

function parseSinaHongKongQuote(raw, requestedSymbol) {
  const match = String(raw || "").match(/=\"([^\"]*)\"/);
  const fields = match?.[1]?.split(",") || [];
  if (fields.length < 18) return null;
  const price = fields[6];
  if (!Number.isFinite(Number(price))) return null;
  const symbol = String(requestedSymbol || "").padStart(5, "0");
  const amount = fields[11] || "";
  const volume = fields[12] || "";
  return {
    symbol: `${symbol}.HK`,
    name: fields[1] || fields[0] || `${symbol}.HK`,
    date: fields[17] || "",
    time: fields[18] || "",
    open: fields[3] || "",
    high: fields[4] || "",
    low: fields[5] || "",
    close: price,
    previousClose: fields[2] || "",
    change: fields[7] || "",
    pct: fields[8] ? `${fields[8]}%` : "",
    amount,
    volume,
    source: "新浪财经",
    url: `https://finance.sina.com.cn/stock/hkstock/quotes/${symbol}.html`,
    currency: "HKD",
  };
}

async function fetchSinaHongKongQuote(symbol) {
  const normalized = String(symbol || "").trim().padStart(5, "0");
  if (!/^\d{5}$/.test(normalized)) return null;
  const raw = await fetchTextWithTimeout(`https://hq.sinajs.cn/list=rt_hk${normalized}`, 4500, {
    Referer: "https://finance.sina.com.cn",
    "User-Agent": "Mozilla/5.0 Lynn/MarketQuote",
  }, "gbk");
  return parseSinaHongKongQuote(raw, normalized);
}

async function collectHongKongQuotes(query, explicitSymbol = "") {
  const symbols = extractHongKongStockSymbols(query, explicitSymbol);
  if (!symbols.length) return [];
  const settled = await Promise.allSettled(symbols.map((symbol) => fetchSinaHongKongQuote(symbol)));
  return settled
    .map((item) => item.status === "fulfilled" ? item.value : null)
    .filter(Boolean);
}

function extractCandidateLines(text, kind) {
  const seen = new Set();
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean)
    .filter((line) => line.length <= 220)
    .map((line) => ({ line, score: keywordScore(kind, line) }))
    .filter((item) => item.score >= 4)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.line)
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });
  return lines.slice(0, MAX_LINES_PER_SOURCE);
}

function sourceLabel(url) {
  try {
    const host = new URL(String(url || "")).hostname.replace(/^www\./i, "");
    if (host.includes("finance.sina.com.cn") || host.includes("sina.com.cn")) return "新浪财经";
    if (host.includes("qq.com")) return "腾讯";
    if (host.includes("xueqiu.com")) return "雪球";
    if (host.includes("eastmoney.com")) return "东方财富";
    if (host.includes("10jqka.com.cn")) return "同花顺";
    if (host.includes("akshare")) return "AkShare";
    if (host.includes("jrj.com.cn")) return "金融界";
    if (host.includes("cs.com.cn")) return "中证网";
    return host;
  } catch {
    return "";
  }
}

function buildSnapshotText(query, kind, provider, sources, directQuotes = []) {
  const goldSummary = kind === "gold" ? buildGoldSummary(sources) : "";
  if (kind === "gold" && goldSummary) {
    const refs = sources.slice(0, 3).map((item, idx) => {
      return `${idx + 1}. ${item.title || item.source || item.url}\n${item.url}`;
    }).join("\n");
    return [
      `黄金价格快照（via ${provider}）`,
      `查询：${query}`,
      "",
      goldSummary,
      "",
      "参考来源：",
      refs || "- 暂无可展示来源",
      "",
      "说明：以上是刚检索到的网页报价汇总，不同品牌门店、工费和地区会有差异，不构成投资建议。",
    ].join("\n");
  }
  const zh = isZhLocale();
  const header = zh
    ? [
        `财经/行情快照（via ${provider}）`,
        `查询：${query}`,
        `类型：${kind}`,
        "说明：以下结果来自网页搜索与正文抓取汇总，关键价格、涨跌幅与时间点建议至少交叉验证 2 个来源。",
      ].join("\n")
    : [
        `Market snapshot (via ${provider})`,
        `Query: ${query}`,
        `Type: ${kind}`,
        "Note: results are aggregated from web search plus page extraction. Cross-check key prices, changes, and timestamps across at least two sources.",
      ].join("\n");

  const quoteBody = directQuotes.length
    ? directQuotes.map((item, idx) => {
      const timestamp = [item.date, item.time].filter(Boolean).join(" ");
      const priceText = [item.close, item.currency].filter(Boolean).join(" ");
      const changeText = [item.change, item.pct].filter(Boolean).join(" / ");
      return [
        `${idx + 1}. ${item.symbol} 最近可用行情`,
        zh ? `来源：${item.source}` : `Source: ${item.source}`,
        item.url,
        item.name ? `- ${zh ? "名称" : "Name"}: ${item.name}` : "",
        `- ${zh ? "价格" : "Close"}: ${priceText || item.close}`,
        changeText ? `- ${zh ? "涨跌/涨跌幅" : "Change/Percent"}: ${changeText}` : "",
        timestamp ? `- ${zh ? "时间戳" : "Timestamp"}: ${timestamp}` : "",
        item.open ? `- ${zh ? "开盘/最高/最低" : "Open/High/Low"}: ${item.open} / ${item.high || "?"} / ${item.low || "?"}` : "",
      ].filter(Boolean).join("\n");
    }).join("\n\n")
    : "";

  const webBody = sources.map((item, idx) => {
    const displayIndex = idx + 1 + directQuotes.length;
    const lines = item.lines?.length
      ? item.lines.map((line) => `- ${line}`).join("\n")
      : `- ${item.snippet || (zh ? "未提取到清晰行情行，建议继续深读该来源。" : "No clear market line extracted; consider reading this source in depth.")}`;
    return [
      `${displayIndex}. ${item.title || item.source || item.url}`,
      zh ? `来源：${item.source || item.host}` : `Source: ${item.source || item.host}`,
      item.url,
      lines,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  const tail = zh
    ? "\n\n后续建议：以上属于最近可用行情/网页汇总，不构成投资建议；盘中或高频交易场景请继续交叉核验交易所、券商或专门行情源。"
    : "\n\nSuggested next step: use web_fetch on the most relevant source for more detail, or connect a dedicated finance data source for stricter real-time quotes.";

  const body = [goldSummary, quoteBody, webBody].filter(Boolean).join("\n\n");
  return `${header}\n\n${body}${tail}`;
}

async function collectMarketSources(query, kind, market, symbol) {
  const directQuotes = kind === "stock"
    ? [
        ...await collectHongKongQuotes(query, symbol).catch(() => []),
        ...await collectStooqQuotes(query, symbol).catch(() => []),
      ]
    : [];
  if (directQuotes.length) {
    return {
      provider: directQuotes[0]?.source || "direct_quote",
      plan: { scene: "finance" },
      sources: [],
      directQuotes,
    };
  }

  const picked = [];
  if (kind === "gold") {
    const goldApiSource = await fetchGoldApiMarketSource().catch(() => null);
    if (goldApiSource) picked.push(goldApiSource);
  }
  if (kind === "oil") {
    const oilQuotes = await collectOilDirectQuotes(query).catch(() => []);
    for (const quote of oilQuotes) {
      picked.push({
        title: `${quote.name} 实时行情`,
        url: `https://finance.sina.com.cn/futures/quotes/${quote.symbol.replace(/^hf_/, "")}.shtml`,
        snippet: `${quote.name} ${quote.price}`,
        lines: [
          `${quote.name}：${quote.price} 美元/桶${quote.pct ? `，涨跌幅 ${quote.pct}` : ""}${quote.change ? `，涨跌 ${quote.change}` : ""}`,
          quote.time ? `时间：${quote.time}` : "",
          quote.high && quote.low ? `日内高/低：${quote.high} / ${quote.low}` : "",
          quote.previous ? `前收：${quote.previous}` : "",
        ].filter(Boolean),
        goldSignals: null,
        source: "新浪财经",
        host: "hq.sinajs.cn",
      });
    }
  }
  const searchQueries = kind === "gold"
    ? buildGoldQueries(query, market, symbol)
    : [buildQuery(query, kind, market, symbol)];
  const seenUrls = new Set();
  let provider = "";
  let plan = null;
  let lastError = null;
  const fetchLimit = kind === "gold" ? GOLD_FETCH_COUNT : DEFAULT_FETCH_COUNT;

  for (const searchQuery of searchQueries) {
    let results = [];
    try {
      const searchResult = await runSearchQuery(searchQuery, 5, { sceneHint: "finance" });
      results = searchResult.results || [];
      if (!provider) provider = searchResult.provider || "";
      if (!plan) plan = searchResult.plan || null;
    } catch (err) {
      lastError = err;
      continue;
    }

    for (const result of results.slice(0, kind === "gold" ? 2 : 3)) {
      if (!result?.url || seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);

      let fetchedText = "";
      try {
        const fetched = await fetchWebContent(result.url, MAX_FETCH_LENGTH);
        fetchedText = fetched.text || "";
      } catch {
        // fallback to snippet only
      }
      const lines = extractCandidateLines(fetchedText || result.snippet || "", kind);
      picked.push({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        lines,
        goldSignals: kind === "gold" ? extractGoldSignals(fetchedText || result.snippet || "") : null,
        source: sourceLabel(result.url),
        host: (() => {
          try { return new URL(result.url).hostname; } catch { return ""; }
        })(),
      });

      if (kind !== "gold" && picked.length >= fetchLimit) break;
      if (kind === "gold" && picked.length >= 2 && countPriorityGoldEvidence(mergeGoldSignals(picked)) >= 2) break;
      if (picked.length >= fetchLimit) break;
    }

    if (kind !== "gold" && picked.length >= fetchLimit) break;
    if (kind === "gold" && picked.length >= 2 && countPriorityGoldEvidence(mergeGoldSignals(picked)) >= 2) break;
    if (picked.length >= fetchLimit) break;
  }

  if (!picked.length && lastError) {
    throw lastError;
  }

  return {
    provider,
    plan,
    sources: picked,
    directQuotes,
  };
}

export function createStockMarketTool() {
  return {
    name: "stock_market",
    label: t("toolDef.stockMarket.label"),
    description: t("toolDef.stockMarket.description"),
    parameters: Type.Object({
      query: Type.String({ description: t("toolDef.stockMarket.queryDesc") }),
      kind: Type.Optional(Type.String({ description: t("toolDef.stockMarket.kindDesc") })),
      market: Type.Optional(Type.String({ description: t("toolDef.stockMarket.marketDesc") })),
      symbol: Type.Optional(Type.String({
        description: t("toolDef.stockMarket.symbolDesc"),
        pattern: "^(?:[A-Z]{2,5}|[0-9]{6})$",
      })),
    }),
    execute: async (_toolCallId, params) => {
      const query = String(params.query || "").trim();
      if (!query) {
        return {
          content: [{ type: "text", text: isZhLocale() ? "请输入要查询的行情问题。" : "Please provide a market query." }],
          details: {},
        };
      }

      const kind = detectKind(query, params.kind);
      if (kind === "stock" && !hasFinanceLookupIntent(query, params.symbol)) {
        return {
          content: [{
            type: "text",
            text: isZhLocale()
              ? "未检测到明确的股票/行情查询意图。不要把会议里的“客户 A”、季度标记 Q1/Q2 或“报价模板”当作股票代码；请直接按用户原始办公任务整理、计算或写作。"
              : "No clear stock or market-quote intent was detected. Do not treat meeting labels such as client A, Q1/Q2, or quote templates as stock tickers; answer the original office task directly.",
          }],
          details: { scene: "finance", notFinanceIntent: true },
        };
      }
      try {
        const { provider, plan, sources, directQuotes } = await collectMarketSources(query, kind, params.market, params.symbol);
        if (!sources.length && !directQuotes?.length) {
          return {
            content: [{
              type: "text",
              text: isZhLocale()
                ? "这次没有拿到可用的财经结果。请重试，或继续使用 web_search / web_fetch 深读具体来源。"
                : "No usable finance results were found this time. Please retry, or continue with web_search / web_fetch for specific sources.",
            }],
            details: { scene: plan?.scene || "finance", provider },
          };
        }

        return {
          content: [{
            type: "text",
            text: buildSnapshotText(query, kind, provider, sources, directQuotes),
          }],
          details: {
            scene: plan?.scene || "finance",
            provider,
            kind,
            market: params.market || "",
            symbol: params.symbol || "",
            sources: sources.map((item) => ({
              title: item.title,
              source: item.source,
              url: item.url,
            })),
            directQuotes: (directQuotes || []).map((item) => ({
              symbol: item.symbol,
              close: item.close,
              date: item.date,
              time: item.time,
              source: item.source,
              url: item.url,
            })),
            shouldCrossVerify: true,
          },
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: isZhLocale()
              ? `行情查询失败：${err.message}`
              : `Market lookup failed: ${err.message}`,
          }],
          details: { kind },
        };
      }
    },
  };
}
