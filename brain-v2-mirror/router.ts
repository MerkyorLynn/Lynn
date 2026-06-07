// Brain v2 · Router — BYOK-equality thin pipe
// 原则: 只做事实层 (provider universalOrder + cooldown + capability gate + wire adapter)
//       + 服务端工具回灌循环。不注入 system prompt,不限工具调用次数(env 可配),不检测/拒绝伪工具,
//       不强制 synthesis,不解析模型内容做策略判断。BYOK 直连什么样,brain 就什么样。
//
// 2026-05-23 重构: 砍掉 ~500 行 synthesis + pseudo-tool detection + buffered content 干涉。

import { providerOrderForCapability, getProvider, isInCooldown, markUnhealthy } from './provider-registry.js';
import { getAdapter } from './wire-adapter/index.js';
import { isServerTool, executeServerTool, mergeWithServerTools } from './tool-exec/index.js';
import { applySearchContext, createSearchRequestCache, type SearchRequestCache } from './search-context.js';
import { applyAudioTranscribe, createAudioRequestCache, type AudioRequestCache } from './audio-transcribe.js';
import { compactToolResults, readToolResultCompactionConfigFromEnv } from './context-compact.js';
import {
  buildToolStormReflection,
  createToolStormState,
  observeToolCallStorm,
  readToolStormConfigFromEnv,
} from './tool-storm.js';
import { errorMessage, type ChatMessage, type FallbackEntry, type Provider, type ProviderCapability, type ProviderId, type RouterRunOptions, type RouterRunResult, type ToolCall } from './types.js';

type CapabilityRequired = Partial<Pick<ProviderCapability, 'vision' | 'audio' | 'video'>>;
type ProviderError = Error & { suppressBody?: boolean; cooldownMs?: number };
type RunRoundResult = {
  ok: true;
  providerId: ProviderId;
  finishReason: string | null;
  toolCalls: ToolCall[];
  contentAccum: string;
};

function isProviderConfigured(provider: Provider | null): boolean {
  if (!provider) return false;
  if (provider.apiKey && provider.apiKey !== '') return true;
  if (provider.apiKey === 'none') return true;
  if (provider.authType === 'none') return true;
  return false;
}

// Tool loop guard. Default raised to 50 — long research / agentic chains need 20-30 turns.
// Set BRAIN_V2_MAX_ITERATIONS=0 for unlimited (only abort on real errors).
const MAX_ITERATIONS = Number(process.env.BRAIN_V2_MAX_ITERATIONS || 50);
// P1#4: empty_response 不立即 cooldown。短期 cooldown,需累计 ≥ 2 次 transport-empty(零 SSE chunks)
// 注: 此判断只看 transport 层 anyEmit,不窥探 content。一个 finish_reason=stop+空 content 不会触发。
const EMPTY_RESPONSE_COOLDOWN_MS = Number(process.env.BRAIN_V2_EMPTY_COOLDOWN_MS || 30_000);
const EMPTY_THRESHOLD = Number(process.env.BRAIN_V2_EMPTY_THRESHOLD || 2);
const _emptyCounters = new Map<ProviderId, number>();
// Local provider fast probe (cold-start race avoidance). Opt-out via env.
const LOCAL_HEALTH_PROBE_ENABLED = process.env.BRAIN_V2_LOCAL_HEALTH_PROBE !== '0';
const DEFAULT_LOCAL_HEALTH_PROBE_MS = Number(process.env.BRAIN_V2_LOCAL_HEALTH_PROBE_MS || 1_500);

function _bumpEmpty(providerId: ProviderId): number {
  const n = (_emptyCounters.get(providerId) || 0) + 1;
  _emptyCounters.set(providerId, n);
  return n;
}
function _resetEmpty(providerId: ProviderId): void {
  _emptyCounters.delete(providerId);
}

function isLocalEndpoint(endpoint: string): boolean {
  return typeof endpoint === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(endpoint);
}

