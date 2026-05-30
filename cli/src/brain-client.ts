import { applyReasoningToBody, type ReasoningOptions } from "./reasoning.js";
import type { ChatContentPart } from "./media.js";
import type { CliProviderProfile } from "./provider-profile.js";
import { t } from "./i18n.js";
import { signedBrainHeaders } from "./brain-auth.js";
import { brainEndpointUrl } from "./brain-url.js";

export interface BrainChatRequest {
  brainUrl: string;
  prompt?: string;
  messages?: ChatMessage[];
  reasoning: ReasoningOptions;
  fallbackProvider?: CliProviderProfile | null;
  tools?: ChatToolDefinition[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: ChatAssistantToolCall[];
}

export interface ChatAssistantToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export type BrainStreamEvent =
  | { type: "assistant.delta"; text: string }
  | { type: "reasoning.delta"; text: string; hidden?: boolean }
  | { type: "tool_call.delta"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "provider"; activeProvider: string; fallbackFrom?: Array<{ id: string; reason?: string }> }
  | { type: "tool_progress"; event: string; name: string; ms?: number; ok?: boolean }
  | { type: "brain.error"; error: string; code?: string }
  | { type: "usage"; usage: unknown }
  | { type: "done"; finishReason?: string | null };

export class BrainConnectionError extends Error {
  readonly brainUrl: string;

  constructor(brainUrl: string, cause: unknown) {
    super(formatBrainConnectionError(brainUrl, cause));
    this.name = "BrainConnectionError";
    this.brainUrl = brainUrl;
  }
}

export class BrainUnavailableError extends Error {
  readonly brainUrl: string;
  readonly status: number;

