import { AppError } from '../shared/errors.js';
import { errorBus } from '../shared/error-bus.js';
import { withRetry } from '../shared/retry.js';
import {
  readSignedClientAgentHeaders,
} from './client-agent-identity.js';
import { getPooledDispatcher } from '../shared/http-pool.js';

const DISPLAYABLE_TEXT_TYPES = new Set(["text", "output_text", "input_text", "refusal"]);

function extractTextValue(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.value === "string") return value.value;
  if (typeof value.refusal === "string") return value.refusal;
  if (value.text && typeof value.text === "object") {
    if (typeof value.text.value === "string") return value.text.value;
    if (typeof value.text.text === "string") return value.text.text;
  }
  return "";
}

function isReasoningLikeBlock(block) {
  if (!block || typeof block !== "object") return false;
  const type = String(block.type || "").toLowerCase();
  return type.includes("thinking")
    || type.includes("reasoning")
    || typeof block.thinking === "string"
    || typeof block.reasoning === "string"
    || typeof block.reasoning_content === "string";
}

function collectContentStats(content) {
  const stats = {
    textParts: [],
    reasoningBlockCount: 0,
    nonDisplayableBlockCount: 0,
  };

  if (typeof content === "string") {
    const text = content.trim();
    if (text) stats.textParts.push(text);
    return stats;
  }

  if (!Array.isArray(content)) return stats;

  for (const block of content) {
    if (typeof block === "string") {
      const text = block.trim();
      if (text) stats.textParts.push(text);
      continue;
    }
    if (!block || typeof block !== "object") continue;

    const type = String(block.type || "").toLowerCase();
    if (DISPLAYABLE_TEXT_TYPES.has(type) || !type) {
      const text = extractTextValue(block).trim();
      if (text) {
        stats.textParts.push(text);
        continue;
      }
    }

    if (isReasoningLikeBlock(block)) {
      stats.reasoningBlockCount += 1;
      continue;
    }

    stats.nonDisplayableBlockCount += 1;
  }

  return stats;
}

function mergeContentStats(target, source) {
  target.textParts.push(...source.textParts);
  target.reasoningBlockCount += source.reasoningBlockCount;
  target.nonDisplayableBlockCount += source.nonDisplayableBlockCount;
}

function finalizeResponseAnalysis(stats) {
  const text = stats.textParts.join("\n").trim();
  const responseKind = text
    ? "text"
    : stats.reasoningBlockCount > 0
      ? "reasoning_only"
      : stats.nonDisplayableBlockCount > 0
        ? "non_displayable_content"
        : "empty";
  return {
    text,
    responseKind,
    reasoningBlockCount: stats.reasoningBlockCount,
    nonDisplayableBlockCount: stats.nonDisplayableBlockCount,
  };
}

function analyzeLlmResponse(api, data) {
  if (api === "anthropic-messages") {
    return finalizeResponseAnalysis(collectContentStats(data?.content));
  }

  if (api === "openai-responses" || api === "openai-codex-responses") {
    const stats = {
      textParts: [],
      reasoningBlockCount: 0,
      nonDisplayableBlockCount: 0,
    };

    if (typeof data?.output_text === "string" && data.output_text.trim()) {
      stats.textParts.push(data.output_text.trim());
    }

    for (const item of Array.isArray(data?.output) ? data.output : []) {
      if (item?.type === "message" && item?.role === "assistant") {
        mergeContentStats(stats, collectContentStats(item.content));
      } else if (isReasoningLikeBlock(item)) {
        stats.reasoningBlockCount += 1;
      } else if (item && typeof item === "object") {
        stats.nonDisplayableBlockCount += 1;
      }
    }

    return finalizeResponseAnalysis(stats);
  }

  const stats = {
    textParts: [],
    reasoningBlockCount: 0,
    nonDisplayableBlockCount: 0,
  };
  const message = data?.choices?.[0]?.message;
  if (message) {
    mergeContentStats(stats, collectContentStats(message.content));
    const refusalText = typeof message.refusal === "string" ? message.refusal.trim() : "";
    if (!stats.textParts.length && refusalText) stats.textParts.push(refusalText);
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      stats.nonDisplayableBlockCount += message.tool_calls.length;
    }
    if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
      stats.reasoningBlockCount += 1;
    } else if (Array.isArray(message.reasoning_content) && message.reasoning_content.length > 0) {
      stats.reasoningBlockCount += message.reasoning_content.length;
    }
    if (message.reasoning && typeof message.reasoning === "object") {
      stats.reasoningBlockCount += 1;
    } else if (typeof message.reasoning === "string" && message.reasoning.trim()) {
      stats.reasoningBlockCount += 1;
    }
  }
  return finalizeResponseAnalysis(stats);
}

