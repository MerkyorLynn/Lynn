/**
 * web-search.js — web_search 自定义工具
 *
 * 对外暴露一个统一的 web_search tool，只使用显式配置的 provider。
 *
 * 统一返回格式：[{ title, url, snippet }]
 */

import { Type } from "@sinclair/typebox";
import { loadConfig } from "../memory/config-loader.js";
import { t } from "../../server/i18n.js";
import { safeParseResponse } from "../../shared/safe-parse.js";

let _configPath = null;
let _searchConfigResolver = null;

export function initWebSearch(configPath, opts = {}) {
  _configPath = configPath;
  if (opts.searchConfigResolver) _searchConfigResolver = opts.searchConfigResolver;
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

const PROVIDERS = {
  tavily: searchTavily,
  serper: searchSerper,
  brave: searchBrave,
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

  return results;
}

/**
 * 验证搜索 API key 是否有效
 * @param {string} provider - tavily / serper / brave
 * @param {string} apiKey - 要验证的 key
 * @returns {Promise<boolean>}
 */
export async function verifySearchKey(provider, apiKey) {
  const fn = PROVIDERS[provider];
  if (!fn) throw new Error(`Unknown provider: ${provider}`);
  // 用一个简短查询测试 key 是否可用
  await fn("test", 1, apiKey);
  return true;
}

async function doSearch(query, maxResults) {
  // 优先从全局 resolver 获取搜索配置，否则从 agent config 读取
  let provider = "";
  let apiKey = "";
  if (_searchConfigResolver) {
    const resolved = _searchConfigResolver();
    provider = resolved.provider || "";
    apiKey = resolved.api_key || "";
  }
  if (!provider || !apiKey) {
    const cfg = _configPath ? loadConfig(_configPath) : {};
    const searchCfg = cfg.search || {};
    if (!provider) provider = searchCfg.provider || "";
    if (!apiKey) apiKey = searchCfg.api_key || "";
  }

  const errors = [];
  if (provider && apiKey && PROVIDERS[provider]) {
    try {
      return {
        results: await PROVIDERS[provider](query, maxResults, apiKey),
        provider,
      };
    } catch (err) {
      errors.push(t("error.searchFailed", { msg: err.message }));
    }
  } else if (provider && !PROVIDERS[provider]) {
    errors.push(t("error.searchProviderUnknown", { provider }));
  } else if (provider && !apiKey) {
    errors.push(t("error.searchProviderMissingKey", { provider }));
  } else if (!provider) {
    errors.push(t("error.searchProviderNotConfigured"));
  }

  try {
    return {
      results: await searchDuckDuckGoHtml(query, maxResults),
      provider: "duckduckgo-html",
    };
  } catch (fallbackErr) {
    errors.push(t("error.searchFailed", { msg: fallbackErr.message }));
  }

  throw new Error(errors[0] || t("error.searchProviderNotConfigured"));
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
        const { results, provider } = await doSearch(query, params.maxResults ?? 5);

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: t("error.searchNoResults", { provider }) }],
            details: {},
          };
        }

        const formatted = results
          .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");

        return {
          content: [{ type: "text", text: t("error.searchResults", { provider, results: formatted }) }],
          details: {},
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
