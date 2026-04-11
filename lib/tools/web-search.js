/**
 * web-search.js — web_search 自定义工具
 *
 * 对外暴露一个统一的 web_search tool，只使用显式配置的 provider。
 *
 * 统一返回格式：[{ title, url, snippet }]
 */

import { Type } from "@sinclair/typebox";
import { loadConfig } from "../memory/config-loader.js";
import { t, getLocale } from "../../server/i18n.js";
import { safeParseResponse } from "../../shared/safe-parse.js";

let _configPath = null;
let _searchConfigResolver = null;

function normalizeSearxngBaseUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export function initWebSearch(configPath, opts = {}) {
  _configPath = configPath;
  if (opts.searchConfigResolver) _searchConfigResolver = opts.searchConfigResolver;
}

function dedupeResults(results) {
  const seen = new Set();
  return (results || []).filter((item) => {
    const url = String(item?.url || "").trim();
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function containsAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function isZhLocale() {
  return String(getLocale?.() || "").startsWith("zh");
}

function getHostname(rawUrl) {
  try {
    return new URL(String(rawUrl || "")).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function getSourceLabel(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return "";
  if (host.includes("finance.sina.com.cn") || host.includes("sina.com.cn")) return "新浪财经";
  if (host.includes("qq.com")) return "腾讯";
  if (host.includes("xueqiu.com")) return "雪球";
  if (host.includes("eastmoney.com")) return "东方财富";
  if (host.includes("10jqka.com.cn")) return "同花顺";
  if (host.includes("akshare")) return "AkShare";
  if (host.includes("hupu.com")) return "虎扑";
  if (host.includes("dongqiudi.com")) return "懂球帝";
  if (host.includes("sports.sina.com.cn")) return "新浪体育";
  if (host.includes("sports.qq.com")) return "腾讯体育";
  return hostname;
}

function classifySearchScene(query) {
  const text = String(query || "").trim().toLowerCase();
  if (!text) return "general";

  if (containsAny(text, [
    /\b(api|sdk|docs?|documentation|reference|install|npm|pip|教程|文档|官方文档|接入|配置)\b/i,
  ])) {
    return "docs";
  }

  if (containsAny(text, [
    /\b(金价|黄金|白银|原油|股价|股市|a股|港股|美股|基金|汇率|期货|指数|行情|财报|btc|eth|纳指|道指|标普)\b/i,
  ])) {
    return "finance";
  }

  if (containsAny(text, [
    /\b(比分|赛果|赛程|体育|足球|篮球|nba|cba|英超|西甲|欧冠|世界杯|网球|羽毛球|乒乓球|live score|fixture|result)\b/i,
  ])) {
    return "sports";
  }

  if (containsAny(text, [
    /\b(最新|今日|今天|实时|刚刚|新闻|突发|比分|赛果|赛程|天气|近况|现状|now|today|latest|live|breaking)\b/i,
  ])) {
    return "realtime";
  }

  if (containsAny(text, [
    /\b(调研|综述|研究|论文|paper|report|review|比较|对比|分析)\b/i,
  ])) {
    return "research";
  }

  return "general";
}

function expandQueryForScene(query, scene) {
  const raw = String(query || "").trim();
  if (!raw) return raw;
  const text = raw.toLowerCase();

  if (scene === "finance") {
    const suffix = containsAny(text, [/\b(akshare|腾讯自选股|新浪财经|雪球|东方财富)\b/i])
      ? ""
      : " AkShare 腾讯自选股 新浪财经";
    if (containsAny(text, [/\b(今日|今天|实时|最新|price|live|today|latest)\b/i])) {
      return `${raw}${suffix}`.trim();
    }
    return `${raw}${suffix} 今日 最新 行情`.trim();
  }

  if (scene === "sports") {
    const suffix = containsAny(text, [/\b(腾讯体育|新浪体育|懂球帝|虎扑)\b/i])
      ? ""
      : " 腾讯体育 新浪体育 懂球帝 虎扑";
    if (containsAny(text, [/\b(实时|最新|live|today|latest|比分|赛果|赛程)\b/i])) {
      return `${raw}${suffix}`.trim();
    }
    return `${raw}${suffix} 实时 比分 赛果`.trim();
  }

  if (scene === "realtime") {
    if (containsAny(text, [/\b(今日|今天|实时|最新|news|today|latest|live)\b/i])) return raw;
    return `${raw} 最新 今日`;
  }

  if (scene === "docs") {
    if (containsAny(text, [/\b(api|sdk|docs?|documentation|reference|教程|文档|官方文档)\b/i])) return raw;
    return `${raw} 官方文档`;
  }

  return raw;
}

function buildSearchPlan(query, sceneHint = "") {
  const forcedScene = String(sceneHint || "").trim().toLowerCase();
  const scene = classifySearchScene(query);
  const effectiveScene = forcedScene || scene;
  const expandedQuery = expandQueryForScene(query, effectiveScene);
  const preferredSources = effectiveScene === "finance"
    ? ["AkShare", "腾讯自选股", "新浪财经", "雪球", "东方财富"]
    : effectiveScene === "sports"
      ? ["腾讯体育", "新浪体育", "懂球帝", "虎扑"]
      : effectiveScene === "docs"
        ? ["官方文档", "GitHub", "开发者文档"]
        : [];
  return {
    scene: effectiveScene,
    expandedQuery,
    preferFresh: effectiveScene === "realtime" || effectiveScene === "finance",
    preferDocs: effectiveScene === "docs",
    suggestDeepRead: effectiveScene === "research" || effectiveScene === "docs" || effectiveScene === "finance" || effectiveScene === "realtime" || effectiveScene === "sports",
    preferredSources,
    requiresSpecializedData: effectiveScene === "finance" || effectiveScene === "sports",
    shouldCrossVerify: effectiveScene === "finance" || effectiveScene === "sports" || effectiveScene === "realtime",
  };
}

function buildPlanNotice(plan) {
  const zh = isZhLocale();
  if (!plan) return "";

  if (plan.scene === "finance") {
    return zh
      ? `搜索提示：这是财经/行情类问题。优先参考 ${plan.preferredSources.join(" / ")} 等来源；关键价格、涨跌幅和时间点请至少交叉验证 2 个来源。若需要更精确的实时数据，建议额外接入专门财经数据源（如 Tushare Token 或你自己的行情服务）。当前结果属于网页搜索汇总，不等同于直连行情源。`
      : `Search note: this is a finance/market query. Prefer sources such as ${plan.preferredSources.join(" / ")} and cross-check key prices, changes, and timestamps across at least two sources. For stricter real-time market data, connect a dedicated finance data source (for example Tushare or your own market service). The current result is aggregated web search, not a direct market feed.`;
  }

  if (plan.scene === "sports") {
    return zh
      ? `搜索提示：这是体育比分/赛果类问题。优先参考 ${plan.preferredSources.join(" / ")} 等来源；关键比分、赛果和开赛时间请至少交叉验证 2 个来源。若需要更精确的实时比分，建议额外接入专门体育数据源。`
      : `Search note: this is a sports score/result query. Prefer sources such as ${plan.preferredSources.join(" / ")} and cross-check key scores, results, and kickoff times across at least two sources. For stricter live score coverage, connect a dedicated sports data source.`;
  }

  if (plan.scene === "realtime") {
    return zh
      ? "搜索提示：这是实时/最新信息类问题。回答前请优先核对时间戳和来源站点，不要把单一结果当成最终结论。"
      : "Search note: this is a latest/live query. Verify timestamps and source sites before answering, and do not treat a single result as final truth.";
  }

  if (plan.scene === "docs") {
    return zh
      ? "搜索提示：这是文档/教程类问题。优先阅读官方文档或仓库原始说明，再提炼答案。"
      : "Search note: this is a docs/tutorial query. Prefer official docs or repository source material before summarizing.";
  }

  return "";
}

// ════════════════════════════════════════
// Provider: Tavily
// ════════════════════════════════════════

async function searchTavily(query, maxResults, apiKey) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: "basic",
    }),
  });

  const data = await safeParseResponse(res, null);
  if (!data) throw new Error(`Tavily API ${res.status}`);

  return (data.results || []).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
  }));
}

