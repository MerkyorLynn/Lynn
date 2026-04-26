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
const DIRECT_QUOTE_TIMEOUT_MS = 7000;
const TROY_OUNCE_GRAMS = 31.1034768;

function isZhLocale() {
  return String(getLocale?.() || "").startsWith("zh");
}

function detectKind(query, explicitKind = "") {
  const forced = String(explicitKind || "").trim().toLowerCase();
  if (forced) return forced;
  const text = String(query || "").toLowerCase();
  if (/(金价|黄金|白银|au\b|xau|gold|silver)/i.test(text)) return "gold";
  if (/(原油|油价|布伦特|wti|crude|oil)/i.test(text)) return "oil";
  if (/(汇率|美元|人民币|日元|欧元|英镑|fx|usd|cny|eur|gbp|jpy)/i.test(text)) return "fx";
  if (/(基金|净值|etf|lof|fof)/i.test(text)) return "fund";
  if (/(指数|上证|深证|创业板|恒生|纳指|道指|标普|index)/i.test(text)) return "index";
  return "stock";
}

function formatNumber(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return num.toFixed(digits);
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function fetchJson(url, timeoutMs = DIRECT_QUOTE_TIMEOUT_MS) {
  const timer = timeoutSignal(timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: timer.signal,
      headers: {
        "User-Agent": "Lynn/MarketQuote",
        "Accept": "application/json,text/plain,*/*",
      },
    });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    return await resp.json();
  } finally {
    timer.clear();
  }
}

async function fetchText(url, timeoutMs = DIRECT_QUOTE_TIMEOUT_MS) {
  const timer = timeoutSignal(timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: timer.signal,
      headers: {
        "User-Agent": "Lynn/MarketQuote",
        "Accept": "text/csv,text/plain,*/*",
      },
    });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    return await resp.text();
  } finally {
    timer.clear();
  }
}

function formatGoldApiLine(data, label) {
  const ozCny = Number(data?.price);
  const cnyPerGram = ozCny / TROY_OUNCE_GRAMS;
  if (!Number.isFinite(cnyPerGram)) return "";
  const updated = data?.updatedAt ? `，更新时间 ${data.updatedAt}` : "";
  const exchange = Number.isFinite(Number(data?.exchangeRate)) ? `，汇率 ${formatNumber(data.exchangeRate, 4)}` : "";
  return `${label}: ${formatNumber(cnyPerGram, 2)} 元/克（${formatNumber(ozCny, 2)} CNY/oz${exchange}${updated}，来源 Gold-API）`;
}

function cleanHtmlText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function rowsInSection(html, startMarker, endMarker = "") {
  const start = html.indexOf(startMarker);
  if (start < 0) return [];
  const end = endMarker ? html.indexOf(endMarker, start + startMarker.length) : -1;
  const section = html.slice(start, end > start ? end : undefined);
  return [...section.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
}

function parseDomesticGoldRows(html) {
  const brandRows = rowsInSection(html, "各品牌黄金首饰金店报价", "银行投资金条价格")
    .map((row) => {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cleanHtmlText(cell[1]));
      if (cells.length < 6) return null;
      const [brand, jewelry, platinum, bar, unit, date] = cells;
      if (!brand || !jewelry || jewelry === "-") return null;
      return { brand, jewelry, platinum, bar, unit, date };
    })
    .filter(Boolean);

  const bankRows = rowsInSection(html, "银行投资金条价格", "今日黄金回收价格")
    .map((row) => {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cleanHtmlText(cell[1]));
      if (cells.length < 2) return null;
      const [name, price] = cells;
      return name && price && price !== "-" ? { name, price } : null;
    })
    .filter(Boolean);

  const recycleRows = rowsInSection(html, "今日黄金回收价格")
    .map((row) => {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cleanHtmlText(cell[1]));
      if (cells.length < 4) return null;
      const [name, price, unit, date] = cells;
      return name && price && price !== "-" ? { name, price, unit, date } : null;
    })
    .filter(Boolean);

  return { brandRows, bankRows, recycleRows };
}

function pickRows(rows, names, limit) {
  const picked = [];
  const used = new Set();
  for (const name of names) {
    const row = rows.find((item) => String(item.brand || item.name || "").includes(name));
    if (row && !used.has(row.brand || row.name)) {
      used.add(row.brand || row.name);
      picked.push(row);
    }
  }
  for (const row of rows) {
    if (picked.length >= limit) break;
    const key = row.brand || row.name;
    if (key && !used.has(key)) {
      used.add(key);
      picked.push(row);
    }
  }
  return picked.slice(0, limit);
}

