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
      try {
        const { provider, plan, sources } = await collectMarketSources(query, kind, params.market, params.symbol);
        if (!sources.length) {
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
            text: buildSnapshotText(query, kind, provider, sources),
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