/**
 * core/llm-client.js — 统一的非流式 LLM 调用入口
 *
 * 直接 HTTP POST（非流式），不走 Pi SDK 的 completeSimple（强制流式）。
 * Pi SDK completeSimple 对 DashScope 等供应商有 20-40x 延迟膨胀（stream SSE 首 token 慢），
 * utility 短文本生成（50-200 token）不需要流式，直接 POST 最快。
 *
 * URL 构造规则与 Pi SDK 内部一致，确保和 Chat 链路（走 Pi SDK stream）访问同一个端点：
 *   - openai-completions:  baseUrl + "/chat/completions"
 *   - anthropic-messages:  baseUrl + "/v1/messages"
 *   - openai-responses:    baseUrl + "/responses"
 */

/**
 * 统一非流式文本生成。
 *
 * @param {object} opts
 * @param {string} opts.api            API 协议
 * @param {string} opts.apiKey         API key（本地模型可省略）
 * @param {string} opts.baseUrl        Provider base URL
 * @param {string} opts.model          模型 ID
 * @param {string} [opts.provider]     Provider ID
 * @param {string[]} [opts.quirks]     Provider quirk flags (e.g. ["enable_thinking"])
 * @param {string} [opts.systemPrompt] System prompt
 * @param {Array}  [opts.messages]     消息数组 [{ role, content }]
 * @param {number} [opts.temperature]  温度 (default 0.3)
 * @param {number} [opts.maxTokens]    最大输出 token (default 512)
 * @param {number} [opts.timeoutMs]    超时毫秒 (default 60000)
 * @param {AbortSignal} [opts.signal]  外部取消信号
 * @param {Record<string, string>} [opts.requestHeaders] 额外请求头
 * @returns {Promise<string>} 生成的文本
 */
