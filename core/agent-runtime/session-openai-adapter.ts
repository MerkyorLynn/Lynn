import { randomUUID } from "node:crypto";
import { normalizeToolAliasName } from "../engine-tool-runtime.js";
import { filterOutBrainManagedCustomTools } from "../brain-managed-tools.js";
import { isBrainProvider } from "../../shared/brain-provider.js";
import { resolveModelCallTimeouts } from "./model-call-timeouts.js";
export { ModelCallTimeoutError, createTimedSignal } from "../../shared/model-stream-timeout.js";
import type {
  AgentSessionEvent,
  ChatMessage,
  ImageContent,
  MessageContent,
  Model,
  PromptOptions,
  TextContent,
  ThinkingLevel,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./types.js";

export type RuntimeTool = ToolDefinition & {
  execute?: (toolCallId: string, params: unknown, runtime?: unknown) => Promise<ToolResult> | ToolResult;
};

export type StreamToolCallAccumulator = {
  id: string;
  index: number;
  name: string;
  arguments: string;
};

export type OpenAiChunk = {
  object?: string;
  type?: string;
  meta?: Record<string, unknown>;
  tool_progress?: Record<string, unknown>;
  error?: unknown;
  code?: unknown;
  choices?: Array<{
    delta?: Record<string, unknown>;
    message?: Record<string, unknown>;
    finish_reason?: string | null;
  }>;
  usage?: unknown;
};

export type ModelFallbackReason = "empty_response" | "tool_round_limit" | "model_error";

export type ModelCallOptions = {
  model?: Model;
  tools?: RuntimeTool[];
  streamText?: boolean;
  timeoutMs?: number;
};

export const STEP_EXECUTE_TOOL_NAME = "step_execute";
export const STEP_DELEGATION_TOOL_KEYS = new Set([
  "web-search",
  "web-fetch",
  "fetch-web-content",
  "sports-score",
  "weather",
  "stock-market",
  "live-news",
  "search",
  "fetch",
]);


/** A stream failed after yielding assistant text.  The caller may safely keep
 * a structurally complete partial answer instead of appending a second model's
 * fallback answer to text the user has already seen. */
export class ModelCallStreamError extends Error {
  readonly partialContent: string;
  readonly partialReasoning: string;
  readonly streamedText: boolean;
  readonly cause: unknown;

  constructor(cause: unknown, partialContent: string, partialReasoning: string, streamedText: boolean) {
    const message = cause instanceof Error ? cause.message : String(cause || "model stream failed");
    super(message);
    this.name = "ModelCallStreamError";
    this.cause = cause;
    this.partialContent = partialContent;
    this.partialReasoning = partialReasoning;
    this.streamedText = streamedText;
  }
}

export function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function defaultModelCallTimeoutMs(): number {
  return resolveModelCallTimeouts(undefined).totalMs;
}

export function brainModelCallTimeoutMs(): number {
  return resolveModelCallTimeouts(undefined, "brain").totalMs;
}

export function fallbackModelCallTimeoutMs(): number {
  return positiveEnvInt("LYNN_FALLBACK_MODEL_CALL_TIMEOUT_MS", 30_000);
}

export function beijingDateParts(date = new Date()): { year: number; month: number; day: number; serial: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  return { year, month, day, serial: year * 10_000 + month * 100 + day };
}

export function dateSerial(year: number, month: number, day: number): number | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Math.floor(year) * 10_000 + Math.floor(month) * 100 + Math.floor(day);
}