  constructor(brainUrl: string, status: number, statusText: string) {
    super(`Brain request failed: ${status} ${statusText}`.trim());
    this.name = "BrainUnavailableError";
    this.brainUrl = brainUrl;
    this.status = status;
  }
}

export function formatBrainRecoveryHint(error: unknown): string {
  if (error instanceof BrainConnectionError) {
    return t("brain.recovery.offline");
  }
  return error instanceof Error ? error.message : String(error);
}

export async function checkBrainReachable(brainUrl: string, timeoutMs = 350): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(brainEndpointUrl(brainUrl, "/health"), {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function parseSsePayloads(chunk: string): string[] {
  const payloads: string[] = [];
  for (const block of chunk.split(/\n\n+/)) {
    const dataLines = block
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length) payloads.push(dataLines.join("\n"));
  }
  return payloads;
}

export function parseBrainStreamPayload(payload: string): BrainStreamEvent[] {
  if (!payload || payload === "[DONE]") return [{ type: "done" }];
  const parsed = JSON.parse(payload) as {
    object?: string;
    meta?: { active_provider?: unknown; fallback_from?: unknown };
    tool_progress?: { event?: unknown; name?: unknown; ms?: unknown; ok?: unknown };
    error?: unknown;
    code?: unknown;
    choices?: Array<{
      delta?: {
        content?: unknown;
        reasoning_content?: unknown;
        reasoning?: unknown;
        tool_calls?: unknown;
        toolCalls?: unknown;
        function_call?: unknown;
        functionCall?: unknown;
      };
      finish_reason?: string | null;
    }>;
    usage?: unknown;
  };
  const events: BrainStreamEvent[] = [];
  if (parsed.object === "lynn.provider") {
    const activeProvider = typeof parsed.meta?.active_provider === "string" ? parsed.meta.active_provider : "";
    const fallbackFrom = Array.isArray(parsed.meta?.fallback_from)
      ? parsed.meta.fallback_from
          .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
          .map((entry) => ({
            id: typeof entry.id === "string" ? entry.id : "",
            reason: typeof entry.reason === "string" ? entry.reason : undefined,
          }))
          .filter((entry) => entry.id)
      : undefined;
    if (activeProvider) events.push({ type: "provider", activeProvider, fallbackFrom });
  }
  if (parsed.object === "lynn.tool_progress") {
    const progress = parsed.tool_progress || {};
    const event = typeof progress.event === "string" ? progress.event : "";
    const name = typeof progress.name === "string" ? progress.name : "";
    if (event && name) {
      events.push({
        type: "tool_progress",
        event,
        name,
        ms: typeof progress.ms === "number" ? progress.ms : undefined,
        ok: typeof progress.ok === "boolean" ? progress.ok : undefined,
      });
    }
  }
  if (parsed.object === "lynn.error" || (parsed.error && !parsed.choices)) {
    events.push({
      type: "brain.error",
      error: typeof parsed.error === "string" ? parsed.error : "Brain returned an error",
      code: typeof parsed.code === "string" ? parsed.code : undefined,
    });
  }
  for (const choice of parsed.choices || []) {
    const delta = choice.delta || {};
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      events.push({ type: "reasoning.delta", text: delta.reasoning_content, hidden: true });
    } else if (typeof delta.reasoning === "string" && delta.reasoning) {
      events.push({ type: "reasoning.delta", text: delta.reasoning, hidden: true });
    }
    if (typeof delta.content === "string" && delta.content) {
      events.push({ type: "assistant.delta", text: delta.content });
    }
    for (const toolCall of parseToolCallDeltas(delta)) events.push(toolCall);
    if (choice.finish_reason) {
      events.push({ type: "done", finishReason: choice.finish_reason });
    }
  }
  if (parsed.usage) events.push({ type: "usage", usage: parsed.usage });
  return events;
}

function parseToolCallDeltas(delta: Record<string, unknown>): Array<Extract<BrainStreamEvent, { type: "tool_call.delta" }>> {
  const events: Array<Extract<BrainStreamEvent, { type: "tool_call.delta" }>> = [];
  const toolCalls = delta.tool_calls ?? delta.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const [fallbackIndex, raw] of toolCalls.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      const fn = record.function && typeof record.function === "object" && !Array.isArray(record.function)
        ? record.function as Record<string, unknown>
        : {};
      const index = typeof record.index === "number" && Number.isFinite(record.index) ? record.index : fallbackIndex;
      events.push({
        type: "tool_call.delta",
        index,
        id: typeof record.id === "string" ? record.id : undefined,
        name: typeof fn.name === "string" ? fn.name : typeof record.name === "string" ? record.name : undefined,
        arguments: typeof fn.arguments === "string" ? fn.arguments : typeof record.arguments === "string" ? record.arguments : undefined,
      });
    }
  }
  const functionCall = delta.function_call ?? delta.functionCall;
  if (functionCall && typeof functionCall === "object" && !Array.isArray(functionCall)) {
    const fn = functionCall as Record<string, unknown>;
    events.push({
      type: "tool_call.delta",
      index: 0,
      name: typeof fn.name === "string" ? fn.name : undefined,
      arguments: typeof fn.arguments === "string" ? fn.arguments : undefined,
    });
  }
  return events;
}

export async function* streamBrainChat(request: BrainChatRequest): AsyncGenerator<BrainStreamEvent> {
  yield* streamLynnChat(request);
}

export async function* streamLynnChat(request: BrainChatRequest): AsyncGenerator<BrainStreamEvent> {
  try {
    let sawAssistantOutput = false;
    for await (const event of streamBrainOnlyChat(request)) {
      if (event.type === "assistant.delta" || event.type === "reasoning.delta" || event.type === "tool_call.delta") {
        sawAssistantOutput = true;
      }
      if (event.type === "brain.error" && request.fallbackProvider && !sawAssistantOutput && isRecoverableBrainStreamError(event)) {
        yield* streamDirectProviderChat(request, request.fallbackProvider);
        return;
      }
      yield event;
    }
  } catch (error) {
    if ((error instanceof BrainConnectionError || error instanceof BrainUnavailableError) && request.fallbackProvider) {
      yield* streamDirectProviderChat(request, request.fallbackProvider);
      return;
    }
    throw error;
  }
}

function isRecoverableBrainStreamError(event: Extract<BrainStreamEvent, { type: "brain.error" }>): boolean {
  return /all providers failed/i.test(event.error) || event.code === "all_providers_failed";
}

