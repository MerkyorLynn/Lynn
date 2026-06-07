import fs from "fs";
import { debugLog } from "../../lib/debug-log.js";
import { TOOL_USE_BEHAVIOR } from "./tool-use-behavior.js";
import { persistedChatMessageText } from "./session-persistence.js";

interface LocalQwen35BridgeOptions {
  isLocalModel?: boolean;
  hasImages?: boolean;
  rehydratedMutation?: boolean;
  toolBehavior?: string;
  reason?: string;
  routeIntent?: string;
}

interface ThinkingEngineLike {
  getThinkingLevel?: () => unknown;
  preferences?: { getThinkingLevel?: () => unknown };
}

export interface LocalQwen35Message {
  role: "user" | "assistant";
  content: string;
}

interface LocalQwen35RetryInput {
  enableThinking?: boolean;
  assistantText?: unknown;
  reasoningText?: unknown;
}

export const LOCAL_QWEN35_DIRECT_MAX_CHARS = Number(process.env.LYNN_LOCAL_QWEN35_DIRECT_MAX_CHARS || 8000);
export const LOCAL_QWEN35_DIRECT_ENDPOINT = process.env.LYNN_LOCAL_QWEN35_ENDPOINT || "http://127.0.0.1:18099/v1/chat/completions";
export const LOCAL_QWEN35_DIRECT_MAX_TOKENS = Number(process.env.LYNN_LOCAL_QWEN35_DIRECT_MAX_TOKENS || 8192);
export const LOCAL_QWEN35_DIRECT_PREFETCH_MAX_TOKENS = Number(process.env.LYNN_LOCAL_QWEN35_DIRECT_PREFETCH_MAX_TOKENS || 2048);
export const LOCAL_QWEN35_DIRECT_HISTORY_MAX_MESSAGES = Number(process.env.LYNN_LOCAL_QWEN35_HISTORY_MAX_MESSAGES || 8);
export const LOCAL_QWEN35_DIRECT_HISTORY_MAX_CHARS = Number(process.env.LYNN_LOCAL_QWEN35_HISTORY_MAX_CHARS || 8000);
export const LOCAL_QWEN35_TOOL_SCHEMA_LIMIT = Math.max(
  3,
  Math.min(5, Number(process.env.LYNN_LOCAL_QWEN35_TOOL_SCHEMA_LIMIT || 5)),
);
export const LOCAL_QWEN35_FAILURE_FALLBACK_PROVIDER = process.env.LYNN_LOCAL_QWEN35_FAILURE_FALLBACK_PROVIDER || "step-3.7-flash";
export const LOCAL_QWEN35_RUNTIME_POLICY = Object.freeze({
  role: "explicit_opt_in_local_9b",
  kvCacheReuse: true,
  warmPoolDefault: false,
  idleUnload: true,
  stablePrefix: true,
  maxPromptChars: LOCAL_QWEN35_DIRECT_MAX_CHARS,
  maxHistoryMessages: LOCAL_QWEN35_DIRECT_HISTORY_MAX_MESSAGES,
  maxHistoryChars: LOCAL_QWEN35_DIRECT_HISTORY_MAX_CHARS,
  toolSchemaLimit: LOCAL_QWEN35_TOOL_SCHEMA_LIMIT,
  footerDecodeTps: true,
  failureFallbackProvider: LOCAL_QWEN35_FAILURE_FALLBACK_PROVIDER,
});
export const LOCAL_QWEN35_EMPTY_CONTENT_FALLBACK_MESSAGE = "本地模型这次只输出了思考过程,没有返回可见正文。已保留思考记录;请关闭深研重试,或临时切到默认云端模型。";

export function shouldUseLocalQwen35DirectBridge(promptText: unknown = "", opts: LocalQwen35BridgeOptions = {}): boolean {
  if (!opts.isLocalModel) return false;
  if (opts.hasImages) return false;
  if (opts.rehydratedMutation) return false;
  if (opts.toolBehavior && opts.toolBehavior !== TOOL_USE_BEHAVIOR.RUN_LLM_AGAIN) return false;
  const text = String(promptText || "").trim();
  if (!text || text.length > LOCAL_QWEN35_DIRECT_MAX_CHARS) return false;
  return true;
}

export function normalizeThinkingLevel(level: unknown): string {
  return String(level || "auto").trim().toLowerCase();
}