export function extractExplicitDateSerials(text: string): number[] {
  const current = beijingDateParts();
  const serials: number[] = [];
  const push = (year: number, month: number, day: number) => {
    const serial = dateSerial(year, month, day);
    if (serial != null) serials.push(serial);
  };
  for (const match of text.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    push(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  for (const match of text.matchAll(/(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/g)) {
    push(Number(match[1]), Number(match[2]), Number(match[3] || "1"));
  }
  for (const match of text.matchAll(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    push(current.year, Number(match[1]), Number(match[2]));
  }
  return [...new Set(serials)];
}

export function containsPastDateFutureStartContradiction(text: string): boolean {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!compact) return false;
  const today = beijingDateParts().serial;
  if (!extractExplicitDateSerials(compact).some((serial) => serial <= today)) return false;
  const futureStart =
    /(?:要到|将在|将于|预计|计划|还要等到|才会|才)[^。；;!?！？]{0,50}(?:开幕|开赛|开始|举行|进行|打响|正赛)/.test(compact) ||
    /(?:开幕|开赛|开始|举行|进行|打响|正赛)[^。；;!?！？]{0,50}(?:尚未|还没|还未|未|暂无)/.test(compact);
  const noResult =
    /(?:没有|暂无|尚未|还没有|还未|未查到|未获取到|未找到|未产生|无法获取)[^。；;!?！？]{0,60}(?:比分|赛果|结果|比赛|赛程|正赛|数据|信息)/.test(compact) ||
    /(?:比分|赛果|结果|比赛|赛程|正赛|数据|信息)[^。；;!?！？]{0,60}(?:没有|暂无|尚未|还没有|还未|未查到|未获取到|未找到|未产生|无法获取)/.test(compact);
  return futureStart && noResult;
}

export function claimsToolEvidenceWithoutToolMessages(text: unknown): boolean {
  const value = String(text || "");
  return /针对[“"][^”"]{1,240}[”"]，?我能从工具证据中确认/u.test(value)
    || /根据本轮已执行(?:工具|操作)返回的(?:证据|可见结果)/u.test(value)
    || /这轮操作已有可见结果，先按结果收口/u.test(value);
}

export function isUnsafeFinalAnswerText(
  text: string,
  options: { hasToolEvidence?: boolean } = {},
): boolean {
  return containsPastDateFutureStartContradiction(text)
    || (!options.hasToolEvidence && claimsToolEvidenceWithoutToolMessages(text));
}


export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      if (typeof record.text === "string") return record.text;
      return "";
    }).join("");
  }
  return content == null ? "" : String(content);
}

export function maybeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

export function normalizeToolResult(result: unknown): ToolResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { content: [{ type: "text", text: String(result ?? "") }] };
  }
  const record = result as ToolResult;
  if (Array.isArray(record.content)) return record;
  if (typeof record.text === "string") return { ...record, content: [{ type: "text", text: record.text }] };
  return record;
}

export function toolResultToMessageContent(result: ToolResult): string {
  if (Array.isArray(result.content) && result.content.length) {
    return result.content.map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.data === "string") return `[${part.type || "data"}:${part.mimeType || "unknown"}]`;
      return maybeJson(part);
    }).filter(Boolean).join("\n");
  }
  if (result.details !== undefined) return maybeJson(result.details);
  return maybeJson(result);
}

export function eventTextDelta(text: string): AgentSessionEvent {
  return {
    type: "message_update",
    role: "assistant",
    assistantMessageEvent: { type: "text_delta", text, delta: text } as any,
  };
}

export function eventThinkingDelta(text: string): AgentSessionEvent {
  return {
    type: "message_update",
    role: "assistant",
    assistantMessageEvent: { type: "thinking_delta", text, delta: text } as any,
  };
}

export function eventError(error: string): AgentSessionEvent {
  return {
    type: "message_update",
    role: "assistant",
    assistantMessageEvent: { type: "error", error },
  };
}

export function normalizeTools(tools: ToolDefinition[] | undefined): RuntimeTool[] {
  return (tools || [])
    .filter((tool): tool is RuntimeTool => !!tool && typeof tool.name === "string" && !!tool.name)
    .map((tool) => ({ ...tool }));
}

export function normalizeRuntimeToolsForModel(tools: ToolDefinition[] | undefined, model: Model): RuntimeTool[] {
  const normalized = normalizeTools(tools);
  if (!isBrainProvider(model?.provider)) return normalized;
  return filterOutBrainManagedCustomTools(normalized);
}

