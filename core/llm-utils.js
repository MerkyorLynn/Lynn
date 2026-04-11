/**
 * LLM Utilities — 轻量 LLM 调用（标题摘要、翻译、ID 生成等）
 *
 * 纯函数模块，不持有状态。调用方传入 utilConfig（model/api_key/base_url）。
 * 从 Engine 提取，消除 5 处重复的 fetch 模式。
 */
import fs from "fs";
import path from "path";
import { callText } from "./llm-client.js";
import { getLocale } from "../server/i18n.js";
import {
  containsPseudoToolSimulation as containsSharedPseudoToolSimulation,
  stripPseudoToolCallMarkup,
} from "../shared/pseudo-tool-call.js";

/** Pi SDK content block 是否为工具调用（兼容 tool_use / toolCall 两种格式） */
export const isToolCallBlock = (b) => (b.type === "tool_use" || b.type === "toolCall") && !!b.name;

/** 取工具调用参数（兼容 input / arguments） */
export const getToolArgs = (b) => b.input || b.arguments;

export function containsPseudoToolCallSimulation(raw) {
  return containsSharedPseudoToolSimulation(raw);
}

export function sanitizeAssistantTextContent(raw) {
  return stripPseudoToolCallMarkup(raw)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 统一的 utility LLM 调用
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.api_key
 * @param {string} opts.base_url
 * @param {Array} opts.messages
 * @param {number} [opts.temperature=0.3]
 * @param {number} [opts.max_tokens=100]
 * @param {Array<{ model: string, api: string, api_key: string, base_url: string }>} [opts.fallbacks=[]]
 * @returns {Promise<string|null>} 回复文本
 */
async function callLlm({ model, api, api_key, base_url, messages, temperature = 0.3, max_tokens = 100, timeoutMs, signal, quirks, fallbacks = [] }) {
  const attempts = [{ model, api, api_key, base_url }, ...fallbacks]
    .filter((candidate) => candidate?.model && candidate?.api && candidate?.base_url);

  let lastError = null;
  for (const candidate of attempts) {
    try {
      return await callText({
        api: candidate.api,
        model: candidate.model,
        apiKey: candidate.api_key,
        baseUrl: candidate.base_url,
        messages,
        temperature,
        maxTokens: max_tokens,
        ...(timeoutMs != null && { timeoutMs }),
        ...(signal != null && { signal }),
        ...(quirks != null && { quirks }),
      });
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
    }
  }

  if (lastError) throw lastError;
  return null;
}

/**
 * 从 .jsonl session 文件提取 user/assistant 文本和工具调用
 */
function parseSessionContent(sessionPath, { userLimit = 1000, assistantLimit = 1000 } = {}) {
  const raw = fs.readFileSync(sessionPath, "utf-8");
  const lines = raw.trim().split("\n").map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  let userText = "";
  let assistantText = "";
  const toolCalls = [];
  for (const line of lines) {
    if (line.type !== "message" || !line.message) continue;
    const msg = line.message;
    if (msg.role === "user" && !userText) {
      const textParts = (msg.content || []).filter(c => c.type === "text");
      userText = textParts.map(c => c.text).join("\n").slice(0, userLimit);
    }
    if (msg.role === "assistant") {
      const textParts = (msg.content || []).filter(c => c.type === "text");
      assistantText = sanitizeAssistantTextContent(textParts.map(c => c.text).join("\n")).slice(0, assistantLimit);
      const toolParts = (msg.content || []).filter(isToolCallBlock);
      for (const t of toolParts) toolCalls.push(t.name || "unknown_tool");
    }
  }
  return { userText, assistantText, toolCalls };
}

/**
 * 从 session 内容生成本地兜底摘要（不依赖外部 API）
 */
export function buildLocalSummary(assistantText, toolCalls) {
  const isZh = getLocale().startsWith("zh");
  const uniqueTools = [...new Set(toolCalls)];
  if (uniqueTools.length > 0) {
    if (isZh) {
      return `执行了 ${uniqueTools.slice(0, 3).join("、")}${uniqueTools.length > 3 ? " 等" : ""}`;
    }
    return `Ran ${uniqueTools.slice(0, 3).join(", ")}${uniqueTools.length > 3 ? ", etc." : ""}`;
  }
  if (assistantText) {
    const clean = assistantText.replace(/[#*_`>\-[\]()]/g, "").trim();
    if (clean.length <= 50) return clean;
    return clean.slice(0, 47) + "...";
  }
  return null;
}

/**
 * 生成对话标题
 * @param {object} utilConfig - resolveUtilityConfig() 结果
 * @param {string} userText
 * @param {string} assistantText
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
 */
export async function summarizeTitle(utilConfig, userText, assistantText, opts = {}) {
  try {
    const isZh = getLocale().startsWith("zh");
    const { utility: model, api_key, base_url, api, utility_fallbacks = [] } = utilConfig;

    const systemContent = isZh
      ? `你是一个对话标题生成器。根据用户和助手的第一轮对话，用一句极短的话概括对话主题。

规则：
1. 标题长度严格控制在 10 个字以内（中文）或 5 个单词以内（英文）
2. 语言必须和用户说的第一句话一致：用户说中文就用中文，用户说英文就用英文
3. 不要加引号、句号或其他标点
4. 直接输出标题，不要解释`
      : `You are a conversation title generator. Based on the first exchange between user and assistant, summarize the topic in a very short phrase.

Rules:
1. Keep the title under 5 words (English) or 10 characters (Chinese)
2. The title language must match the user's first message
3. No quotes, periods, or other punctuation
4. Output the title directly, no explanation`;

    const userLabel = isZh ? "用户" : "User";
    const assistantLabel = isZh ? "助手" : "Assistant";

    return await callLlm({
      model,
      api,
      api_key,
      base_url,
      fallbacks: utility_fallbacks,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `${userLabel}：${(userText || "").slice(0, 500)}\n${assistantLabel}：${(assistantText || "").slice(0, 500)}`,
        },
      ],
      max_tokens: 50,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
  } catch (err) {
    // AbortError（超时）不算失败，静默返回 null 让调用方走 fallback
    if (err.name === "AbortError" || err.name === "TimeoutError" || err.code === "LLM_TIMEOUT") return null;
    console.error("[llm-utils] summarizeTitle failed:", err.message);
    return null;
  }
}

/**
 * 批量翻译技能名称
 */
export async function translateSkillNames(utilConfig, names, lang) {
  if (!names.length) return {};
  const LANG_LABEL = { zh: "中文", ja: "日本語", ko: "한국어" };
  const label = LANG_LABEL[lang] || lang;
  try {
    const { utility: model, api_key, base_url, api, utility_fallbacks = [] } = utilConfig;
    const isZh = getLocale().startsWith("zh");
    const text = await callLlm({
      model,
      api,
      api_key,
      base_url,
      fallbacks: utility_fallbacks,
      messages: [
        {
          role: "system",
          content: isZh
            ? `将下列 kebab-case 英文技能名翻译成简短的${label}名称（2-4 个字）。直接输出 JSON 对象，key 为原名，value 为翻译。不解释。`
            : `Translate the following kebab-case English skill names into short ${label} names (2-4 characters). Output a JSON object directly, key = original name, value = translation. No explanation.`,
        },
        { role: "user", content: JSON.stringify(names) },
      ],
      temperature: 0,
      max_tokens: 200,
    });
    if (!text) return {};
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch (err) {
    console.error("[llm-utils] translateSkillNames 失败:", err.message);
    return {};
  }
}

/**
 * 为活动 session 生成摘要（用 utility_large 模型）
 * @param {object} utilConfig - resolveUtilityConfig() 结果
 * @param {string} sessionPath
 * @param {(text: string, level?: string) => void} [emitDevLog]
 */
export async function summarizeActivity(utilConfig, sessionPath, emitDevLog) {
  const log = emitDevLog || (() => {});
  const isZh = getLocale().startsWith("zh");
  try {
    const { userText, assistantText, toolCalls } = parseSessionContent(sessionPath);
    if (!userText && !assistantText) {
      log("[summarize] session empty, skipping");
      return null;
    }

    const toolInfo = toolCalls.length > 0
      ? (isZh
          ? `\n\n调用的工具：${[...new Set(toolCalls)].join("、")}`
          : `\n\nTools used: ${[...new Set(toolCalls)].join(", ")}`)
      : "";
    const {
      utility_large: model,
      large_api_key: api_key,
      large_base_url: base_url,
      large_api: api,
      utility_large_allow_missing_api_key = false,
      utility_large_fallbacks = [],
    } = utilConfig;
    if ((!api_key && !utility_large_allow_missing_api_key) || !base_url || !api) {
      log("[summarize] utility_large config incomplete, skipping");
      return null;
    }

    const systemContent = isZh
      ? `你是一个执行摘要生成器。根据 Agent 的巡检上下文、执行结果和使用的工具，概括它做了什么。

规则：
1. 用中文，50 字以内
2. 直接输出摘要，不要前缀、不要解释
3. 说清楚做了什么具体动作（拆解待办、搜索信息、标记完成、读取文件等）
4. 如果调用了工具，提一下工具名称和做了什么
5. 如果 Agent 回复了「一切正常」或没有执行动作，就说「巡检完毕，一切正常」`
      : `You are an execution summary generator. Based on the Agent's patrol context, execution results, and tools used, summarize what it did.

Rules:
1. In English, under 30 words
2. Output the summary directly, no prefix or explanation
3. Be specific about what actions were taken (broke down tasks, searched info, marked complete, read files, etc.)
4. If tools were called, mention the tool names and what they did
5. If the Agent reported "all clear" or took no action, say "Patrol complete, all clear"`;

    const contextLabel = isZh ? "巡检上下文" : "Patrol context";
    const replyLabel = isZh ? "Agent 回复" : "Agent reply";

    const text = await callLlm({
      model,
      api,
      api_key,
      base_url,
      fallbacks: utility_large_fallbacks,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `${contextLabel}：\n${userText.slice(0, 600)}\n\n${replyLabel}：\n${assistantText.slice(0, 600)}${toolInfo}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 150,
    });

    return text;
  } catch (err) {
    log(`[summarize] error: ${err.message}`);
    console.error("[llm-utils] summarizeActivity failed:", err.message);
    return null;
  }
}

/**
 * 快速摘要（用 utility 小模型）
 * @param {object} utilConfig
 * @param {string} sessionPath - activity session 文件绝对路径
 */
export async function summarizeActivityQuick(utilConfig, sessionPath) {
  if (!fs.existsSync(sessionPath)) return null;
  const isZh = getLocale().startsWith("zh");
  try {
    const { userText, assistantText } = parseSessionContent(sessionPath, {
      userLimit: 800, assistantLimit: 800,
    });
    if (!userText && !assistantText) return null;

    const { utility: model, api_key, base_url, api, utility_fallbacks = [] } = utilConfig;

    const systemContent = isZh
      ? `根据 Agent 的巡检上下文和执行结果，用一两句话概括它做了什么。30 字以内，中文，直接输出。`
      : `Based on the Agent's patrol context and execution results, summarize what it did in one or two sentences. Under 15 words, English, output directly.`;

    const contextLabel = isZh ? "巡检上下文" : "Patrol context";
    const replyLabel = isZh ? "Agent 回复" : "Agent reply";

    return await callLlm({
      model,
      api,
      api_key,
      base_url,
      fallbacks: utility_fallbacks,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `${contextLabel}：\n${userText.slice(0, 400)}\n\n${replyLabel}：\n${assistantText.slice(0, 400)}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 80,
    });
  } catch (err) {
    console.error("[llm-utils] summarizeActivityQuick failed:", err.message);
    return null;
  }
}

/**
 * 为自动接力生成 session 摘要（更完整，供下一个 session 继承）
 * @param {object} utilConfig
 * @param {string} sessionPath
 * @param {object} [opts]
 * @param {number} [opts.maxTokens=800]
 */
export async function summarizeSessionRelay(utilConfig, sessionPath, opts = {}) {
  if (!fs.existsSync(sessionPath)) return null;
  const isZh = getLocale().startsWith("zh");
  const maxTokens = Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : 800;

  try {
    const { userText, assistantText, toolCallsText } = parseSessionContent(sessionPath, {
      userLimit: 2400,
      assistantLimit: 3200,
      includeToolCalls: true,
    });
    if (!userText && !assistantText && !toolCallsText) return null;

    const { utility_large, api_key, base_url, api, utility_large_fallbacks = [] } = utilConfig;
    const systemContent = isZh
      ? `请把一段已经运行很久的助手对话压缩成可接力的工作摘要，供新会话继续执行。

要求：
1. 重点保留：用户目标、已完成事项、关键结论、未完成待办、重要文件/路径、失败点与注意事项。
2. 使用简洁中文要点，不要寒暄，不要复述无关过程。
3. 如果没有某一类信息，就省略，不要编造。
4. 控制在 ${maxTokens} token 以内。`
      : `Compress a long-running assistant conversation into a continuation-ready handoff summary for a new session.

Requirements:
1. Preserve user goals, completed work, key conclusions, remaining TODOs, important files/paths, failure points, and cautions.
2. Use concise bullet points.
3. Omit missing categories instead of inventing them.
4. Keep it within ${maxTokens} tokens.`;

    return await callLlm({
      model: utility_large,
      api,
      api_key,
      base_url,
      fallbacks: utility_large_fallbacks,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: [
            userText ? `${isZh ? "用户消息" : "User messages"}:\n${userText}` : "",
            assistantText ? `${isZh ? "助手回复" : "Assistant replies"}:\n${assistantText}` : "",
            toolCallsText ? `${isZh ? "工具轨迹" : "Tool trace"}:\n${toolCallsText}` : "",
          ].filter(Boolean).join("\n\n"),
        },
      ],
      temperature: 0.2,
      max_tokens: Math.max(256, Math.min(maxTokens, 1200)),
    });
  } catch (err) {
    console.error("[llm-utils] summarizeSessionRelay failed:", err.message);
    return null;
  }
}

/**
 * 用 LLM 根据显示名生成 agent ID
 * @param {object} utilConfig
 * @param {string} name - 显示名
 * @param {string} agentsDir - agents 根目录（检查冲突）
 */
export async function generateAgentId(utilConfig, name, agentsDir) {
  try {
    const isZh = getLocale().startsWith("zh");
    const { utility: model, api_key, base_url, api, utility_fallbacks = [] } = utilConfig;
    const text = await callLlm({
      model, api, api_key, base_url,
      fallbacks: utility_fallbacks,
      messages: [
        {
          role: "system",
          content: isZh
            ? `根据给定的助手名字，生成一个简短的英文小写 ID（用于文件夹名）。
规则：
1. 纯小写英文字母，可以用连字符
2. 2~12 个字符
3. 尽量是名字的英文音译或缩写
4. 直接输出 ID，不要解释

示例：
- "花子" → "hanako"
- "ミク" → "miku"
- "小助手" → "helper"
- "Alice" → "alice"`
            : `Given an assistant's display name, generate a short lowercase English ID (for use as a folder name).
Rules:
1. Lowercase English letters only, hyphens allowed
2. 2–12 characters
3. Prefer a transliteration or abbreviation of the name
4. Output the ID directly, no explanation

Examples:
- "花子" → "hanako"
- "ミク" → "miku"
- "Helper" → "helper"
- "Alice" → "alice"`,
        },
        { role: "user", content: name },
      ],
      max_tokens: 20,
    });

    if (text) {
      const id = text.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 12);
      if (id.length >= 2 && !fs.existsSync(path.join(agentsDir, id))) {
        return id;
      }
    }
  } catch (err) {
    console.error("[llm-utils] generateAgentId LLM failed:", err.message);
  }
  return `agent-${Date.now().toString(36)}`;
}