// ════════════════════════════════════════
// Provider: Serper (Google)
// ════════════════════════════════════════

async function searchSerper(query, maxResults, apiKey) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({ q: query, num: maxResults }),
  });

  const data = await safeParseResponse(res, null);
  if (!data) throw new Error(`Serper API ${res.status}`);

  return (data.organic || []).slice(0, maxResults).map((r) => ({
    title: r.title || "",
    url: r.link || "",
    snippet: r.snippet || "",
  }));
}

// ════════════════════════════════════════
// Provider: Brave Search
// ════════════════════════════════════════

async function searchBrave(query, maxResults, apiKey) {
  const params = new URLSearchParams({ q: query, count: maxResults });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  const data = await safeParseResponse(res, null);
  if (!data) throw new Error(`Brave API ${res.status}`);

  return (data.web?.results || []).slice(0, maxResults).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.description || "",
  }));
}

async function searchSearxng(query, maxResults, _apiKey, opts = {}) {
  const baseUrl = normalizeSearxngBaseUrl(opts.base_url);
  if (!baseUrl) throw new Error("searXNG base URL is required");
  const scene = opts.scene || "general";

  const params = new URLSearchParams({
    q: query,
    format: "json",
    language: "zh-CN",
    safesearch: "0",
  });
  if (Number.isFinite(maxResults) && maxResults > 0) {
    params.set("count", String(Math.min(maxResults, 10)));
  }
  if (scene === "realtime") {
    params.set("categories", "news");
    params.set("time_range", "day");
  } else if (scene === "docs") {
    params.set("categories", "general");
  } else if (scene === "finance") {
    params.set("time_range", "day");
  }

  const url = /\/search$/i.test(baseUrl)
    ? `${baseUrl}?${params.toString()}`
    : `${baseUrl}/search?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Lynn/0.76 web-search searxng",
    },
  });

  const data = await safeParseResponse(res, null);
  if (!data) throw new Error(`searXNG ${res.status}`);

  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    throw new Error("searXNG returned no results");
  }

  return dedupeResults(results.slice(0, maxResults).map((r) => ({
    title: r.title || r.url || "",
    url: r.url || "",
    snippet: r.content || r.snippet || "",
  })).filter((r) => r.title && r.url));
}

const PROVIDERS = {
  tavily: searchTavily,
  serper: searchSerper,
  brave: searchBrave,
  searxng: searchSearxng,
};

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveDuckDuckGoHref(rawHref) {
  if (!rawHref) return "";
  try {
    const parsed = new URL(rawHref, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : parsed.toString();
  } catch {
    return rawHref;
  }
}

export async function searchDuckDuckGoHtml(query, maxResults) {
  const params = new URLSearchParams({ q: query, kl: "cn-zh" });
  const res = await fetch(`https://html.duckduckgo.com/html/?${params.toString()}`, {
    headers: {
      "User-Agent": "Lynn/0.73 web-search fallback",
      "Accept": "text/html,application/xhtml+xml",
    },
  });

  const html = await res.text();
  if (!res.ok || !html) {
    throw new Error(`DuckDuckGo HTML ${res.status}`);
  }

  const matches = [...html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const results = matches
    .slice(0, maxResults)
    .map((match) => ({
      title: stripHtml(match[2]),
      url: resolveDuckDuckGoHref(match[1]),
      snippet: "",
    }))
    .filter((item) => item.title && item.url);

  if (results.length === 0) {
    throw new Error("DuckDuckGo HTML returned no results");
  }

  return dedupeResults(results);
}