export function toolToOpenAi(tool: RuntimeTool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} },
    },
  };
}

export function isImagePart(part: unknown): part is ImageContent {
  const record = asRecord(part);
  return record.type === "image" || record.type === "image_url" || Boolean(record.source);
}

export function imagePartToOpenAi(part: ImageContent | Record<string, unknown>): Record<string, unknown> {
  const record = asRecord(part);
  if (record.type === "image_url") return record;
  const source = asRecord(record.source);
  const mediaType = String(record.mediaType || record.mimeType || source.media_type || source.mimeType || "image/png");
  const data = String(record.data || source.data || "");
  if (data.startsWith("data:")) return { type: "image_url", image_url: { url: data } };
  return { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
}

export function contentToOpenAi(content: MessageContent | undefined): string | Array<Record<string, unknown>> {
  if (typeof content === "string" || content === undefined) return content || "";
  if (!Array.isArray(content)) return String(content);
  return content.map((part) => {
    if (typeof part === "string") return { type: "text", text: part };
    if (isImagePart(part)) return imagePartToOpenAi(part as ImageContent);
    const record = asRecord(part);
    if (record.type === "text") return { type: "text", text: String(record.text || "") };
    if (typeof record.text === "string") return { type: "text", text: record.text };
    return { type: "text", text: maybeJson(record) };
  });
}

export function sanitizeMessagesForProvider(messages: ChatMessage[], model: Model): ChatMessage[] {
  const provider = String(model.provider || "").toLowerCase();
  const isDeepSeek = provider.includes("deepseek") || /^deepseek-/i.test(model.id || "");
  const next: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = contentToText(message.content).trim();
      const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      if (!text && !hasToolCalls) continue;
      if (isDeepSeek) {
        const { reasoning_content: _drop, ...rest } = message;
        next.push(rest);
        continue;
      }
    }
    next.push({ ...message });
  }
  return next;
}

export function toOpenAiMessages(messages: ChatMessage[], model: Model): Record<string, unknown>[] {
  return sanitizeMessagesForProvider(messages, model).map((message) => {
    const record: Record<string, unknown> = {
      role: message.role,
      content: contentToOpenAi(message.content),
    };
    if (message.name) record.name = message.name;
    if (message.tool_call_id) record.tool_call_id = message.tool_call_id;
    if (message.tool_calls?.length) record.tool_calls = message.tool_calls;
    return record;
  });
}

export function baseUrlFor(model: Model): string {
  const raw = String(model.baseUrl || model.baseURL || "").replace(/\/+$/, "");
  if (!raw) throw new Error(`Model ${model.provider}/${model.id} has no baseUrl`);
  return raw;
}

export function chatCompletionsUrl(model: Model): string {
  const base = baseUrlFor(model);
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

export function thinkingPayload(model: Model, level: ThinkingLevel | undefined): Record<string, unknown> {
  const raw = String(level || "auto").toLowerCase();
  const provider = String(model.provider || "").toLowerCase();
  const format = String((model.compat as any)?.thinkingFormat || "");
  const isLocalQwen = provider.includes("local-qwen");
  const isQwenThinking = format === "qwen" || model.quirks?.includes("enable_thinking") || isLocalQwen;
  const disabled = !raw || raw === "none" || raw === "off" || raw === "false" || raw === "disabled";
  if (disabled) {
    if (isQwenThinking) {
      return isLocalQwen
        ? { chat_template_kwargs: { enable_thinking: false } }
        : { enable_thinking: false };
    }
    return {};
  }
  if (isQwenThinking) {
    return isLocalQwen
      ? { chat_template_kwargs: { enable_thinking: true } }
      : { enable_thinking: true };
  }
  if (format === "zai" || provider.includes("glm") || provider.includes("zai")) {
    return { thinking: { type: raw === "auto" ? "auto" : "enabled" } };
  }
  if (format === "deepseek" || provider.includes("deepseek")) return { reasoning_effort: raw === "auto" ? "low" : raw };
  return { reasoning_effort: raw === "auto" ? "low" : raw };
}

export function buildRequestBody(
  model: Model,
  messages: ChatMessage[],
  tools: RuntimeTool[],
  thinkingLevel: ThinkingLevel | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.id,
    messages: toOpenAiMessages(messages, model),
    stream: true,
  };
  const maxTokens = Number(model.maxTokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = Math.min(maxTokens, 64_000);
  if (tools.length) {
    body.tools = tools.map(toolToOpenAi);
    body.tool_choice = "auto";
  }
  Object.assign(body, thinkingPayload(model, thinkingLevel));
  return body;
}

export function parseSseBlocks(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let cursor = 0;
  while (true) {
    const idx = buffer.indexOf("\n\n", cursor);
    if (idx < 0) break;
    const block = buffer.slice(cursor, idx);
    cursor = idx + 2;
    const data = block
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) payloads.push(data);
  }
  return { payloads, rest: buffer.slice(cursor) };
}