function buildLocalProbeUrl(provider: Provider): string {
  const endpointUrl = new URL(provider.endpoint);
  const healthPath = provider.health_path || '/models';
  if (/^https?:\/\//i.test(healthPath)) return healthPath;
  if (healthPath.startsWith('/')) {
    const url = new URL(endpointUrl.origin);
    url.pathname = healthPath;
    return url.toString();
  }
  const base = provider.endpoint.endsWith('/') ? provider.endpoint : provider.endpoint + '/';
  return new URL(healthPath, base).toString();
}

function localProbeTimeoutMs(provider: Provider): number {
  const configured = Number(provider.health_probe_ms || DEFAULT_LOCAL_HEALTH_PROBE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 1_500;
}

function compactText(value: string, max = 220): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= max) return singleLine;
  return singleLine.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function compactMaybe(value: unknown, max = 220): string | null {
  if (typeof value !== 'string') return null;
  const compacted = compactText(value, max);
  return compacted ? compacted : null;
}

function searchCitationFromItem(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const title = compactMaybe(record.title ?? record.name ?? record.label, 120);
  const url = compactMaybe(record.url ?? record.link ?? record.href, 260);
  if (!title || !url) return null;
  const snippet = compactMaybe(record.snippet ?? record.summary ?? record.content ?? record.description, 260) || '';
  return `[${title}](${url}): ${snippet}`;
}

function structuredSearchSummary(parsed: Record<string, unknown>): { summary?: string; details?: string[] } | null {
  const summaries: string[] = [];
  const details: string[] = [];
  const addSummary = (value: unknown, prefix = '') => {
    const compacted = compactMaybe(value, 220);
    if (compacted) summaries.push(prefix ? `${prefix}: ${compacted}` : compacted);
  };
  const addCitation = (item: unknown) => {
    const citation = searchCitationFromItem(item);
    if (citation) details.push(citation);
  };

  addSummary(parsed.summary);
  if (Array.isArray(parsed.items)) parsed.items.forEach(addCitation);
  if (Array.isArray(parsed.results)) parsed.results.forEach(addCitation);

  if (Array.isArray(parsed.sources)) {
    for (const source of parsed.sources) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      const record = source as Record<string, unknown>;
      const name = compactMaybe(record.name ?? record.source ?? record.provider, 80) || 'source';
      addSummary(record.summary, name);
      if (Array.isArray(record.items)) record.items.forEach(addCitation);
      if (Array.isArray(record.results)) record.results.forEach(addCitation);
      if (record.ok === false && record.error) {
        const error = compactMaybe(record.error, 160);
        if (error) details.push(`${name}: error: ${error}`);
      }
    }
  }

  const uniqueDetails = Array.from(new Set(details)).slice(0, 8);
  const picked = [
    ...summaries.slice(0, 2),
    ...uniqueDetails.slice(0, 2).map((line) => line.replace(/^\[([^\]]+)\]\([^)]+\):\s*/, '$1: ')),
  ];
  if (!picked.length && !uniqueDetails.length) return null;
  return {
    summary: picked.length ? compactText(picked.join(' · ')) : undefined,
    details: [
      ...summaries.map((line) => '摘要: ' + line),
      ...uniqueDetails,
    ].slice(0, 8).map((line) => compactText(line, 500)),
  };
}

function numberedSearchCitations(lines: string[]): string[] {
  const citations: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^\d+[.)、]\s*(.+)$/);
    if (!match) continue;
    const title = match[1].trim();
    const url = lines[i + 1]?.trim();
    if (!/^https?:\/\//.test(url || '')) continue;
    const snippet = lines[i + 2]?.trim() || '';
    citations.push(`[${title}](${url}): ${snippet}`);
  }
  return citations;
}