/**
 * 验证搜索 API key 是否有效
 * @param {string} provider - tavily / serper / brave
 * @param {string} apiKey - 要验证的 key
 * @returns {Promise<boolean>}
 */
export async function verifySearchKey(provider, apiKey, opts = {}) {
  const fn = PROVIDERS[provider];
  if (!fn) throw new Error(`Unknown provider: ${provider}`);
  // 用一个简短查询测试 key 是否可用
  await fn("test", 1, apiKey, opts);
  return true;
}

async function doSearch(query, maxResults, opts = {}) {
  const plan = buildSearchPlan(query, opts.sceneHint);
  // 优先从全局 resolver 获取搜索配置，否则从 agent config 读取
  let provider = "";
  let baseUrl = "";
  let apiKey = "";
  if (_searchConfigResolver) {
    const resolved = _searchConfigResolver();
    provider = resolved.provider || "";
    baseUrl = resolved.base_url || "";
    apiKey = resolved.api_key || "";
  }
  if (!provider || !apiKey) {
    const cfg = _configPath ? loadConfig(_configPath) : {};
    const searchCfg = cfg.search || {};
    if (!provider) provider = searchCfg.provider || "";
    if (!baseUrl) baseUrl = searchCfg.base_url || "";
    if (!apiKey) apiKey = searchCfg.api_key || "";
  }

  const errors = [];
  if (!provider) {
    errors.push(t("error.searchProviderNotConfigured"));
  } else if (provider === "searxng" && !baseUrl) {
    errors.push(t("error.searchProviderMissingBaseUrl", { provider }));
  } else if (provider !== "searxng" && !PROVIDERS[provider]) {
    errors.push(t("error.searchProviderUnknown", { provider }));
  } else if (provider !== "searxng" && !apiKey) {
    errors.push(t("error.searchProviderMissingKey", { provider }));
  } else if (PROVIDERS[provider]) {
    try {
      return {
        results: await PROVIDERS[provider](plan.expandedQuery, maxResults, apiKey, {
          base_url: baseUrl,
          scene: plan.scene,
        }),
        provider,
        plan,
      };
    } catch (err) {
      errors.push(t("error.searchFailed", { msg: err.message }));
    }
  }

  try {
    return {
      results: await searchDuckDuckGoHtml(plan.expandedQuery, maxResults),
      provider: "duckduckgo-html",
      plan,
    };
  } catch (fallbackErr) {
    errors.push(t("error.searchFailed", { msg: fallbackErr.message }));
  }

  throw new Error(errors[0] || t("error.searchProviderNotConfigured"));
}

