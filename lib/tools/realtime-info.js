/**
 * realtime-info.js — lightweight realtime lookup tools.
 *
 * These are intentionally local-first wrappers around public search/fetch
 * paths. They keep common daily queries from falling through to heavyweight
 * SKILL.md workflows.
 */

import { Type } from "@sinclair/typebox";
import { getLocale } from "../../server/i18n.js";
import { runSearchQuery } from "./web-search.js";
import { fetchWebContent } from "./web-fetch.js";

const SEARCH_LIMIT = 5;
const FETCH_LIMIT = 2200;

function isZhLocale() {
  return String(getLocale?.() || "").toLowerCase().startsWith("zh");
}

function zhOrEn(zh, en) {
  return isZhLocale() ? zh : en;
}

function compactLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hostname(url) {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function formatSearchResults(title, query, provider, results) {
  const rows = results.map((result, index) => {
    const host = hostname(result.url);
    return [
      `${index + 1}. ${result.title || result.url}`,
      host ? `${zhOrEn("来源", "Source")}: ${host}` : "",
      result.url,
      result.snippet ? `- ${compactLine(result.snippet)}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return [
    `${title} (${provider})`,
    `${zhOrEn("查询", "Query")}: ${query}`,
    "",
    rows,
  ].join("\n");
}

async function searchAndFetch(query, sceneHint, maxResults = SEARCH_LIMIT) {
  const { results, provider, plan } = await runSearchQuery(query, maxResults, { sceneHint });
  const enriched = [];
  for (const result of results.slice(0, 2)) {
    let text = "";
    try {
      const fetched = await fetchWebContent(result.url, FETCH_LIMIT);
      text = compactLine(fetched.text).slice(0, 900);
    } catch {
      text = "";
    }
    enriched.push({ ...result, fetchedText: text });
  }
  return {
    provider,
    plan,
    results: enriched.length ? enriched : results,
  };
}

function extractWeatherLocation(query, location) {
  const explicit = compactLine(location);
  if (explicit) return explicit;
  const text = compactLine(query);
  const match = text.match(/(?:明天|今天|后天|未来\d*天|未来)?\s*([\u4e00-\u9fa5A-Za-z .-]{2,32}?)(?:的)?(?:天气|气温|预报)/);
  if (match?.[1]) return compactLine(match[1]).replace(/^(?:查|查询|看看|帮我|请问)/, "");
  return text || "深圳";
}

async function fetchWttrWeather(location) {
  const safeLocation = compactLine(location) || "深圳";
  const timer = timeoutSignal(8000);
  try {
    const url = `https://wttr.in/${encodeURIComponent(safeLocation)}?format=j1&lang=zh`;
    const resp = await fetch(url, {
      signal: timer.signal,
      headers: { "User-Agent": "Lynn/RealtimeWeather" },
    });
    if (!resp.ok) throw new Error(`wttr ${resp.status}`);
    const data = await resp.json();
    const current = data.current_condition?.[0] || {};
    const area = data.nearest_area?.[0] || {};
    const areaName = area.areaName?.[0]?.value || safeLocation;
    const now = [
      `${areaName} ${zhOrEn("当前天气", "current weather")}`,
      current.weatherDesc?.[0]?.value ? `- ${zhOrEn("天气", "Weather")}: ${current.weatherDesc[0].value}` : "",
      current.temp_C ? `- ${zhOrEn("温度", "Temperature")}: ${current.temp_C} C` : "",
      current.FeelsLikeC ? `- ${zhOrEn("体感", "Feels like")}: ${current.FeelsLikeC} C` : "",
      current.humidity ? `- ${zhOrEn("湿度", "Humidity")}: ${current.humidity}%` : "",
      current.windspeedKmph ? `- ${zhOrEn("风速", "Wind")}: ${current.windspeedKmph} km/h` : "",
      current.precipMM ? `- ${zhOrEn("降水", "Rain")}: ${current.precipMM} mm` : "",
    ].filter(Boolean).join("\n");

    const forecast = (data.weather || []).slice(0, 3).map((day) => {
      const hourly = day.hourly?.[4] || day.hourly?.[0] || {};
      const desc = hourly.weatherDesc?.[0]?.value || "";
      return `- ${day.date}: ${desc || zhOrEn("天气数据可用", "weather data available")} ${day.mintempC || "?"}~${day.maxtempC || "?"} C`;
    }).join("\n");

    return [now, forecast ? `\n${zhOrEn("未来三天", "Next days")}\n${forecast}` : ""].filter(Boolean).join("\n");
  } finally {
    timer.clear();
  }
}

export function createWeatherTool() {
  return {
    name: "weather",
    label: zhOrEn("天气查询", "Weather"),
    description: zhOrEn(
      "查询实时天气和未来几天天气预报。适合“深圳天气如何”“明天北京天气”等问题。",
      "Look up current weather and short forecasts.",
    ),
    parameters: Type.Object({
      query: Type.String({ description: zhOrEn("原始天气问题", "Original weather query") }),
      location: Type.Optional(Type.String({ description: zhOrEn("城市或地区", "City or location") })),
    }),
    execute: async (_toolCallId, params) => {
      const query = compactLine(params.query);
      const location = extractWeatherLocation(query, params.location);
      try {
        const text = await fetchWttrWeather(location);
        return {
          content: [{ type: "text", text }],
          details: { provider: "wttr.in", location },
        };
      } catch (err) {
        const fallbackQuery = `${query || location} 天气 预报`;
        const { provider, results } = await searchAndFetch(fallbackQuery, "weather", 4);
        return {
          content: [{
            type: "text",
            text: formatSearchResults(zhOrEn("天气搜索结果", "Weather search results"), fallbackQuery, provider, results),
          }],
          details: { provider, location, fallback: true, error: err.message },
        };
      }
    },
  };
}

export function createLiveNewsTool() {
  return {
    name: "live_news",
    label: zhOrEn("热点新闻", "Live news"),
    description: zhOrEn(
      "查询今日热点、突发新闻和最新进展。适合“今天有什么新闻”“美伊谈判最新消息”等问题。",
      "Look up live news, breaking stories, and latest developments.",
    ),
    parameters: Type.Object({
      query: Type.String({ description: zhOrEn("新闻问题或关键词", "News query or keywords") }),
      maxResults: Type.Optional(Type.Number({ default: 5 })),
    }),
    execute: async (_toolCallId, params) => {
      const query = compactLine(params.query);
      const searchQuery = `${query} 今日 最新 消息 新闻`;
      const { provider, results } = await searchAndFetch(searchQuery, "news", params.maxResults || SEARCH_LIMIT);
      return {
        content: [{
          type: "text",
          text: formatSearchResults(zhOrEn("实时新闻结果", "Live news results"), searchQuery, provider, results),
        }],
        details: { provider, query: searchQuery },
      };
    },
  };
}

export function createSportsScoreTool() {
  return {
    name: "sports_score",
    label: zhOrEn("体育比分", "Sports scores"),
    description: zhOrEn(
      "查询体育比分、赛程、排名和比赛结果。适合 NBA、CBA、中超、英超等比分赛程问题。",
      "Look up sports scores, schedules, standings, and match results.",
    ),
    parameters: Type.Object({
      query: Type.String({ description: zhOrEn("体育比分或赛程问题", "Sports score or schedule query") }),
      maxResults: Type.Optional(Type.Number({ default: 5 })),
    }),
    execute: async (_toolCallId, params) => {
      const query = compactLine(params.query);
      const searchQuery = `${query} 比分 赛程 排名 最新`;
      const { provider, results } = await searchAndFetch(searchQuery, "sports", params.maxResults || SEARCH_LIMIT);
      return {
        content: [{
          type: "text",
          text: formatSearchResults(zhOrEn("体育查询结果", "Sports lookup results"), searchQuery, provider, results),
        }],
        details: { provider, query: searchQuery },
      };
    },
  };
}