export function parsePayload(payload: string): OpenAiChunk | null {
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as OpenAiChunk;
  } catch {
    return null;
  }
}

export function appendToolDelta(map: Map<number, StreamToolCallAccumulator>, raw: unknown, fallbackIndex: number): void {
  const record = asRecord(raw);
  const index = typeof record.index === "number" ? record.index : fallbackIndex;
  const current = map.get(index) || {
    id: typeof record.id === "string" && record.id ? record.id : `call_${index}_${randomUUID().slice(0, 8)}`,
    index,
    name: "",
    arguments: "",
  };
  if (typeof record.id === "string" && record.id) current.id = record.id;
  const fn = asRecord(record.function || record.functionCall);
  if (typeof fn.name === "string" && fn.name) current.name = fn.name;
  if (typeof fn.arguments === "string") current.arguments += fn.arguments;
  map.set(index, current);
}

export function finalizeToolCalls(map: Map<number, StreamToolCallAccumulator>): ToolCall[] {
  return [...map.values()]
    .sort((a, b) => a.index - b.index)
    .filter((entry) => entry.name.trim())
    .map((entry) => ({
      id: entry.id,
      type: "function",
      function: {
        name: entry.name.trim(),
        arguments: entry.arguments || "{}",
      },
    }));
}

export function isExecutableToolCall(toolCall: ToolCall | null | undefined): toolCall is ToolCall {
  return Boolean(toolCall?.id && toolCall.function?.name?.trim());
}

export function safeJsonParse(value: string): unknown {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    const recovered = parseConcatenatedJsonObjects(value);
    if (recovered) return recovered;
    return { _raw: value };
  }
}

export function parseConcatenatedJsonObjectParts(value: string): Record<string, unknown>[] | null {
  const text = String(value || "").trim();
  if (!text) return [];
  const parts: Record<string, unknown>[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let consumedUntil = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch !== "}") continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    const before = text.slice(consumedUntil, start).trim();
    if (before) return null;
    try {
      const parsed = JSON.parse(text.slice(start, i + 1));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      parts.push(parsed as Record<string, unknown>);
      consumedUntil = i + 1;
      start = -1;
    } catch {
      return null;
    }
  }

  if (text.slice(consumedUntil).trim()) return null;
  return parts;
}

export function parseConcatenatedJsonObjects(value: string): Record<string, unknown> | null {
  const parts = parseConcatenatedJsonObjectParts(value);
  if (!parts) return null;
  if (parts.length === 0) return {};
  if (parts.length <= 1) return null;
  return Object.assign({}, ...parts);
}

export function toolNameKey(name: string): string {
  return String(normalizeToolAliasName(name) || name || "")
    .replace(/_/g, "-")
    .trim()
    .toLowerCase();
}

export function resolveRuntimeToolName(nameOrKey: string, tools: RuntimeTool[]): string | null {
  const key = toolNameKey(nameOrKey);
  const match = tools.find((tool) => toolNameKey(tool.name) === key);
  return match?.name || null;
}

