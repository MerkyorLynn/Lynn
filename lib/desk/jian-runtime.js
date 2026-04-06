import fs from "fs";
import path from "path";

const ZH_RECENT_HEADING = "## 最近执行";
const EN_RECENT_HEADING = "## Recent activity";

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isZhLocale(locale) {
  return !locale || String(locale).startsWith("zh");
}

function pad(num) {
  return String(num).padStart(2, "0");
}

function formatStamp(at, locale) {
  const date = at instanceof Date ? at : new Date(at || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  if (isZhLocale(locale)) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildRecurringTaskMarker(task, locale = "zh") {
  const nextRun = formatStamp(task?.nextRunAt, locale);
  if (isZhLocale(locale)) {
    return nextRun ? `⏰ 自动任务 · 下次 ${nextRun}` : "⏰ 已设定";
  }
  return nextRun ? `⏰ automation · next ${nextRun}` : "⏰ scheduled";
}

function stripTodoPrefix(line) {
  return String(line || "").replace(/^- \[[ xX]\]\s+/, "").trim();
}

function normalizeHourMinute(hour, minute, period = "") {
  let h = parseInt(String(hour || "9"), 10);
  let m = parseInt(String(minute || "0"), 10);
  if (Number.isNaN(h)) h = 9;
  if (Number.isNaN(m)) m = 0;
  const periodText = String(period || "").trim();
  if (/(下午|晚上)/.test(periodText) && h < 12) h += 12;
  if (/中午/.test(periodText) && h < 11) h += 12;
  if (/凌晨/.test(periodText) && h === 12) h = 0;
  h = Math.max(0, Math.min(23, h));
  m = Math.max(0, Math.min(59, m));
  return { hour: h, minute: m };
}

function buildCron(hour, minute, days = []) {
  const uniqueDays = Array.from(new Set(days)).sort((a, b) => a - b);
  const dow = uniqueDays.length === 0 ? "*" : uniqueDays.join(",");
  return `${minute} ${hour} * * ${dow}`;
}

function parseZhRecurring(line) {
  const body = stripTodoPrefix(line);
  if (!body || body.includes("⏰")) return null;

  const daily = body.match(/^(每天)(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})\s*(?:[:：](\d{1,2})|点(?:\s*(\d{1,2})分?)?)\s*(.+)$/);
  if (daily) {
    const { hour, minute } = normalizeHourMinute(daily[3], daily[4] || daily[5], daily[2]);
    return {
      schedule: buildCron(hour, minute),
      taskText: daily[6].trim(),
      rawTask: body,
      mode: "daily",
    };
  }

  const weekdays = body.match(/^(工作日|每个工作日)(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})\s*(?:[:：](\d{1,2})|点(?:\s*(\d{1,2})分?)?)\s*(.+)$/);
  if (weekdays) {
    const { hour, minute } = normalizeHourMinute(weekdays[3], weekdays[4] || weekdays[5], weekdays[2]);
    return {
      schedule: buildCron(hour, minute, [1, 2, 3, 4, 5]),
      taskText: weekdays[6].trim(),
      rawTask: body,
      mode: "weekdays",
    };
  }

  const zhDayMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  const weekly = body.match(/^每周([一二三四五六日天])(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})\s*(?:[:：](\d{1,2})|点(?:\s*(\d{1,2})分?)?)\s*(.+)$/);
  if (weekly) {
    const { hour, minute } = normalizeHourMinute(weekly[3], weekly[4] || weekly[5], weekly[2]);
    return {
      schedule: buildCron(hour, minute, [zhDayMap[weekly[1]] ?? 1]),
      taskText: weekly[6].trim(),
      rawTask: body,
      mode: "weekly",
    };
  }

  return null;
}

function parseEnRecurring(line) {
  const body = stripTodoPrefix(line);
  if (!body || body.includes("⏰")) return null;

  const daily = body.match(/^every day(?: at)?\s+(\d{1,2})(?::(\d{2}))?\s+(.+)$/i);
  if (daily) {
    const { hour, minute } = normalizeHourMinute(daily[1], daily[2]);
    return {
      schedule: buildCron(hour, minute),
      taskText: daily[3].trim(),
      rawTask: body,
      mode: "daily",
    };
  }

  const weekdays = body.match(/^weekdays(?: at)?\s+(\d{1,2})(?::(\d{2}))?\s+(.+)$/i);
  if (weekdays) {
    const { hour, minute } = normalizeHourMinute(weekdays[1], weekdays[2]);
    return {
      schedule: buildCron(hour, minute, [1, 2, 3, 4, 5]),
      taskText: weekdays[3].trim(),
      rawTask: body,
      mode: "weekdays",
    };
  }

  const enDayMap = {
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
    sunday: 0,
  };
  const weekly = body.match(/^every (monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: at)?\s+(\d{1,2})(?::(\d{2}))?\s+(.+)$/i);
  if (weekly) {
    const { hour, minute } = normalizeHourMinute(weekly[2], weekly[3]);
    return {
      schedule: buildCron(hour, minute, [enDayMap[String(weekly[1]).toLowerCase()] ?? 1]),
      taskText: weekly[4].trim(),
      rawTask: body,
      mode: "weekly",
    };
  }

  return null;
}

