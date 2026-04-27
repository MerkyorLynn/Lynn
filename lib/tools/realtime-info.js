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
const NEWS_RSS_TIMEOUT_MS = 9000;

function isZhLocale() {
  return String(getLocale?.() || "").toLowerCase().startsWith("zh");
}

function zhOrEn(zh, en) {
  return isZhLocale() ? zh : en;
}

function compactLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeWeatherLocationToken(value) {
  return compactLine(value)
    .replace(/^(?:请|帮我|麻烦|顺便|再|同时|一起|以及|还有|然后|顺手|看一下|看下|查一下|查查|搜一下|搜索|查询)\s*/g, "")
    .replace(/^(?:今天|今日|明天|后天|今晚|今早|今天早上|明早|明天早上|下午|上午|中午|夜间|晚上|白天|夜里)\s*/g, "")
    .replace(/\s*(?:白天|早上|上午|下午|晚上|夜间|夜里)\s*$/g, "")
    .replace(/\s*(?:今天|今日|明天|后天|今晚|今早|明早|下午|上午|中午|夜间|晚上|白天|夜里)$/g, "")
    .replace(/\s*(?:天气|气温|温度|预报|多少度|几度|冷不冷|热不热)\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const WEATHER_CODE_ZH = new Map([
  [0, "晴"], [1, "大部晴朗"], [2, "局部多云"], [3, "阴"],
  [45, "雾"], [48, "雾凇"],
  [51, "小毛毛雨"], [53, "毛毛雨"], [55, "较强毛毛雨"],
  [56, "冻毛毛雨"], [57, "较强冻毛毛雨"],
  [61, "小雨"], [63, "中雨"], [65, "大雨"],
  [66, "冻雨"], [67, "较强冻雨"],
  [71, "小雪"], [73, "中雪"], [75, "大雪"],
  [77, "米雪"],
  [80, "小阵雨"], [81, "阵雨"], [82, "强阵雨"],
  [85, "小阵雪"], [86, "强阵雪"],
  [95, "雷暴"], [96, "雷暴伴小冰雹"], [99, "雷暴伴冰雹"],
]);

function weatherCodeText(code) {
  const n = Number(code);
  return WEATHER_CODE_ZH.get(n) || `天气代码 ${code}`;
}

const WTTR_DESC_ZH = new Map([
  ["Sunny", "晴"],
  ["Clear", "晴"],
  ["Partly cloudy", "局部多云"],
  ["Cloudy", "多云"],
  ["Overcast", "阴"],
  ["Mist", "薄雾"],
  ["Fog", "雾"],
  ["Patchy rain nearby", "附近有零星小雨"],
  ["Patchy light rain", "零星小雨"],
  ["Light rain", "小雨"],
  ["Moderate rain", "中雨"],
  ["Heavy rain", "大雨"],
  ["Light drizzle", "小毛毛雨"],
  ["Thundery outbreaks in nearby", "附近有雷雨"],
  ["Patchy snow nearby", "附近有零星小雪"],
  ["Light snow", "小雪"],
]);

function localizeWttrDesc(value) {
  const text = compactLine(value);
  if (!text) return "";
  if (!isZhLocale()) return text;
  return WTTR_DESC_ZH.get(text) || text;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value) {
  return decodeHtml(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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

function extractXmlTag(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeHtml(match[1]) : "";
}

function extractSourceFromItemXml(xml) {
  const match = String(xml || "").match(/<source\s+url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/i);
  if (!match) return { name: "", url: "" };
  return {
    name: decodeHtml(match[2]),
    url: decodeHtml(match[1]),
  };
}

function isRecentPubDate(pubDate, maxAgeHours = 36) {
  const ts = Date.parse(pubDate || "");
  if (!Number.isFinite(ts)) return false;
  const ageMs = Date.now() - ts;
  return ageMs >= -60 * 60 * 1000 && ageMs <= maxAgeHours * 60 * 60 * 1000;
}

function buildNewsRssQuery(query) {
  const text = compactLine(query);
  const terms = [];
  const addIf = (pattern, term) => {
    if (pattern.test(text) && !terms.includes(term)) terms.push(term);
  };

  addIf(/AI|人工智能/i, "AI");
  addIf(/科技|技术/i, "科技");
  addIf(/大模型|模型|LLM/i, "大模型");
  addIf(/OpenAI/i, "OpenAI");
  addIf(/Anthropic|Claude/i, "Anthropic Claude");
  addIf(/Gemini|Google|谷歌/i, "Google Gemini");
  addIf(/芯片|半导体|算力|GPU/i, "AI 芯片");
  addIf(/机器人|具身/i, "机器人");
  addIf(/美伊|伊朗|中东/i, "美伊 中东");
  addIf(/俄乌|俄罗斯|乌克兰/i, "俄乌");
  addIf(/关税|制裁/i, "关税 制裁");
  addIf(/股市|市场|财经/i, "市场");

  if (terms.length) return terms.join(" ");
  return text
    .replace(/(?:请|帮我|给我|查询|搜索|今天|今日|最新|实时|消息|新闻|报道|每条|包含|发生日期|来源链接|为什么重要|领域|重要|条|[0-9０-９]+)/g, " ")
    .replace(/[，。、“”‘’：:；;,.!?？/\\|()[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "今日 热点";
}

async function fetchGoogleNewsRss(query, maxResults = SEARCH_LIMIT) {
  const timer = timeoutSignal(NEWS_RSS_TIMEOUT_MS);
  try {
    const rawQuery = buildNewsRssQuery(query) || "科技 AI";
    const rssQuery = /\bwhen:\d+d\b/i.test(rawQuery) ? rawQuery : `${rawQuery} when:1d`;
    const params = new URLSearchParams({
      q: rssQuery,
      hl: "zh-CN",
      gl: "CN",
      ceid: "CN:zh-Hans",
    });
    const url = `https://news.google.com/rss/search?${params.toString()}`;
    const resp = await fetch(url, {
      signal: timer.signal,
      headers: { "User-Agent": "Lynn/LiveNewsRSS" },
    });
    if (!resp.ok) throw new Error(`Google News RSS ${resp.status}`);
    const xml = await resp.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
      .map((match) => {
        const itemXml = match[1] || "";
        const source = extractSourceFromItemXml(itemXml);
        const title = stripHtml(extractXmlTag(itemXml, "title"));
        const link = decodeHtml(extractXmlTag(itemXml, "link"));
        const pubDate = decodeHtml(extractXmlTag(itemXml, "pubDate"));
        const snippet = stripHtml(extractXmlTag(itemXml, "description"));
        return {
          title,
          url: link,
          snippet,
          pubDate,
          source: source.name,
          sourceUrl: source.url,
        };
      })
      .filter((item) => item.title && item.url && isRecentPubDate(item.pubDate));
    return items.slice(0, maxResults);
  } finally {
    timer.clear();
  }
}

function formatSearchResults(title, query, provider, results) {
  const rows = results.map((result, index) => {
    const host = hostname(result.url);
    return [
      `${index + 1}. ${result.title || result.url}`,
      host ? `${zhOrEn("来源", "Source")}: ${host}` : "",
      result.url,
      result.snippet ? `- ${compactLine(result.snippet)}` : "",
      result.fetchedText ? `- ${zhOrEn("正文摘录", "Fetched excerpt")}: ${compactLine(result.fetchedText).slice(0, 520)}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return [
    `${title} (${provider})`,
    `${zhOrEn("查询", "Query")}: ${query}`,
    "",
    rows,
  ].join("\n");
}

function formatNewsRssResults(query, results) {
  const rows = results.map((result, index) => {
    const published = result.pubDate ? new Date(result.pubDate).toISOString().replace("T", " ").replace(".000Z", " UTC") : "";
    return [
      `${index + 1}. ${result.title}`,
      result.source ? `${zhOrEn("来源", "Source")}: ${result.source}` : "",
      result.sourceUrl ? `${zhOrEn("来源站点", "Source site")}: ${result.sourceUrl}` : "",
      result.url,
      published ? `${zhOrEn("发布时间", "Published")}: ${published}` : "",
      result.snippet ? `- ${compactLine(result.snippet)}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return [
    `${zhOrEn("实时新闻结果", "Live news results")} (google-news-rss)`,
    `${zhOrEn("查询", "Query")}: ${query}`,
    zhOrEn(
      "日期校验：这里只列出 RSS 发布时间在最近 36 小时内的候选。回答“今日/最新”时必须引用这里的发布时间；如果没有足够证据，不要使用旧年份链接冒充今日新闻。",
      "Freshness check: candidates here have RSS pubDate within the last 36 hours. For today/latest answers, cite these timestamps; if evidence is insufficient, do not use stale links as today's news.",
    ),
    "",
    rows,
  ].join("\n");
}

async function searchAndFetch(query, sceneHint, maxResults = SEARCH_LIMIT) {
  const searchResult = await runSearchQuery(query, maxResults, { sceneHint }) || {};
  const { results = [], provider = "", plan = null } = searchResult;
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

function localDateQueryText() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}年${month}月${day}日`;
}

function buildSupplementalNewsQueries(query) {
  const raw = compactLine(query);
  const core = raw
    .replace(/(?:请|帮我|查一下|查查|搜索|查询|全网|今天|今日|最新|新闻|有什么|哪些|一下)/g, " ")
    .replace(/\s+/g, " ")
    .trim() || raw;
  const dateText = localDateQueryText();
  const queries = [
    `${raw} 今日 最新 消息 新闻`,
    `${core} ${dateText} 最新 新闻`,
  ];
  if (/干细胞|细胞治疗|再生医学|临床|医疗|医药|医院|药企/.test(raw)) {
    queries.push(`${core} 临床研究 产业 政策 进展 最新`);
  } else if (/AI|人工智能|大模型|模型|芯片|半导体|机器人/i.test(raw)) {
    queries.push(`${core} 行业 公司 产品 发布 最新`);
  } else {
    queries.push(`${core} 进展 影响 来源 最新`);
  }
  return [...new Set(queries.map(compactLine).filter(Boolean))].slice(0, 3);
}

function mergeSearchResults(groups, maxResults = SEARCH_LIMIT) {
  const merged = [];
  const seen = new Set();
  for (const group of groups || []) {
    for (const item of group?.results || []) {
      const key = item.url || item.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= maxResults) return merged;
    }
  }
  return merged;
}

function cleanWeatherLocationCandidate(value) {
  const normalized = normalizeWeatherLocationToken(value)
    .replace(/^(?:查|查询|看看|看下|帮我|请问|麻烦|告诉我|给我)/, "")
    .replace(/(?:今天|今日|明天|后天|今晚|明早|未来\d*天|天气|气温|温度|预报|如何|怎么样|会不会|是否|有没有|下雨|降雨|降水|多少度|几度|区间|概率)+/g, "")
    .replace(/(?:呢|吗)$/g, "")
    .replace(/[，,。？?、:：；;]/g, "")
    .replace(/(?:给|和)+$/g, "")
    .trim();
  if (!normalized) return "";
  if (/^(?:温度|气温|区间|概率|降雨|降水|天气|预报|今天|明天|后天|给|和)$/.test(normalized)) return "";
  return normalized;
}

export function extractWeatherLocation(query, location) {
  const explicit = normalizeWeatherLocationToken(location);
  if (explicit) return explicit;
  const text = compactLine(query);
  const rainOrTempMatch = text.match(/(?:今天|今日|明天|后天|今晚|明早)?\s*([\u4e00-\u9fa5A-Za-z .-]{2,16}?)(?:今天|今日|明天|后天|今晚|明早)?(?:会不会|是否|有没有)?(?:下雨|降雨|降水|温度|气温|多少度|几度)/);
  if (rainOrTempMatch?.[1]) {
    const normalized = cleanWeatherLocationCandidate(rainOrTempMatch[1]);
    if (normalized) return normalized;
  }
  const match = text.match(/(?:明天|今天|后天|未来\d*天|未来)?\s*([\u4e00-\u9fa5A-Za-z .-]{2,32}?)(?:的)?(?:天气|气温|预报)/);
  if (match?.[1]) {
    const normalized = cleanWeatherLocationCandidate(match[1]);
    if (normalized) return normalized;
  }
  return cleanWeatherLocationCandidate(text) || "深圳";
}

async function fetchOpenMeteoWeather(location) {
  const safeLocation = compactLine(location) || "深圳";
  const geoTimer = timeoutSignal(5000);
  let geo;
  try {
    const params = new URLSearchParams({
      name: safeLocation,
      count: "1",
      language: "zh",
      format: "json",
    });
    const resp = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`, {
      signal: geoTimer.signal,
      headers: { "User-Agent": "Lynn/OpenMeteoWeather" },
    });
    if (!resp.ok) throw new Error(`open-meteo geocode ${resp.status}`);
    const data = await resp.json();
    geo = data.results?.[0];
    if (!geo?.latitude || !geo?.longitude) throw new Error("open-meteo geocode empty");
  } finally {
    geoTimer.clear();
  }

  const weatherTimer = timeoutSignal(7000);
  try {
    const params = new URLSearchParams({
      latitude: String(geo.latitude),
      longitude: String(geo.longitude),
      current: "temperature_2m,relative_humidity_2m,precipitation,rain,weather_code,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      timezone: geo.timezone || "Asia/Shanghai",
      forecast_days: "3",
    });
    const resp = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
      signal: weatherTimer.signal,
      headers: { "User-Agent": "Lynn/OpenMeteoWeather" },
    });
    if (!resp.ok) throw new Error(`open-meteo forecast ${resp.status}`);
    const data = await resp.json();
    const areaName = [geo.name, geo.admin1].filter(Boolean).join(" · ");
    const current = data.current || {};
    const now = [
      `${areaName || safeLocation} ${zhOrEn("当前天气", "current weather")}`,
      Number.isFinite(Number(current.weather_code)) ? `- ${zhOrEn("天气", "Weather")}: ${weatherCodeText(current.weather_code)}` : "",
      Number.isFinite(Number(current.temperature_2m)) ? `- ${zhOrEn("温度", "Temperature")}: ${current.temperature_2m}°C` : "",
      Number.isFinite(Number(current.relative_humidity_2m)) ? `- ${zhOrEn("湿度", "Humidity")}: ${current.relative_humidity_2m}%` : "",
      Number.isFinite(Number(current.wind_speed_10m)) ? `- ${zhOrEn("风速", "Wind")}: ${current.wind_speed_10m} km/h` : "",
      Number.isFinite(Number(current.precipitation)) ? `- ${zhOrEn("降水", "Rain")}: ${current.precipitation} mm` : "",
    ].filter(Boolean).join("\n");
    const daily = data.daily || {};
    const forecast = (daily.time || []).slice(0, 3).map((date, index) => {
      const desc = weatherCodeText(daily.weather_code?.[index]);
      const min = daily.temperature_2m_min?.[index] ?? "?";
      const max = daily.temperature_2m_max?.[index] ?? "?";
      const pop = daily.precipitation_probability_max?.[index];
      return `- ${date}: ${desc} ${min}~${max}°C${Number.isFinite(Number(pop)) ? ` 降雨概率 ${pop}%` : ""}`;
    }).join("\n");
    return [now, forecast ? `\n${zhOrEn("未来三天", "Next days")}\n${forecast}` : ""].filter(Boolean).join("\n");
  } finally {
    weatherTimer.clear();
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
    const rawAreaName = area.areaName?.[0]?.value || safeLocation;
    const areaName = /[\u4e00-\u9fa5]/.test(safeLocation) ? safeLocation : rawAreaName;
    const currentDesc = localizeWttrDesc(current.weatherDesc?.[0]?.value);
    const now = [
      `${areaName} ${zhOrEn("当前天气", "current weather")}`,
      currentDesc ? `- ${zhOrEn("天气", "Weather")}: ${currentDesc}` : "",
      current.temp_C ? `- ${zhOrEn("温度", "Temperature")}: ${current.temp_C}°C` : "",
      current.FeelsLikeC ? `- ${zhOrEn("体感", "Feels like")}: ${current.FeelsLikeC}°C` : "",
      current.humidity ? `- ${zhOrEn("湿度", "Humidity")}: ${current.humidity}%` : "",
      current.windspeedKmph ? `- ${zhOrEn("风速", "Wind")}: ${current.windspeedKmph} km/h` : "",
      current.precipMM ? `- ${zhOrEn("降水", "Rain")}: ${current.precipMM} mm` : "",
    ].filter(Boolean).join("\n");

    const forecast = (data.weather || []).slice(0, 3).map((day) => {
      const hourly = day.hourly?.[4] || day.hourly?.[0] || {};
      const desc = localizeWttrDesc(hourly.weatherDesc?.[0]?.value) || "";
      return `- ${day.date}: ${desc || zhOrEn("天气数据可用", "weather data available")} ${day.mintempC || "?"}~${day.maxtempC || "?"}°C`;
    }).join("\n");

    return [now, forecast ? `\n${zhOrEn("未来三天", "Next days")}\n${forecast}` : ""].filter(Boolean).join("\n");
  } finally {
    timer.clear();
  }
}

function buildWeatherEvidence(provider, location, text, extra = {}) {
  const firstLine = compactLine(String(text || "").split(/\n/).find(Boolean) || "");
  return [{
    type: "weather",
    kind: "weather",
    label: location || "",
    value: firstLine,
    timestamp: new Date().toISOString(),
    source: provider || "",
    location: location || "",
    fallback: !!extra.fallback,
    error: extra.error || "",
  }].filter((item) => item.value || item.source);
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
          details: {
            provider: "wttr.in",
            location,
            evidence: buildWeatherEvidence("wttr.in", location, text),
          },
        };
      } catch (err) {
        try {
          const text = await fetchOpenMeteoWeather(location);
          return {
            content: [{ type: "text", text }],
            details: {
              provider: "open-meteo",
              location,
              fallback: true,
              error: err.message,
              evidence: buildWeatherEvidence("open-meteo", location, text, { fallback: true, error: err.message }),
            },
          };
        } catch (openMeteoErr) {
        const fallbackQuery = `${location || query} 天气 预报`;
        const { provider, results } = await searchAndFetch(fallbackQuery, "weather", 4);
        const text = formatSearchResults(zhOrEn("天气搜索结果", "Weather search results"), fallbackQuery, provider, results);
        return {
          content: [{
            type: "text",
            text,
          }],
          details: {
            provider,
            location,
            fallback: true,
            error: `${err.message}; ${openMeteoErr.message}`,
            evidence: buildWeatherEvidence(provider, location, text, {
              fallback: true,
              error: `${err.message}; ${openMeteoErr.message}`,
            }),
          },
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
      const maxResults = params.maxResults || SEARCH_LIMIT;
      const rssPromise = fetchGoogleNewsRss(searchQuery, maxResults).catch(() => []);
      const supplementalQueries = buildSupplementalNewsQueries(query);
      const searchPromises = supplementalQueries.map((item) => searchAndFetch(item, "realtime", Math.max(3, Math.ceil(maxResults / 2))).catch(() => null));
      const [rssResults, ...searchGroups] = await Promise.all([rssPromise, ...searchPromises]);
      const provider = searchGroups.find(Boolean)?.provider || "";
      const results = mergeSearchResults(searchGroups.filter(Boolean), maxResults);
      const sections = [];
      if (rssResults.length) sections.push(formatNewsRssResults(searchQuery, rssResults));
      if (results.length) {
        sections.push(formatSearchResults(
          rssResults.length ? zhOrEn("补充全网搜索结果", "Supplemental web news results") : zhOrEn("实时新闻结果", "Live news results"),
          supplementalQueries.join(" / "),
          provider || "search",
          results,
        ));
      }
      if (!sections.length) {
        sections.push(formatSearchResults(zhOrEn("实时新闻结果", "Live news results"), searchQuery, provider || "search", []));
      }
      sections.push(rssResults.length
        ? zhOrEn(
          "\n日期校验：RSS 候选带有发布时间；补充搜索结果用于扩展视野，仍建议打开原文核验是否为今日最新。",
          "\nFreshness check: RSS candidates include timestamps; supplemental web results broaden coverage and should still be opened to verify freshness.",
        )
        : zhOrEn(
          "\n日期校验：Google News RSS 未返回最近 36 小时内的明确候选；以上普通搜索结果不保证是今日新闻。回答时必须说明“无法确认今日最新”，不要把旧结果当作今日新闻。",
          "\nFreshness check: Google News RSS returned no clear candidates within the last 36 hours. These plain search results are not guaranteed to be today's news. State that latest news could not be confirmed; do not present stale results as today's news.",
        ));
      return {
        content: [{
          type: "text",
          text: sections.join("\n\n"),
        }],
        details: { provider: rssResults.length ? "google-news-rss+search" : provider, query: searchQuery, supplementalQueries },
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