export async function runSearchQuery(query, maxResults = 5, opts = {}) {
  return doSearch(query, maxResults, opts);
}

// ════════════════════════════════════════
// Tool 定义
// ════════════════════════════════════════

export function createWebSearchTool() {
  return {
    name: "web_search",
    label: t("toolDef.webSearch.label"),
    description: t("toolDef.webSearch.description"),
    parameters: Type.Object({
      query: Type.String({ description: t("toolDef.webSearch.queryDesc") }),
      maxResults: Type.Optional(
        Type.Number({ description: t("toolDef.webSearch.maxResultsDesc"), default: 5 })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const query = params.query?.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: t("error.searchEmptyQuery") }],
          details: {},
        };
      }

      try {
        const { results, provider, plan } = await doSearch(query, params.maxResults ?? 5);

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: t("error.searchNoResults", { provider }) }],
            details: { scene: plan?.scene || "general" },
          };
        }

        const formatted = results
          .map((r, i) => {
            const host = getHostname(r.url);
            const source = getSourceLabel(host);
            const sourceLine = source
              ? (isZhLocale() ? `   来源：${source}\n` : `   Source: ${source}\n`)
              : "";
            return `${i + 1}. **${r.title}**\n${sourceLine}   ${r.url}\n   ${r.snippet}`;
          })
          .join("\n\n");

        const planNotice = buildPlanNotice(plan);
        const followupHint = plan?.suggestDeepRead
          ? `\n\n${t("error.searchFollowupHint")}`
          : "";

        return {
          content: [{ type: "text", text: [planNotice, t("error.searchResults", { provider, results: formatted })].filter(Boolean).join("\n\n") + followupHint }],
          details: {
            scene: plan?.scene || "general",
            expandedQuery: plan?.expandedQuery || query,
            preferFresh: !!plan?.preferFresh,
            preferDocs: !!plan?.preferDocs,
            preferredSources: plan?.preferredSources || [],
            requiresSpecializedData: !!plan?.requiresSpecializedData,
            shouldCrossVerify: !!plan?.shouldCrossVerify,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.searchError", { msg: err.message }) }],
          details: {},
        };
      }
    },
  };
}
