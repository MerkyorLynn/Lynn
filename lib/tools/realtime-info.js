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
const OPEN_METEO_TIMEOUT_MS = 7000;
const KNOWN_WEATHER_PLACES = new Map([
  ["北京", { name: "北京", admin1: "北京", country: "中国", latitude: 39.9042, longitude: 116.4074, timezone: "Asia/Shanghai" }],
  ["上海", { name: "上海", admin1: "上海", country: "中国", latitude: 31.2304, longitude: 121.4737, timezone: "Asia/Shanghai" }],
  ["深圳", { name: "深圳", admin1: "广东", country: "中国", latitude: 22.5455, longitude: 114.0683, timezone: "Asia/Shanghai" }],
  ["广州", { name: "广州", admin1: "广东", country: "中国", latitude: 23.1291, longitude: 113.2644, timezone: "Asia/Shanghai" }],
  ["杭州", { name: "杭州", admin1: "浙江", country: "中国", latitude: 30.2741, longitude: 120.1551, timezone: "Asia/Shanghai" }],
  ["南京", { name: "南京", admin1: "江苏", country: "中国", latitude: 32.0603, longitude: 118.7969, timezone: "Asia/Shanghai" }],
  ["苏州", { name: "苏州", admin1: "江苏", country: "中国", latitude: 31.2989, longitude: 120.5853, timezone: "Asia/Shanghai" }],
  ["成都", { name: "成都", admin1: "四川", country: "中国", latitude: 30.5728, longitude: 104.0668, timezone: "Asia/Shanghai" }],
  ["重庆", { name: "重庆", admin1: "重庆", country: "中国", latitude: 29.5630, longitude: 106.5516, timezone: "Asia/Shanghai" }],
  ["武汉", { name: "武汉", admin1: "湖北", country: "中国", latitude: 30.5928, longitude: 114.3055, timezone: "Asia/Shanghai" }],
  ["天津", { name: "天津", admin1: "天津", country: "中国", latitude: 39.3434, longitude: 117.3616, timezone: "Asia/Shanghai" }],
  ["西安", { name: "西安", admin1: "陕西", country: "中国", latitude: 34.3416, longitude: 108.9398, timezone: "Asia/Shanghai" }],
  ["长沙", { name: "长沙", admin1: "湖南", country: "中国", latitude: 28.2282, longitude: 112.9388, timezone: "Asia/Shanghai" }],
  ["郑州", { name: "郑州", admin1: "河南", country: "中国", latitude: 34.7466, longitude: 113.6254, timezone: "Asia/Shanghai" }],
  ["香港", { name: "香港", admin1: "香港", country: "中国", latitude: 22.3193, longitude: 114.1694, timezone: "Asia/Hong_Kong" }],
  ["澳门", { name: "澳门", admin1: "澳门", country: "中国", latitude: 22.1987, longitude: 113.5439, timezone: "Asia/Macau" }],
  ["台北", { name: "台北", admin1: "台湾", country: "中国", latitude: 25.0330, longitude: 121.5654, timezone: "Asia/Taipei" }],
]);

function isZhLocale() {
  return String(getLocale?.() || "").toLowerCase().startsWith("zh");
}

function zhOrEn(zh, en) {
  return isZhLocale() ? zh : en;
}

function compactLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function formatNumber(value, digits = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "?";
  return num.toFixed(digits);
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
  for (const city of KNOWN_WEATHER_PLACES.keys()) {
    if (text.includes(city)) return city;
  }
  const match = text.match(/(?:明天|今天|后天|未来\d*天|未来)?\s*([\u4e00-\u9fa5A-Za-z .-]{2,32}?)(?:的)?(?:天气|气温|预报)/);
  if (match?.[1]) {
    return compactLine(match[1])
      .replace(/^(?:查|查询|看看|帮我|请问)/, "")
      .replace(/(?:今天|明天|后天|未来\d*天|未来|的)$/g, "")
      .trim() || "深圳";
  }
  return text || "深圳";
}

function weatherCodeText(code) {
  const n = Number(code);
  if (n === 0) return zhOrEn("晴", "Clear");
  if ([1, 2, 3].includes(n)) return zhOrEn(["大部晴朗", "少云", "多云"][n - 1], ["Mainly clear", "Partly cloudy", "Overcast"][n - 1]);
  if ([45, 48].includes(n)) return zhOrEn("雾", "Fog");
  if ([51, 53, 55].includes(n)) return zhOrEn("毛毛雨", "Drizzle");
  if ([56, 57].includes(n)) return zhOrEn("冻毛毛雨", "Freezing drizzle");
  if ([61, 63, 65].includes(n)) return zhOrEn("雨", "Rain");
  if ([66, 67].includes(n)) return zhOrEn("冻雨", "Freezing rain");
  if ([71, 73, 75, 77].includes(n)) return zhOrEn("雪", "Snow");
  if ([80, 81, 82].includes(n)) return zhOrEn("阵雨", "Rain showers");
  if ([85, 86].includes(n)) return zhOrEn("阵雪", "Snow showers");
  if ([95, 96, 99].includes(n)) return zhOrEn("雷雨", "Thunderstorm");
  return zhOrEn("天气数据可用", "Weather data available");
}