function summarizeToolResult(toolName: string, result: unknown): { summary?: string; details?: string[] } {
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  if (!raw || !raw.trim()) return {};

  const parsed = parseJsonObject(raw);
  if (parsed?.error) return { summary: compactText('error: ' + String(parsed.error), 180), details: [compactText(raw, 500)] };

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^──.+──$/.test(line) && line !== '搜索结果:');

  if (toolName === 'web_search') {
    if (parsed) {
      const structured = structuredSearchSummary(parsed);
      if (structured) return structured;
    }
    const summaries = lines
      .filter((line) => /^摘要[:：]/.test(line))
      .map((line) => line.replace(/^摘要[:：]\s*/, ''))
      .filter(Boolean);
    const citations = [
      ...lines
      .filter((line) => /^\[[^\]]+\]\([^)]+\):/.test(line))
        .filter(Boolean),
      ...numberedSearchCitations(lines),
    ];
    const citationSummaries = citations
      .map((line) => line.replace(/^\[([^\]]+)\]\([^)]+\):\s*/, '$1: '))
      .filter(Boolean);
    const picked = [...summaries.slice(0, 2), ...citationSummaries.slice(0, 2)];
    if (picked.length) {
      return {
        summary: compactText(picked.join(' · ')),
        details: [...summaries.map((line) => '摘要: ' + line), ...citations].slice(0, 8).map((line) => compactText(line, 500)),
      };
    }
  }

  const firstMeaningful = lines.find((line) => !line.startsWith('{')) || raw;
  return {
    summary: compactText(firstMeaningful, 180),
    details: lines.slice(0, 6).map((line) => compactText(line, 500)),
  };
}

function formatToolResultContent(toolName: string, result: unknown, stepIndex: number): string {
  void toolName;
  void stepIndex;
  return typeof result === 'string' ? result : JSON.stringify(result);
}

