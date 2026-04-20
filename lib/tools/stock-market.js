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
  if (/\b(金价|黄金|白银|au\b|xau|gold|silver)\b/i.test(text)) return "gold";
  if (/\b(汇率|美元|人民币|日元|欧元|英镑|fx|usd|cny|eur|gbp|jpy)\b/i.test(text)) return "fx";
  if (/\b(原油|油价|布伦特|wti|crude|oil)\b/i.test(text)) return "oil";
  if (/\b(基金|净值|etf|lof|fof)\b/i.test(text)) return "fund";
  if (/\b(指数|上证|深证|创业板|恒生|纳指|道指|标普|index)\b/i.test(text)) return "index";
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
      return [
        `${idx + 1}. ${item.symbol} 最近可用行情`,
        zh ? `来源：${item.source}` : `Source: ${item.source}`,
        item.url,
        `- ${zh ? "价格" : "Close"}: ${item.close}`,
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

  const body = [quoteBody, webBody].filter(Boolean).join("\n\n");
  return `${header}\n\n${body}${tail}`;
}

async function collectMarketSources(query, kind, market, symbol) {
  const directQuotes = kind === "stock"
    ? await collectStooqQuotes(query, symbol).catch(() => [])
    : [];
  if (directQuotes.length) {
    return {
      provider: "Stooq",
      plan: { scene: "finance" },
      sources: [],
      directQuotes,
    };
  }

  const searchQuery = buildQuery(query, kind, market, symbol);
  const { results, provider, plan } = await runSearchQuery(searchQuery, 5, { sceneHint: "finance" });
  const picked = [];

  for (const result of results.slice(0, 3)) {
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
      source: sourceLabel(result.url),
      host: (() => {
        try { return new URL(result.url).hostname; } catch { return ""; }
      })(),
    });
    if (picked.length >= DEFAULT_FETCH_COUNT) break;
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