export function isTinyLocalQwen35Ask(promptText: unknown = ""): boolean {
  const text = String(promptText || "").trim();
  if (!text) return false;
  const compact = text.replace(/\s+/g, "");
  if (compact.length <= 24 && /^(?:hi|hello|hey|yo|ping|test|ok|在吗|在不在|你好|您好|哈喽|嗨|嗯|好的)[。！？!?.,，、~～]*$/iu.test(compact)) {
    return true;
  }
  if (compact.length <= 80 && /(?:门禁测试|只(?:回复|输出)|请(?:只|直接)(?:回复|输出)|回复ok|输出ok)/iu.test(compact)) {
    return true;
  }
  return false;
}

export function isLightweightLocalQwen35Ask(promptText: unknown = ""): boolean {
  if (isTinyLocalQwen35Ask(promptText)) return true;
  const text = String(promptText || "").trim();
  if (!text || text.length > 260) return false;
  if (/(?:深度|深入|详细|推理|证明|分析|代码|方案|计划|报告|长文|论文|复杂|逐步|step by step)/iu.test(text)) return false;
  return /(?:介绍你|你能帮我|你能做什么|你是谁|已准备好|请记住|只(?:回复|输出)|不要调用工具|不用工具|不调用工具|80\s*字以内|一句中文|一句话|项目代号|最后一行不能有其他字)/iu.test(text);
}

export function resolveLocalQwen35DirectThinking(promptText: unknown = "", engineLike: ThinkingEngineLike | null = null): boolean {
  const rawLevel = typeof engineLike?.getThinkingLevel === "function"
    ? engineLike.getThinkingLevel()
    : engineLike?.preferences?.getThinkingLevel?.();
  const level = normalizeThinkingLevel(rawLevel);
  if (["off", "none", "minimal"].includes(level)) return false;
  if (isLightweightLocalQwen35Ask(promptText)) return false;
  if (["high", "xhigh", "max"].includes(level)) return true;
  return true;
}

export function resolveLocalQwen35DirectMaxTokens(promptText: unknown = "", enableThinking: boolean = true): number {
  if (!enableThinking) {
    if (isTinyLocalQwen35Ask(promptText)) return 256;
    if (isLightweightLocalQwen35Ask(promptText)) return 1536;
  }
  return LOCAL_QWEN35_DIRECT_MAX_TOKENS;
}

export function shouldRetryLocalQwen35WithoutThinking(input: LocalQwen35RetryInput = {}): boolean {
  const { enableThinking = false, assistantText = "", reasoningText = "" } = input;
  return !!enableThinking
    && !String(assistantText || "").trim()
    && !!String(reasoningText || "").trim();
}

export function readRecentLocalQwen35DirectMessages(sessionPath: string | null | undefined, currentPromptText: unknown = ""): LocalQwen35Message[] {
  if (!sessionPath || !fs.existsSync(sessionPath)) return [];
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    const messages: LocalQwen35Message[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: { type?: string; message?: { role?: string; content?: unknown } } | null = null;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== "message") continue;
      const role = entry?.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = persistedChatMessageText(entry.message).trim();
      if (!text) continue;
      messages.push({ role: role as "user" | "assistant", content: text });
    }

    const current = String(currentPromptText || "").trim();
    while (messages.length && messages.at(-1)?.role === "user" && messages.at(-1)?.content.trim() === current) {
      messages.pop();
    }

    const selected: LocalQwen35Message[] = [];
    let chars = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      const nextChars = chars + message.content.length;
      if (
        selected.length >= LOCAL_QWEN35_DIRECT_HISTORY_MAX_MESSAGES
        || (selected.length > 0 && nextChars > LOCAL_QWEN35_DIRECT_HISTORY_MAX_CHARS)
      ) {
        break;
      }
      selected.unshift(message);
      chars = nextChars;
    }
    while (selected.length && selected[0].role !== "user") selected.shift();
    return selected;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog()?.warn("ws", `[LOCAL-QWEN35-DIRECT-HISTORY v1] read failed · ${message} · ${sessionPath}`);
    return [];
  }
}

export function buildLocalQwen35DirectMessages(sessionPath: string | null | undefined, originalPromptText: unknown, effectivePromptText: unknown): LocalQwen35Message[] {
  const current = String(effectivePromptText || originalPromptText || "");
  const history = readRecentLocalQwen35DirectMessages(sessionPath, originalPromptText);
  const messages = [...history];
  const last = messages.at(-1);
  if (!(last?.role === "user" && last.content.trim() === current.trim())) {
    messages.push({ role: "user", content: current });
  }
  return messages;
}

export function appendNoThinkHintToLastUserMessage(messages: LocalQwen35Message[]): LocalQwen35Message[] {
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  if (!lastUser || /\/no_think\b/iu.test(lastUser.content || "")) return messages;
  lastUser.content = `${String(lastUser.content || "").trim()}\n/no_think`;
  return messages;
}