function firstJsonRecord(value: string): Record<string, unknown> | null {
  const parts = parseConcatenatedJsonObjectParts(value);
  if (parts?.length) return parts.at(-1) || null;
  const parsed = safeJsonParse(value);
  const record = asRecord(parsed);
  return Object.keys(record).length ? record : null;
}

function argumentsToString(value: unknown): string {
  if (typeof value === "string") return value.trim() || "{}";
  if (value === undefined || value === null) return "{}";
  return maybeJson(value);
}

function toolCallFromRecord(record: Record<string, unknown>, tools: RuntimeTool[], index: number): ToolCall | null {
  let rawName = stringField(record, ["name", "tool", "tool_name", "function", "function_name"]);
  let rawArguments = record.arguments ?? record.args ?? record.parameters ?? record.params ?? record.input;

  if (!rawName) {
    const keys = Object.keys(record);
    if (keys.length === 1 && resolveRuntimeToolName(keys[0], tools)) {
      rawName = keys[0];
      rawArguments = record[keys[0]];
    }
  }

  const canonicalName = rawName ? resolveRuntimeToolName(rawName, tools) : null;
  if (!canonicalName) return null;

  return {
    id: `call_qwen_${index}_${randomUUID().slice(0, 8)}`,
    type: "function",
    function: {
      name: canonicalName,
      arguments: argumentsToString(rawArguments),
    },
  };
}

function attrValue(attrs: string, names: string[]): string {
  for (const name of names) {
    const match = attrs.match(new RegExp(`${name}\\s*=\\s*["']?([^"'\\s>]+)`, "i"));
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function stripToolTokenWrappers(value: string): string {
  return String(value || "")
    .replace(/<\|tool_calls_section_(?:begin|end)\|>/giu, "\n")
    .replace(/<\|tool_calls?_(?:section_)?(?:begin|end)\|>/giu, (token) => (
      /section/iu.test(token) ? "\n" : token
    ))
    .replace(/<\|tool_code_(?:begin|end)\|>/giu, "\n");
}

function parseToolTagCalls(text: string, tools: RuntimeTool[], startIndex: number): ToolCall[] {
  const calls: ToolCall[] = [];
  const tagRe = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/giu;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(text))) {
    const attrs = match[1] || "";
    const body = (match[2] || "").trim();
    const name = attrValue(attrs, ["name", "tool", "function"]);
    const record = name
      ? { name, arguments: firstJsonRecord(body) || body }
      : firstJsonRecord(body);
    if (!record) continue;
    const call = toolCallFromRecord(record, tools, startIndex + calls.length);
    if (call) calls.push(call);
  }
  return calls;
}

function parseFunctionTagCalls(text: string, tools: RuntimeTool[], startIndex: number): ToolCall[] {
  const calls: ToolCall[] = [];
  const fnRe = /<function=([a-z0-9_.:-]+)\s*>([\s\S]*?)<\/function>/giu;
  let match: RegExpExecArray | null;
  while ((match = fnRe.exec(text))) {
    const name = match[1] || "";
    const body = match[2] || "";
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter=([a-z0-9_.:-]+)\s*>([\s\S]*?)<\/parameter>/giu;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRe.exec(body))) {
      args[paramMatch[1]] = String(paramMatch[2] || "").trim();
    }
    const call = toolCallFromRecord(
      { name, arguments: Object.keys(args).length ? args : firstJsonRecord(body) || body.trim() },
      tools,
      startIndex + calls.length,
    );
    if (call) calls.push(call);
  }
  return calls;
}