async function buildDomesticGoldSnapshot() {
  try {
    const html = await fetchText("https://www.huilvbiao.com/gold");
    const { brandRows, bankRows, recycleRows } = parseDomesticGoldRows(html);
    const lines = [];

    const brands = pickRows(brandRows, ["中国黄金", "老凤祥", "老庙", "周大福", "周生生", "六福"], 6);
    if (brands.length) {
      lines.push("品牌金店首饰金价:");
      for (const row of brands) {
        const barText = row.bar && row.bar !== "-" ? `，金条 ${row.bar}` : "";
        lines.push(`- ${row.brand}: ${row.jewelry} ${row.unit || "元/克"}${barText}（${row.date || "今日"}，来源 汇率表）`);
      }
    }

    const banks = pickRows(bankRows, ["农行", "工商银行", "中国银行", "建设银行"], 4);
    if (banks.length) {
      lines.push("银行投资金条:");
      for (const row of banks) lines.push(`- ${row.name}: ${row.price} 元/克（来源 汇率表）`);
    }

    const recycles = pickRows(recycleRows, ["黄金回收", "24K金回收"], 2);
    if (recycles.length) {
      lines.push("黄金回收:");
      for (const row of recycles) lines.push(`- ${row.name}: ${row.price} ${row.unit || "元/克"}（${row.date || "今日"}，来源 汇率表）`);
    }

    return lines.length ? ["【国内黄金零售/金条/回收参考】", ...lines].join("\n") : "";
  } catch {
    return "";
  }
}

async function buildDirectGoldSnapshot() {
  const rows = [];
  const errors = [];
  for (const [symbol, label] of [["XAU", "国际现货黄金 XAU"], ["XAG", "国际现货白银 XAG"]]) {
    try {
      const data = await fetchJson(`https://api.gold-api.com/price/${symbol}/CNY`);
      const line = formatGoldApiLine(data, label);
      if (line) rows.push(line);
    } catch (err) {
      errors.push(`${symbol}: ${err.message || err}`);
    }
  }
  if (!rows.length) return "";
  const zh = isZhLocale();
  const international = [
    zh ? "【直连贵金属报价】" : "【Direct precious metal quote】",
    ...rows.map((line) => `- ${line}`),
    zh
      ? "- 注：这是国际现货按 CNY/oz 换算到元/克；国内金饰、投资金条和回收价见下方直连参考，实际门店还会叠加工费/地区差。"
      : "- Note: this is international spot converted to CNY/gram; local exchange, jewelry, bar, and buyback quotes still require domestic source checks.",
    errors.length ? `- ${zh ? "备用源失败" : "fallback errors"}: ${errors.join("; ")}` : "",
  ].filter(Boolean).join("\n");
  const domestic = await buildDomesticGoldSnapshot();
  return [international, domestic].filter(Boolean).join("\n\n");
}

function formatYahooFutureLine(data, label) {
  const meta = data?.chart?.result?.[0]?.meta || {};
  const price = Number(meta.regularMarketPrice);
  if (!Number.isFinite(price)) return "";
  const prev = Number(meta.chartPreviousClose);
  const change = Number.isFinite(prev) ? price - prev : NaN;
  const pct = Number.isFinite(prev) && prev !== 0 ? (change / prev) * 100 : NaN;
  const changeText = Number.isFinite(change) && Number.isFinite(pct)
    ? `，较前收 ${change >= 0 ? "+" : ""}${formatNumber(change, 2)}（${change >= 0 ? "+" : ""}${formatNumber(pct, 2)}%）`
    : "";
  const timeText = meta.regularMarketTime
    ? `，更新时间 ${new Date(meta.regularMarketTime * 1000).toISOString()}`
    : "";
  return `${label}: ${formatNumber(price, 2)} 美元/桶${changeText}${timeText}，来源 Yahoo Finance`;
}