async function runRound({
  messages,
  tools,
  capabilityRequired,
  signal,
  onChunk,
  log,
  extraBody,
  reasoningEffort,
  requestCache,
  audioCache,
}: Required<Pick<RouterRunOptions, 'onChunk'>> & Omit<RouterRunOptions, 'onChunk'> & { requestCache?: SearchRequestCache; audioCache?: AudioRequestCache }): Promise<RunRoundResult> {
  const errors: Array<{ providerId: ProviderId; error: string }> = [];
  // 2026-05-25 P0-1: track fallback chain so SSE consumer 可显示给 user
  // (例:"MiMo → Spark fallback"),不再让 cascade decision 对 UI 不可见。
  const fallbackChain: FallbackEntry[] = [];
  for (const providerId of providerOrderForCapability(capabilityRequired)) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    if (!isProviderConfigured(provider)) {
      log && log('info', `provider ${providerId} has no credential, skip`);
      continue;
    }
    if (capabilityRequired?.vision && !provider.capability.vision) continue;
    if (capabilityRequired?.audio && !provider.capability.audio) continue;
    if (capabilityRequired?.video && !provider.capability.video) continue;
    // Capability check only: providers that declare no tool support are skipped for tool-attached requests.
    if (Array.isArray(tools) && tools.length > 0 && provider.capability && provider.capability.tools === false) {
      log && log('info', `provider ${providerId} skipped: tool-call request but capability.tools=false`);
      continue;
    }
    if (isInCooldown(providerId)) {
      log && log('info', `provider ${providerId} in cooldown, skip`);
      fallbackChain.push({ id: providerId, reason: 'cooldown' });
      continue;
    }
    // 本地 provider 快速探针 (避免 cold-start race + 1s ECONNREFUSED)。BRAIN_V2_LOCAL_HEALTH_PROBE=0 关
    if (LOCAL_HEALTH_PROBE_ENABLED && isLocalEndpoint(provider.endpoint)) {
      try {
        const probeCtrl = new AbortController();
        const probeTimer = setTimeout(() => probeCtrl.abort(), localProbeTimeoutMs(provider));
        const probeRes = await fetch(buildLocalProbeUrl(provider), { method: 'GET', signal: probeCtrl.signal })
          .catch(() => null);
        clearTimeout(probeTimer);
        if (!probeRes || !probeRes.ok) {
          log && log('info', `provider ${providerId} fast-probe failed, skip+cooldown`);
          markUnhealthy(providerId, 'health-probe-failed', 5000);
          fallbackChain.push({ id: providerId, reason: 'probe-failed' });
          continue;
        }
      } catch {
        log && log('info', `provider ${providerId} fast-probe threw, skip+cooldown`);
        markUnhealthy(providerId, 'health-probe-threw', 5000);
        fallbackChain.push({ id: providerId, reason: 'probe-threw' });
        continue;
      }
    }

    const adapter = getAdapter(provider.wire);
    let anyEmit = false;
    let finishReason: string | null = null;
    let contentAccum = '';
    const toolCallsAcc: ToolCall[] = [];
    try {
      log && log('info', `→ provider ${providerId}`);
      const searchContext = await applySearchContext({ messages, provider, signal, log, requestCache });
      let effectiveMessages = searchContext.messages || messages;
      if (searchContext.meta.applied) {
        await onChunk(
          {
            type: 'pre_search',
            source: 'mimo',
            query: searchContext.meta.query,
            hit: searchContext.meta.hit,
            ms: searchContext.meta.ms,
            cached: searchContext.meta.cached,
          },
          { providerId, fallback_from: fallbackChain.length > 0 ? [...fallbackChain] : undefined },
        );
      }
      const audioContext = await applyAudioTranscribe({ messages: effectiveMessages, provider, signal, log, requestCache: audioCache });
      effectiveMessages = audioContext.messages || effectiveMessages;
      if (audioContext.meta?.applied) {
        await onChunk(
          {
            type: 'audio_fallback',
            source: String(audioContext.meta.source ?? 'whisper'),
            transcripts: Number(audioContext.meta.transcripts ?? 0),
            total: Number(audioContext.meta.total ?? 0),
            ms: Number(audioContext.meta.ms ?? 0),
          },
          { providerId, fallback_from: fallbackChain.length > 0 ? [...fallbackChain] : undefined },
        );
      }
      for await (const chunk of adapter({ provider, messages: effectiveMessages, tools, signal, log, extraBody, reasoningEffort })) {
        anyEmit = true;
        if (chunk.type === 'content') {
          contentAccum += chunk.delta;
          await onChunk(chunk, { providerId, fallback_from: fallbackChain.length > 0 ? [...fallbackChain] : undefined });
          continue;
        }
        if (chunk.type === 'tool_call_delta') {
          for (const d of (chunk.delta || [])) {
            const idx = d.index ?? 0;
            if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (d.id) toolCallsAcc[idx].id = d.id;
            if (d.function?.name) toolCallsAcc[idx].function.name += d.function.name;
            if (d.function?.arguments) toolCallsAcc[idx].function.arguments += d.function.arguments;
          }
          await onChunk(chunk, { providerId, fallback_from: fallbackChain.length > 0 ? [...fallbackChain] : undefined });
          continue;
        }
        if (chunk.type === 'finish') {
          finishReason = chunk.reason;
          await onChunk(chunk, { providerId, fallback_from: fallbackChain.length > 0 ? [...fallbackChain] : undefined });
          continue;
        }
        await onChunk(chunk, { providerId, fallback_from: fallbackChain.length > 0 ? [...fallbackChain] : undefined });
      }
      // anyEmit=false 表示 transport 层零 SSE chunks (真正 wire 失败)。
      // 注意: 这不是检测 "content 为空" — 一个 finish_reason=stop+空 content 仍算正常,因为 chunks≥1。
      if (!anyEmit) {
        const n = _bumpEmpty(providerId);
        log && log('warn', `provider ${providerId} transport-empty (${n}/${EMPTY_THRESHOLD})`);
        if (n >= EMPTY_THRESHOLD) {
          log && log('warn', `provider ${providerId} reached empty threshold, ${EMPTY_RESPONSE_COOLDOWN_MS}ms cooldown`);
          markUnhealthy(providerId, 'empty_response_threshold', EMPTY_RESPONSE_COOLDOWN_MS);
        }
        fallbackChain.push({ id: providerId, reason: 'empty' });
        continue;
      }
      _resetEmpty(providerId);
      return {
        ok: true,
        providerId,
        finishReason,
        toolCalls: toolCallsAcc.filter(Boolean),
        contentAccum,
      };
    } catch (e) {
      const err = e as ProviderError;
      const message = errorMessage(e);
      errors.push({ providerId, error: message });
      const logMsg = err.suppressBody
        ? `provider ${providerId} failed: HTTP-auth (suppressed), fallback`
        : `provider ${providerId} failed: ${message}, fallback`;
      log && log('warn', logMsg);
      markUnhealthy(providerId, message, err.cooldownMs ?? null); // variable cooldown for auth fail
      fallbackChain.push({ id: providerId, reason: 'error' });
      continue;
    }
  }
  const err = new Error('all providers failed') as Error & { errors: typeof errors };
  err.errors = errors;
  throw err;
}