function parseSpecialTokenCalls(text: string, tools: RuntimeTool[], startIndex: number): ToolCall[] {
  const calls: ToolCall[] = [];
  const callRe = /<\|tool_call_(?:start|begin)\|>([\s\S]*?)<\|tool_call_(?:end|stop)\|>/giu;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(text))) {
    const body = (match[1] || "").trim();
    const nameMatch = body.match(/<\|tool_call_name(?:_begin)?\|>([\s\S]*?)(?:<\|tool_call_name(?:_end)?\|>)/iu);
    const argsMatch = body.match(/<\|tool_call_arguments?(?:_begin)?\|>([\s\S]*?)(?:<\|tool_call_arguments?(?:_end)?\|>|$)/iu);
    let record: Record<string, unknown> | null = null;
    if (nameMatch?.[1]) {
      record = {
        name: nameMatch[1].trim(),
        arguments: firstJsonRecord(argsMatch?.[1] || "") || (argsMatch?.[1] || "").trim(),
      };
    } else {
      const direct = firstJsonRecord(body);
      if (direct) {
        record = direct;
      } else {
        const lineMatch = body.match(/^\s*([a-z0-9_.:-]+)\s*\n([\s\S]+)$/iu);
        if (lineMatch) record = { name: lineMatch[1], arguments: firstJsonRecord(lineMatch[2]) || lineMatch[2].trim() };
      }
    }
    if (!record) continue;
    const call = toolCallFromRecord(record, tools, startIndex + calls.length);
    if (call) calls.push(call);
  }
  return calls;
}

export function extractToolCallsFromContent(content: string, tools: RuntimeTool[]): ToolCall[] {
  if (!tools.length) return [];
  const text = stripToolTokenWrappers(content);
  if (!text.trim()) return [];
  if (!/^\s*(?:<tool_call\b|<function=|<\|tool_call_(?:start|begin)\|>)/iu.test(text)) return [];

  const calls = [
    ...parseToolTagCalls(text, tools, 0),
  ];
  calls.push(...parseSpecialTokenCalls(text, tools, calls.length));
  calls.push(...parseFunctionTagCalls(text, tools, calls.length));

  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${toolNameKey(call.function.name)}\0${call.function.arguments}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function lastStringField(parts: Record<string, unknown>[], keys: string[]): string {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const value = stringField(parts[i], keys);
    if (value) return value;
  }
  return "";
}

export function firstPresentField(parts: Record<string, unknown>[], keys: string[]): unknown {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    for (const key of keys) {
      if (parts[i][key] !== undefined) return parts[i][key];
    }
  }
  return undefined;
}

export function normalizeToolCallForExecution(
  toolName: string,
  rawArguments: string,
  tools: RuntimeTool[],
): { name: string; args: unknown } {
  const parts = parseConcatenatedJsonObjectParts(rawArguments);
  const parsed = safeJsonParse(rawArguments);
  const records = parts && parts.length > 0
    ? parts
    : [asRecord(parsed)];
  const key = toolNameKey(toolName);
  const canonicalName = resolveRuntimeToolName(toolName, tools) || normalizeToolAliasName(toolName) || toolName;

  if (key === "web-fetch" || key === "fetch-web-content") {
    const url = lastStringField(records, ["url", "href", "link"]);
    if (url) {
      const latest = records.at(-1) || {};
      return {
        name: canonicalName,
        args: {
          ...latest,
          url,
        },
      };
    }

    const query = lastStringField(records, ["query", "q", "keyword"]);
    const searchToolName = resolveRuntimeToolName("web-search", tools);
    if (query && searchToolName) {
      const maxResults = firstPresentField(records, ["maxResults", "max_results", "limit", "topK", "numResults"]);
      const args: Record<string, unknown> = { query };
      if (maxResults !== undefined) args.maxResults = maxResults;
      return { name: searchToolName, args };
    }
  }

  if (key === "web-search") {
    const query = lastStringField(records, ["query", "q", "keyword"]);
    if (query) {
      const args = asRecord(parsed);
      args.query = query;
      return { name: canonicalName, args };
    }
  }

  return { name: canonicalName, args: parsed };
}

export function roleMessage(role: ChatMessage["role"], content: MessageContent): ChatMessage {
  return { role, content };
}