async function geocodeOpenMeteo(location) {
  const safeLocation = compactLine(location) || "深圳";
  if (KNOWN_WEATHER_PLACES.has(safeLocation)) return KNOWN_WEATHER_PLACES.get(safeLocation);
  const timer = timeoutSignal(OPEN_METEO_TIMEOUT_MS);
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(safeLocation)}&count=1&language=zh&format=json`;
    const resp = await fetch(url, {
      signal: timer.signal,
      headers: { "User-Agent": "Lynn/RealtimeWeather OpenMeteo" },
    });
    if (!resp.ok) throw new Error(`open-meteo geocode ${resp.status}`);
    const data = await resp.json();
    const first = data?.results?.[0];
    if (!first?.latitude || !first?.longitude) throw new Error(`open-meteo no geocode for ${safeLocation}`);
    return {
      name: first.name || safeLocation,
      admin1: first.admin1 || "",
      country: first.country || "",
      latitude: first.latitude,
      longitude: first.longitude,
      timezone: first.timezone || "Asia/Shanghai",
    };
  } finally {
    timer.clear();
  }
}

async function fetchOpenMeteoWeather(location) {
  const place = await geocodeOpenMeteo(location);
  const timer = timeoutSignal(OPEN_METEO_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
      timezone: place.timezone || "Asia/Shanghai",
      forecast_days: "4",
    });
    const resp = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
      signal: timer.signal,
      headers: { "User-Agent": "Lynn/RealtimeWeather OpenMeteo" },
    });
    if (!resp.ok) throw new Error(`open-meteo forecast ${resp.status}`);
    const data = await resp.json();
    const current = data.current || {};
    const daily = data.daily || {};
    const placeName = [place.name, place.admin1].filter(Boolean).join(" · ");
    const now = [
      `${placeName || location} ${zhOrEn("当前天气", "current weather")}（Open-Meteo）`,
      `- ${zhOrEn("天气", "Weather")}: ${weatherCodeText(current.weather_code)}`,
      `- ${zhOrEn("温度", "Temperature")}: ${formatNumber(current.temperature_2m)}°C`,
      `- ${zhOrEn("体感", "Feels like")}: ${formatNumber(current.apparent_temperature)}°C`,
      `- ${zhOrEn("湿度", "Humidity")}: ${formatNumber(current.relative_humidity_2m, 0)}%`,
      `- ${zhOrEn("降水", "Rain")}: ${formatNumber(current.precipitation)} mm`,
      `- ${zhOrEn("风速", "Wind")}: ${formatNumber(current.wind_speed_10m)} km/h`,
    ].join("\n");

    const forecast = (daily.time || []).slice(0, 4).map((date, idx) => {
      const rainProb = daily.precipitation_probability_max?.[idx];
      const rainSum = daily.precipitation_sum?.[idx];
      const rainText = Number.isFinite(Number(rainProb))
        ? `${zhOrEn("降雨概率", "rain probability")} ${formatNumber(rainProb, 0)}%`
        : `${zhOrEn("降水", "rain")} ${formatNumber(rainSum)} mm`;
      return `- ${date}: ${weatherCodeText(daily.weather_code?.[idx])} ${formatNumber(daily.temperature_2m_min?.[idx])}~${formatNumber(daily.temperature_2m_max?.[idx])}°C, ${rainText}`;
    }).join("\n");

    return [now, forecast ? `\n${zhOrEn("未来几天", "Next days")}\n${forecast}` : ""].filter(Boolean).join("\n");
  } finally {
    timer.clear();
  }
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
        const text = await fetchOpenMeteoWeather(location);
        return {
          content: [{ type: "text", text }],
          details: { provider: "open-meteo", location },
        };
      } catch (err) {
        try {
          const text = await fetchWttrWeather(location);
          return {
            content: [{ type: "text", text }],
            details: { provider: "wttr.in", location, fallback: true, error: err.message },
          };
        } catch (wttrErr) {
          const fallbackQuery = `${location} ${query || "天气"} 温度区间 降雨概率 实时天气 预报`;
          const { provider, results } = await searchAndFetch(fallbackQuery, "weather", 4);
          return {
            content: [{
              type: "text",
              text: formatSearchResults(zhOrEn("天气搜索结果", "Weather search results"), fallbackQuery, provider, results),
            }],
            details: { provider, location, fallback: true, error: `${err.message}; ${wttrErr.message}` },
          };
        }
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