export async function callText({
  api,
  apiKey,
  baseUrl,
  model,
  provider = "custom",
  quirks = [],
  reasoning = false,
  systemPrompt = "",
  messages = [],
  temperature = 0.3,
  maxTokens = 512,
  timeoutMs,
  signal,
  requestHeaders = null,
}) {
  // T3: 推理模型自动延长超时（reasoning 模型 TTFT 通常 20-40 秒）
  const effectiveTimeoutMs = timeoutMs ?? (reasoning ? 90_000 : 60_000);
  // ── 1. 消息归一化：提取 system 消息合并到 systemPrompt ──
  let mergedSystem = systemPrompt || "";
  const normalizedMessages = [];
  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => c.text || "").join("")
          : "";
      if (text) mergedSystem += (mergedSystem ? "\n" : "") + text;
    } else {
      normalizedMessages.push({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
    }
  }

  // ── 2. 超时信号 ──
  const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const clientAgentHeaders = {
    ...readSignedClientAgentHeaders({
      method: "POST",
      pathname: api === "anthropic-messages"
        ? "/v1/messages"
        : (api === "openai-responses" || api === "openai-codex-responses")
          ? "/responses"
          : "/chat/completions",
    }),
    ...(requestHeaders || {}),
  };

  // ── 3. 按协议构造请求 ──
  const base = (baseUrl || "").replace(/\/+$/, "");
  const dispatcher = getPooledDispatcher(base);
  let endpoint, headers, body;

  if (api === "anthropic-messages") {
    // Anthropic Messages API：baseUrl + /v1/messages（和 Pi SDK Anthropic provider 一致）
    endpoint = `${base}/v1/messages`;
    headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...clientAgentHeaders,
    };
    if (apiKey) headers["x-api-key"] = apiKey;

    // Anthropic 格式：system 和 messages 分离
    const anthropicMessages = normalizedMessages.filter(m => m.role === "user" || m.role === "assistant");
    if (anthropicMessages.length === 0) anthropicMessages.push({ role: "user", content: "" });
    body = {
      model, temperature, max_tokens: maxTokens,
      ...(mergedSystem && { system: mergedSystem }),
      messages: anthropicMessages,
    };
  } else if (api === "openai-responses" || api === "openai-codex-responses") {
    // OpenAI Responses API
    endpoint = `${base}/responses`;
    headers = { "Content-Type": "application/json", ...clientAgentHeaders };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    body = {
      model, temperature, max_output_tokens: maxTokens,
      ...(mergedSystem && { instructions: mergedSystem }),
      input: normalizedMessages,
    };
  } else {
    // OpenAI Completions API（默认）：baseUrl + /chat/completions
    endpoint = `${base}/chat/completions`;
    headers = { "Content-Type": "application/json", ...clientAgentHeaders };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const allMessages = [];
    if (mergedSystem) allMessages.push({ role: "system", content: mergedSystem });
    allMessages.push(...normalizedMessages);
    body = {
      model, temperature, max_tokens: maxTokens,
      messages: allMessages,
      ...(quirks.includes("enable_thinking") && { enable_thinking: false }),
    };
  }

  // ── 4. 发送请求（带自动重试） ──
  return withRetry(async () => {
    const SLOW_THRESHOLD_MS = 15_000;
    const slowTimer = setTimeout(() => {
      errorBus.report(new AppError('LLM_SLOW_RESPONSE', {
        context: { model, provider, elapsed: SLOW_THRESHOLD_MS },
      }));
    }, SLOW_THRESHOLD_MS);

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
      dispatcher: dispatcher || undefined,
    }).catch(err => {
      clearTimeout(slowTimer);
      if (err.name === "AbortError" || err.name === "TimeoutError") {
        throw new AppError('LLM_TIMEOUT', { context: { model }, cause: err });
      }
      throw err;
    });

    // ── 5. 解析响应 ──
    const rawText = await res.text();
    clearTimeout(slowTimer);
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      throw new Error(`LLM returned invalid JSON (status=${res.status})`);
    }

    if (!res.ok) {
      const message = data?.error?.message || data?.message || rawText || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        throw new AppError('LLM_AUTH_FAILED', { context: { model, status: res.status } });
      }
      if (res.status === 429) {
        const retryAfterSec = parseInt(res.headers.get('retry-after') || '0', 10);
        const err = new AppError('LLM_RATE_LIMITED', { context: { model, retryAfterMs: retryAfterSec > 0 ? retryAfterSec * 1000 : undefined } });
        if (retryAfterSec > 0) err._retryAfterMs = retryAfterSec * 1000;
        throw err;
      }
      throw new AppError('UNKNOWN', { message, context: { model, status: res.status } });
    }

    // ── 6. 提取文本 ──
    const analysis = analyzeLlmResponse(api, data);
    const text = analysis.text;

    if (!text) {
      if (combinedSignal.aborted) {
        throw new AppError('LLM_TIMEOUT', { context: { model } });
      }
      const err = new AppError('LLM_EMPTY_RESPONSE', {
        message: analysis.responseKind === "reasoning_only"
          ? 'Model returned reasoning content without a final visible answer'
          : analysis.responseKind === "non_displayable_content"
            ? 'Model returned non-displayable structured content without visible text'
            : 'Model returned empty or non-displayable content',
        context: {
          provider: provider || null,
          modelId: model || null,
          api: api || null,
          responseKind: analysis.responseKind,
          reasoningBlockCount: analysis.reasoningBlockCount,
          nonDisplayableBlockCount: analysis.nonDisplayableBlockCount,
        },
      });
      if (analysis.responseKind !== "empty") err.retryable = false;
      throw err;
    }

    return text;
  }, {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 15000,
    signal: combinedSignal,
  });
}