export function extractRecurringJianTasks(content, locale = "zh") {
  const lines = String(content || "").split("\n");
  const isZh = isZhLocale(locale);
  const results = [];

  lines.forEach((line, index) => {
    if (!/^- \[ \] /.test(line.trim())) return;
    const parsed = isZh ? parseZhRecurring(line.trim()) : parseEnRecurring(line.trim());
    if (!parsed) return;
    const taskText = normalizeText(parsed.taskText || parsed.rawTask);
    if (!taskText) return;
    results.push({
      lineIndex: index,
      originalLine: line,
      schedule: parsed.schedule,
      taskText,
      rawTask: normalizeText(parsed.rawTask),
      mode: parsed.mode,
    });
  });

  return results;
}

export function applyRecurringTaskMarkers(content, tasks, locale = "zh") {
  const lines = String(content || "").split("\n");
  for (const task of tasks || []) {
    const idx = Number(task?.lineIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= lines.length) continue;
    const nextMarker = buildRecurringTaskMarker(task, locale);
    lines[idx] = `${lines[idx].replace(/\s+⏰.*$/u, "").trimEnd()} ${nextMarker}`;
  }
  return lines.join("\n");
}

export function upsertRecentExecutionSection(content, {
  summary,
  type = "heartbeat",
  label = "",
  at = Date.now(),
  locale = "zh",
  maxEntries = 6,
} = {}) {
  const cleanSummary = normalizeText(summary);
  if (!cleanSummary) return String(content || "");

  const heading = isZhLocale(locale) ? ZH_RECENT_HEADING : EN_RECENT_HEADING;
  const prefix = isZhLocale(locale)
    ? (type === "cron" ? "自动任务" : "巡检")
    : (type === "cron" ? "Automation" : "Patrol");
  const stamp = formatStamp(at, locale);
  const labelText = normalizeText(label);
  const entry = `- ${stamp} ${labelText ? `${labelText} · ` : ""}${prefix}：${cleanSummary}`.trim();

  const lines = String(content || "").replace(/\s+$/, "").split("\n");
  const headingIndex = lines.findIndex((line) => /^##\s+(最近执行|Recent activity)\s*$/.test(line.trim()));
  if (headingIndex === -1) {
    const base = String(content || "").replace(/\s+$/, "");
    return `${base}\n\n${heading}\n${entry}\n`;
  }

  let endIndex = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i].trim())) {
      endIndex = i;
      break;
    }
  }

  const existingEntries = lines
    .slice(headingIndex + 1, endIndex)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== entry && !line.includes(cleanSummary));

  const mergedEntries = [entry, ...existingEntries].slice(0, maxEntries);
  const rebuilt = [
    ...lines.slice(0, headingIndex),
    heading,
    ...mergedEntries,
    ...lines.slice(endIndex),
  ];
  return `${rebuilt.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function appendRecentExecutionToJian(dirPath, options = {}) {
  const jianPath = path.join(dirPath, "jian.md");
  if (!dirPath || !fs.existsSync(jianPath)) return false;
  const current = fs.readFileSync(jianPath, "utf-8");
  // 敏感信息打码后再写入
  const sanitizedOptions = {
    ...options,
    summary: options.summary ? maskSensitiveContent(options.summary) : options.summary,
  };
  const next = upsertRecentExecutionSection(current, sanitizedOptions);
  if (next === current) return false;
  fs.writeFileSync(jianPath, next, "utf-8");
  return true;
}

// ── 敏感信息打码 ──

const SENSITIVE_PATTERNS = [
  // API Keys
  /\b(sk-[a-zA-Z0-9]{20,})\b/g,
  /\b(key-[a-zA-Z0-9]{20,})\b/g,
  /\b(api[_-]?key\s*[:=]\s*)["']?([a-zA-Z0-9_\-]{20,})["']?/gi,
  // Bearer tokens
  /\b(Bearer\s+)([a-zA-Z0-9_\-\.]{20,})\b/gi,
  // Generic secrets
  /\b(secret\s*[:=]\s*)["']?([a-zA-Z0-9_\-]{16,})["']?/gi,
  /\b(password\s*[:=]\s*)["']?([^\s"']{8,})["']?/gi,
  /\b(token\s*[:=]\s*)["']?([a-zA-Z0-9_\-]{16,})["']?/gi,
  // AWS style
  /\b(AKIA[0-9A-Z]{16})\b/g,
  // Private key markers
  /(-----BEGIN\s+\w+\s+PRIVATE\s+KEY-----)/g,
];

export function maskSensitiveContent(text) {
  if (!text || typeof text !== "string") return text;
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    // Reset regex lastIndex
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match, ...groups) => {
      // For patterns with capture groups, mask the secret part
      if (groups.length >= 2 && typeof groups[1] === "string" && groups[1].length > 4) {
        return groups[0] + groups[1].slice(0, 4) + "****";
      }
      // For simple patterns, mask the whole match
      if (match.length > 8) {
        return match.slice(0, 4) + "****" + match.slice(-4);
      }
      return "****";
    });
  }
  return result;
}

// ── 执行去重 ──

const _recentExecHashes = new Map(); // hash → timestamp
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * 检查同一任务是否在 24h 内已执行过
 * @param {string} taskText - 任务文本
 * @returns {boolean} true = 已执行过，应跳过
 */
export function isDuplicateExecution(taskText) {
  const hash = normalizeText(taskText);
  const now = Date.now();
  // 清理过期条目
  for (const [k, ts] of _recentExecHashes) {
    if (now - ts > DEDUP_WINDOW_MS) _recentExecHashes.delete(k);
  }
  if (_recentExecHashes.has(hash)) return true;
  _recentExecHashes.set(hash, now);
  return false;
}