async function buildDirectOilSnapshot(query) {
  const rows = [];
  const futures = [
    ["BZ=F", "布伦特原油期货"],
    ["CL=F", "WTI 原油期货"],
  ];
  for (const [symbol, label] of futures) {
    try {
      const data = await fetchJson(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
      const line = formatYahooFutureLine(data, label);
      if (line) rows.push(line);
    } catch {
      // Yahoo is a fast direct source when available; Stooq below covers WTI if it is blocked.
    }
  }
  try {
    const csv = await fetchText("https://stooq.com/q/l/?s=cl.f&f=sd2t2ohlcv&h&e=csv");
    const [, line] = String(csv || "").trim().split(/\r?\n/);
    const [symbol, date, time, open, high, low, close, volume] = String(line || "").split(",");
    if (!rows.some((row) => row.includes("WTI")) && symbol && close && close !== "N/D") {
      rows.push(`WTI 原油期货: ${close} 美元/桶（${date} ${time}，开 ${open} / 高 ${high} / 低 ${low}，来源 Stooq）`);
    }
  } catch {
    // Oil still has web-search fallback below.
  }
  if (!rows.length) return "";
  return [
    "【直连原油报价】",
    ...rows.map((line) => `- ${line}`),
  ].filter(Boolean).join("\n");
}

function extractAStockCode(query, explicitSymbol = "") {
  const symbolText = String(explicitSymbol || "").trim();
  const explicit = symbolText.match(/(?:sh|sz|bj)?([03468]\d{5})/i)?.[1];
  const fromQuery = String(query || "").match(/\b([03468]\d{5})\b/)?.[1];
  return explicit || fromQuery || "";
}

function isSimpleAStockQuoteQuery(query, params = {}) {
  const text = `${params.symbol || ""} ${query || ""}`;
  if (!extractAStockCode(text)) return false;
  if (/(支撑|压力|技术面|走势|趋势|基本面|估值|财报|业绩|订单|资金面|情绪|市值|区间|深度|分析|研报|预测|怎么看|怎么看待|策略|操作|买入|卖出|持仓)/i.test(text)) {
    return false;
  }
  return /(股价|股票|现价|最新价|现在|多少|报价|涨跌|涨幅|跌幅|行情|价格)/i.test(text);
}

const HK_STOCK_NAME_TO_CODE = new Map([
  ["腾讯控股", "00700"],
  ["腾讯", "00700"],
  ["阿里巴巴", "09988"],
  ["美团", "03690"],
  ["小米集团", "01810"],
  ["小米", "01810"],
]);

const US_STOCK_NAME_TO_SYMBOL = new Map([
  ["苹果", "AAPL"],
  ["英伟达", "NVDA"],
  ["微软", "MSFT"],
  ["谷歌", "GOOGL"],
  ["亚马逊", "AMZN"],
  ["特斯拉", "TSLA"],
  ["Meta", "META"],
  ["META", "META"],
]);

const US_TICKER_STOP_WORDS = new Set([
  "A", "AI", "API", "ETF", "PE", "PB", "PS", "K", "MACD", "RSI",
  "USD", "HKD", "CNY", "CN", "HK", "US", "OK",
]);

function normalizeHKCode(code) {
  const digits = String(code || "").replace(/\D/g, "");
  return digits ? digits.padStart(5, "0").slice(-5) : "";
}

function extractGlobalStockTargets(query, params = {}) {
  const text = `${params.symbol || ""} ${query || ""}`;
  const targetsBySymbol = new Map();
  const isBetterDisplay = (next, prev) => /[\u4e00-\u9fa5]/.test(String(next || "")) && !/[\u4e00-\u9fa5]/.test(String(prev || ""));
  const add = (target) => {
    if (!target?.querySymbol) return;
    const existing = targetsBySymbol.get(target.querySymbol);
    if (!existing || isBetterDisplay(target.display, existing.display)) {
      targetsBySymbol.set(target.querySymbol, existing ? { ...existing, ...target } : target);
    }
  };

  for (const match of text.matchAll(/\b(\d{4,5})\s*(?:\.|\s*)HK\b/gi)) {
    const code = normalizeHKCode(match[1]);
    if (code) add({ market: "HK", sourceSymbol: `${code}.HK`, querySymbol: `hk${code}`, display: `${code}.HK` });
  }
  for (const [name, code] of HK_STOCK_NAME_TO_CODE) {
    if (text.includes(name)) add({ market: "HK", sourceSymbol: `${code}.HK`, querySymbol: `hk${code}`, display: name });
  }

  for (const match of text.matchAll(/\b([A-Z]{1,5})(?:\.[A-Z])?\b/g)) {
    const symbol = match[1].toUpperCase();
    if (US_TICKER_STOP_WORDS.has(symbol)) continue;
    add({ market: "US", sourceSymbol: symbol, querySymbol: `us${symbol}`, display: symbol });
  }
  for (const [name, symbol] of US_STOCK_NAME_TO_SYMBOL) {
    if (text.includes(name)) add({ market: "US", sourceSymbol: symbol, querySymbol: `us${symbol}`, display: name });
  }

  return [...targetsBySymbol.values()];
}

function isSimpleStockQuoteQuery(query, params = {}) {
  const text = `${params.symbol || ""} ${query || ""}`;
  const hasTarget = Boolean(extractAStockCode(text) || extractGlobalStockTargets(query, params).length);
  if (!hasTarget) return false;
  if (/(支撑|压力|技术面|走势|趋势|基本面|估值|财报|业绩|订单|资金面|情绪|市值|区间|深度|分析|研报|预测|怎么看|怎么看待|策略|操作|买入|卖出|持仓)/i.test(text)) {
    return false;
  }
  return /(股价|股票|现价|最新价|现在|多少|报价|涨跌|涨幅|跌幅|行情|价格|只给|直接给)/i.test(text);
}

function marketPrefixForAStock(code) {
  if (code.startsWith("6")) return "sh";
  if (/^[03]/.test(code)) return "sz";
  if (/^[48]/.test(code)) return "bj";
  return "";
}

function extractStockDisplayName(query, code) {
  const source = String(query || "");
  const index = code ? source.indexOf(code) : -1;
  const beforeCode = index >= 0 ? source.slice(0, index) : source;
  const match = beforeCode.match(/([\u4e00-\u9fa5A-Za-z]{2,20})$/);
  return match?.[1] || "";
}

function formatCnyAmountFromWan(value) {
  const wan = Number(value);
  if (!Number.isFinite(wan)) return "";
  return wan >= 10000 ? `${formatNumber(wan / 10000, 2)} 亿元` : `${formatNumber(wan, 2)} 万元`;
}

async function buildDirectAStockSnapshot(query, params = {}) {
  const code = extractAStockCode(query, params.symbol);
  const prefix = marketPrefixForAStock(code);
  if (!code || !prefix) return "";

  try {
    const raw = await fetchText(`https://qt.gtimg.cn/q=${prefix}${code}`);
    const payload = String(raw || "").match(/="([\s\S]*?)"/)?.[1] || "";
    const fields = payload.split("~");
    const price = fields[3];
    const change = fields[31];
    const pct = fields[32];
    const high = fields[33];
    const low = fields[34];
    const amountWan = fields[37];
    const turnover = fields[38];
    const pe = fields[39];
    const timestamp = fields[30];
    if (!price || price === "0" || price === "--") return "";

    const name = extractStockDisplayName(query, code) || `${prefix.toUpperCase()}${code}`;
    const changeText = change && pct
      ? `${Number(change) >= 0 ? "+" : ""}${change} 元（${Number(pct) >= 0 ? "+" : ""}${pct}%）`
      : "涨跌待核验";
    const amountText = amountWan ? `，成交额 ${formatCnyAmountFromWan(amountWan)}` : "";
    const turnoverText = turnover ? `，换手率 ${turnover}%` : "";
    const rangeText = high && low ? `，日内高低 ${high}/${low} 元` : "";
    const peText = pe ? `，PE ${pe}` : "";
    const timeText = timestamp ? `，时间 ${timestamp}` : "";

    return [
      "【直连 A 股报价】",
      `- ${name}（${code}）: ${price} 元，${changeText}${amountText}${turnoverText}${rangeText}${peText}${timeText}，来源 腾讯行情`,
    ].join("\n");
  } catch {
    return "";
  }
}

function parseTencentGlobalQuote(payload, target) {
  const fields = String(payload || "").split("~");
  const price = fields[3];
  const timestamp = fields[30];
  const change = fields[31];
  const pct = fields[32];
  const high = fields[33];
  const low = fields[34];
  const amountRaw = fields[37];
  const englishName = fields[46];
  const currency = target.market === "HK" ? (fields[75] || "HKD") : (fields[35] || "USD");
  if (!price || price === "0" || price === "--") return "";
  const display = target.display || englishName || target.sourceSymbol;
  const symbol = target.market === "HK"
    ? `${target.sourceSymbol.replace(/\.HK$/i, "")}.HK`
    : target.sourceSymbol;
  const changeText = change && pct
    ? `${Number(change) >= 0 ? "+" : ""}${change}（${Number(pct) >= 0 ? "+" : ""}${pct}%）`
    : "涨跌待核验";
  const amountNum = Number(amountRaw);
  const amountText = Number.isFinite(amountNum) && amountNum > 0
    ? `，成交额 ${target.market === "HK" ? formatNumber(amountNum / 100000000, 2) : formatNumber(amountNum / 100000000, 2)} 亿${currency}`
    : "";
  const rangeText = high && low ? `，日内高低 ${high}/${low} ${currency}` : "";
  const timeText = timestamp ? `，时间 ${timestamp}` : "";
  const nameText = englishName && !String(display).includes(englishName) ? `${display}/${englishName}` : display;
  return `${nameText}（${symbol}）: ${price} ${currency}，${changeText}${amountText}${rangeText}${timeText}，来源 腾讯行情`;
}

async function buildDirectGlobalStockSnapshot(query, params = {}) {
  const targets = extractGlobalStockTargets(query, params);
  if (!targets.length) return "";

  try {
    const raw = await fetchText(`https://qt.gtimg.cn/q=${targets.map((item) => item.querySymbol).join(",")}`);
    const payloads = new Map();
    for (const match of String(raw || "").matchAll(/v_([a-zA-Z0-9]+)="([\s\S]*?)";?/g)) {
      payloads.set(match[1], match[2]);
    }
    const rows = targets
      .map((target) => parseTencentGlobalQuote(payloads.get(target.querySymbol), target))
      .filter(Boolean);
    if (!rows.length) return "";
    return [
      "【直连美股/港股报价】",
      ...rows.map((line) => `- ${line}`),
    ].join("\n");
  } catch {
    return "";
  }
}

async function buildDirectMarketSnapshot(kind, query, params = {}) {
  if (kind === "gold") return buildDirectGoldSnapshot();
  if (kind === "oil") return buildDirectOilSnapshot(query);
  if (kind === "stock") {
    return [await buildDirectAStockSnapshot(query, params), await buildDirectGlobalStockSnapshot(query, params)]
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
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

function buildSnapshotText(query, kind, provider, sources) {
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

  const body = sources.map((item, idx) => {
    const lines = item.lines?.length
      ? item.lines.map((line) => `- ${line}`).join("\n")
      : `- ${item.snippet || (zh ? "未提取到清晰行情行，建议继续深读该来源。" : "No clear market line extracted; consider reading this source in depth.")}`;
    return [
      `${idx + 1}. ${item.title || item.source || item.url}`,
      zh ? `来源：${item.source || item.host}` : `Source: ${item.source || item.host}`,
      item.url,
      lines,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  const tail = zh
    ? "\n\n后续建议：如果需要更精确的实时行情，请继续对最相关来源使用 web_fetch，或接入专门财经数据源。"
    : "\n\nSuggested next step: use web_fetch on the most relevant source for more detail, or connect a dedicated finance data source for stricter real-time quotes.";

  return `${header}\n\n${body}${tail}`;
}

async function collectMarketSources(query, kind, market, symbol) {
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
      symbol: Type.Optional(Type.String({ description: t("toolDef.stockMarket.symbolDesc") })),
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
      let directSnapshot = "";
      try {
        directSnapshot = await buildDirectMarketSnapshot(kind, query, params);
      } catch {
        directSnapshot = "";
      }
      if ((kind === "gold" || kind === "oil") && directSnapshot) {
        return {
          content: [{ type: "text", text: directSnapshot }],
          details: {
            scene: "finance",
            provider: "direct",
            kind,
            market: params.market || "",
            symbol: params.symbol || "",
            sources: [],
            shouldCrossVerify: false,
            hasDirectSnapshot: true,
          },
        };
      }
      if (kind === "stock" && directSnapshot && isSimpleStockQuoteQuery(query, params)) {
        return {
          content: [{ type: "text", text: directSnapshot }],
          details: {
            scene: "finance",
            provider: "tencent-direct",
            kind,
            market: params.market || "",
            symbol: params.symbol || "",
            sources: [{ title: "腾讯行情直连报价", source: "腾讯行情", url: "https://qt.gtimg.cn/" }],
            shouldCrossVerify: false,
            hasDirectSnapshot: true,
          },
        };
      }
      try {
        const { provider, plan, sources } = await collectMarketSources(query, kind, params.market, params.symbol);
        if (!sources.length && !directSnapshot) {
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
            text: [directSnapshot, sources.length ? buildSnapshotText(query, kind, provider, sources) : ""]
              .filter(Boolean)
              .join("\n\n"),
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
            shouldCrossVerify: true,
            hasDirectSnapshot: Boolean(directSnapshot),
          },
        };
      } catch (err) {
        if (directSnapshot) {
          return {
            content: [{
              type: "text",
              text: [
                directSnapshot,
                isZhLocale()
                  ? `\n网页交叉核验失败：${err.message || err}`
                  : `\nWeb cross-check failed: ${err.message || err}`,
              ].join("\n"),
            }],
            details: { kind, hasDirectSnapshot: true, provider: "direct" },
          };
        }
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
