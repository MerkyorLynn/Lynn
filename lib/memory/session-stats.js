/**
 * session-stats.js — Session 统计提取
 *
 * 从 session JSONL 文件中提取工具使用计数、语言偏好、活跃时段。
 * 纯解析，不调 LLM。
 */

import fs from "fs";

/**
 * 从 session JSONL 文件提取统计信息
 *
 * @param {string} sessionPath - session .jsonl 文件路径
 * @returns {{ toolUsage: Record<string, number>, languages: Record<string, number>, hour: number, turnCount: number } | null}
 */
export function extractSessionStats(sessionPath) {
  let raw;
  try {
    raw = fs.readFileSync(sessionPath, "utf-8");
  } catch {
    return null;
  }

  const toolUsage = {};   // toolName → count
  const languages = {};   // language → mention count
  let turnCount = 0;
  let lastHour = null;

  // 编程语言检测关键词
  const LANG_PATTERNS = [
    { re: /\b(?:typescript|\.tsx?)\b/i, lang: "TypeScript" },
    { re: /\b(?:javascript|\.jsx?)\b/i, lang: "JavaScript" },
    { re: /\b(?:python|\.py)\b/i, lang: "Python" },
    { re: /\b(?:rust|\.rs)\b/i, lang: "Rust" },
    { re: /\b(?:golang|\.go)\b/i, lang: "Go" },
    { re: /\bjava\b/i, lang: "Java" },
    { re: /\b(?:c\+\+|cpp|\.cpp)\b/i, lang: "C++" },
    { re: /\b(?:csharp|c#|\.cs)\b/i, lang: "C#" },
    { re: /\b(?:ruby|\.rb)\b/i, lang: "Ruby" },
    { re: /\b(?:php|\.php)\b/i, lang: "PHP" },
    { re: /\b(?:swift|\.swift)\b/i, lang: "Swift" },
    { re: /\b(?:kotlin|\.kt)\b/i, lang: "Kotlin" },
    { re: /\b(?:elixir|\.ex)\b/i, lang: "Elixir" },
    { re: /\b(?:dart|\.dart)\b/i, lang: "Dart" },
  ];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);

      // 统计用户消息轮数
      if (entry.type === "message" && entry.message?.role === "user") {
        turnCount++;

        // 提取时间（取最后一条的小时）
        if (entry.timestamp) {
          try {
            lastHour = new Date(entry.timestamp).getHours();
          } catch {}
        }

        // 从用户消息中检测语言提及
        const content = typeof entry.message.content === "string"
          ? entry.message.content
          : Array.isArray(entry.message.content)
            ? entry.message.content.filter(c => c.type === "text").map(c => c.text).join(" ")
            : "";

        for (const { re, lang } of LANG_PATTERNS) {
          if (re.test(content)) {
            languages[lang] = (languages[lang] || 0) + 1;
          }
        }
      }

      // 统计工具使用
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const content = entry.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use" && block.name) {
              toolUsage[block.name] = (toolUsage[block.name] || 0) + 1;
            }
          }
        }
      }
    } catch {
      // 跳过损坏行
    }
  }

  if (turnCount === 0) return null;

  return {
    toolUsage,
    languages,
    hour: lastHour,
    turnCount,
  };
}