export async function run({ messages, tools, capabilityRequired, signal, onChunk, log, extraBody, reasoningEffort }: RouterRunOptions): Promise<RouterRunResult> {
  // Capability pre-flight — vision/audio/video capability gate, friendly error if no provider supports
  if (capabilityRequired && (capabilityRequired.vision || capabilityRequired.audio || capabilityRequired.video)) {
    const anySupports = providerOrderForCapability(capabilityRequired).some((id) => {
      const p = getProvider(id);
      if (!p) return false;
      if (capabilityRequired.vision && !p.capability.vision) return false;
      if (capabilityRequired.audio && !p.capability.audio) return false;
      if (capabilityRequired.video && !p.capability.video) return false;
      return true;
    });
    if (!anySupports) {
      const missing = [
        capabilityRequired.vision && 'vision',
        capabilityRequired.audio && 'audio',
        capabilityRequired.video && 'video',
      ].filter(Boolean).join('+');
      const err = new Error(`CAPABILITY_NOT_SUPPORTED: no provider supports ${missing} in current build`) as Error & { code: string };
      err.code = 'CAPABILITY_NOT_SUPPORTED';
      throw err;
    }
  }

  const mergedTools = mergeWithServerTools(tools, messages);
  let workingMessages: ChatMessage[] = [...(messages || [])];
  let lastProviderId: ProviderId | null = null;
  let iter = 0;
  const maxIter = MAX_ITERATIONS > 0 ? MAX_ITERATIONS : Infinity;
  const requestCache = createSearchRequestCache();
  const audioCache = createAudioRequestCache() as AudioRequestCache;
  const toolStormConfig = readToolStormConfigFromEnv();
  const toolStormState = createToolStormState();
  const toolResultCompactionConfig = readToolResultCompactionConfigFromEnv();
  let serverToolStepIndex = 0;

  while (iter < maxIter) {
    iter++;
    const result = await runRound({
      messages: workingMessages, tools: mergedTools, capabilityRequired,
      signal, onChunk, log, extraBody, reasoningEffort,
      requestCache,
      audioCache,
    });
    lastProviderId = result.providerId;

    // Model 自然结束 (stop / length / content_filter / function_call 等非 tool_calls) → 透传完成
    if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) {
      return { ok: true, providerId: lastProviderId, iterations: iter };
    }

    const serverCalls = result.toolCalls.filter((tc) => isServerTool(tc.function?.name));
    const clientCalls = result.toolCalls.filter((tc) => !isServerTool(tc.function?.name));

    // 客户端工具 (client 自己执行) → 透传 tool_calls 到客户端,loop 退出
    if (clientCalls.length > 0) {
      log && log('info', `iter ${iter}: ${clientCalls.length} client-side tool_calls forwarded, stop loop`);
      return {
        ok: true, providerId: lastProviderId, iterations: iter,
        forwardedToClient: true, clientToolCalls: clientCalls.length,
        toolCalls: result.toolCalls,
        bufferedContentChunks: [],
        bufferedFinishChunk: { type: 'finish', reason: 'tool_calls' },
      };
    }

    // 服务端工具 → brain 代执行,结果回灌 messages,下一轮再问 model
    log && log('info', `iter ${iter}: ${serverCalls.length} server-side tool_calls, executing...`);
    workingMessages.push({
      role: 'assistant',
      content: result.contentAccum || null,
      tool_calls: result.toolCalls,
    });
    for (const tc of serverCalls) {
      const stormVerdict = observeToolCallStorm(toolStormState, tc, toolStormConfig);
      if (stormVerdict.storm) {
        log && log('warn', `tool storm suppressed: ${stormVerdict.toolName} repeat=${stormVerdict.seen} storms=${stormVerdict.stormCount}/${toolStormConfig.maxStorms}`);
        await onChunk(
          { type: 'tool_progress', event: 'start', name: tc.function.name },
          { providerId: lastProviderId }
        );
        await onChunk(
          { type: 'tool_progress', event: 'end', name: tc.function.name, ms: 0, ok: false },
          { providerId: lastProviderId }
        );
        workingMessages.push({
          role: 'tool',
          tool_call_id: tc.id || ('tc-' + Math.random().toString(36).slice(2)),
          content: buildToolStormReflection(stormVerdict),
        });
        workingMessages = compactToolResults(workingMessages, toolResultCompactionConfig);
        if (stormVerdict.maxStormsReached) {
          await onChunk(
            { type: 'error', error: 'tool_storm_limit', tool: stormVerdict.toolName, storms: stormVerdict.stormCount },
            { providerId: lastProviderId }
          );
          return {
            ok: false,
            providerId: lastProviderId,
            iterations: iter,
            error: 'tool_storm_limit',
          };
        }
        continue;
      }
      const t0 = Date.now();
      // 工具进度通过自定义 chunk type 表达,不污染 content stream (F5 fix)
      // Lynn UI 消费 type=tool_progress;非 Lynn 客户端 ignored。
      await onChunk(
        { type: 'tool_progress', event: 'start', name: tc.function.name },
        { providerId: lastProviderId }
      );
      const toolResult = await executeServerTool(tc.function.name, tc.function.arguments || '{}', { log });
      const ms = Date.now() - t0;
      const ok = toolResult && !String(toolResult).startsWith('{"error"') && !String(toolResult).startsWith('{"ok":false');
      const toolSummary = summarizeToolResult(tc.function.name, toolResult);
      await onChunk(
        { type: 'tool_progress', event: 'end', name: tc.function.name, ms, ok: !!ok, ...toolSummary },
        { providerId: lastProviderId }
      );
      workingMessages.push({
        role: 'tool',
        tool_call_id: tc.id || ('tc-' + Math.random().toString(36).slice(2)),
        content: formatToolResultContent(tc.function.name, toolResult, ++serverToolStepIndex),
      });
      workingMessages = compactToolResults(workingMessages, toolResultCompactionConfig);
    }
  }
  // 达 MAX_ITERATIONS 上限 → emit 显式 error chunk (不再撒谎成 finish:stop)
  log && log('warn', `hit MAX_ITERATIONS=${MAX_ITERATIONS}, emit error chunk`);
  if (lastProviderId) {
    await onChunk(
      { type: 'error', error: 'max_iterations_reached', limit: MAX_ITERATIONS, iterations: iter },
      { providerId: lastProviderId }
    );
  }
  return {
    ok: false,
    providerId: lastProviderId,
    iterations: iter,
    hitMaxIterations: true,
    error: 'max_iterations_reached',
  };
}

export function detectCapability(messages?: ChatMessage[]): CapabilityRequired {
  const result = { vision: false, audio: false, video: false };
  for (const m of (messages || [])) {
    const c = m.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (!part || typeof part !== 'object') continue;
      const typedPart = part as { type?: string };
      if (typedPart.type === 'image_url' || typedPart.type === 'input_image') result.vision = true;
      if (typedPart.type === 'input_audio' || typedPart.type === 'audio_url') result.audio = true;
      if (typedPart.type === 'input_video' || typedPart.type === 'video_url') result.video = true;
    }
  }
  return result;
}

export const __testing__ = {
  _emptyCounters,
  buildLocalProbeUrl,
  isLocalEndpoint,
  localProbeTimeoutMs,
  summarizeToolResult,
};