async function* streamBrainOnlyChat(request: BrainChatRequest): AsyncGenerator<BrainStreamEvent> {
  const messages = request.messages || (request.prompt ? [{ role: "user" as const, content: request.prompt }] : []);
  if (!messages.length) {
    throw new Error("Brain request requires a prompt or messages");
  }
  const body = applyReasoningToBody({
    model: "lynn-brain-router",
    stream: true,
    ...(request.tools?.length ? { tools: request.tools, tool_choice: "auto" } : {}),
    messages,
  }, request.reasoning);

  let response: Response;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), brainRequestTimeoutMs(!!request.fallbackProvider));
  try {
    response = await fetch(brainEndpointUrl(request.brainUrl, "/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...signedBrainHeaders({ pathname: "/v1/chat/completions" }) },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (error) {
    throw new BrainConnectionError(request.brainUrl, error);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    if (isRecoverableBrainStatus(response.status)) {
      throw new BrainUnavailableError(request.brainUrl, response.status, response.statusText);
    }
    throw new Error(`Brain request failed: ${response.status} ${response.statusText}`.trim());
  }
  if (!response.body) {
    throw new BrainUnavailableError(request.brainUrl, response.status, "missing response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const split = buffer.split(/\n\n+/);
    buffer = split.pop() || "";
    for (const block of split) {
      for (const payload of parseSsePayloads(`${block}\n\n`)) {
        for (const event of parseBrainStreamPayload(payload)) yield event;
      }
    }
  }

  buffer += decoder.decode();
  for (const payload of parseSsePayloads(buffer)) {
    for (const event of parseBrainStreamPayload(payload)) yield event;
  }
}

async function* streamDirectProviderChat(request: BrainChatRequest, provider: CliProviderProfile): AsyncGenerator<BrainStreamEvent> {
  const messages = request.messages || (request.prompt ? [{ role: "user" as const, content: request.prompt }] : []);
  if (!messages.length) {
    throw new Error("Provider request requires a prompt or messages");
  }
  const body = applyDirectProviderReasoningToBody({
    model: provider.model,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.tools?.length ? { tools: request.tools, tool_choice: "auto" } : {}),
    messages,
  }, request.reasoning);
  let response: Response;
  try {
    response = await fetch(chatCompletionsUrl(provider.baseUrl), {
      method: "POST",
      headers: providerHeaders(provider),
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`CLI BYOK provider request failed (${provider.provider}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`CLI BYOK provider request failed: ${response.status} ${response.statusText}${detail ? ` · ${detail.slice(0, 240)}` : ""}`.trim());
  }

  yield { type: "provider", activeProvider: `cli-byok:${provider.provider}`, fallbackFrom: [{ id: "brain", reason: "offline" }] };

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const split = buffer.split(/\n\n+/);
    buffer = split.pop() || "";
    for (const block of split) {
      for (const payload of parseSsePayloads(`${block}\n\n`)) {
        for (const event of parseBrainStreamPayload(payload)) yield event;
      }
    }
  }
  buffer += decoder.decode();
  for (const payload of parseSsePayloads(buffer)) {
    for (const event of parseBrainStreamPayload(payload)) yield event;
  }
}

export function chatCompletionsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const cleanPath = url.pathname.replace(/\/+$/, "");
  url.pathname = cleanPath.endsWith("/chat/completions") ? cleanPath : `${cleanPath}/chat/completions`;
  return url;
}

function brainRequestTimeoutMs(hasFallbackProvider: boolean): number {
  const raw = process.env.LYNN_CLI_BRAIN_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.max(250, Math.min(30_000, parsed));
  return hasFallbackProvider ? 1200 : 5000;
}

function isRecoverableBrainStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function providerHeaders(provider: CliProviderProfile): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

function applyDirectProviderReasoningToBody(body: Record<string, unknown>, options: ReasoningOptions): Record<string, unknown> {
  if (options.effort === "auto" || options.effort === "off") return body;
  body.reasoning_effort = options.effort;
  return body;
}

function formatBrainConnectionError(brainUrl: string, error: unknown): string {
  const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
  return [
    t("brain.connection.error", { brainUrl, detail }),
    t("brain.connection.recovery"),
    t("brain.connection.byok"),
  ].join(" ");
}
