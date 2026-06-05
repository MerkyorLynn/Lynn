import type { ServerResponse } from 'node:http';
import type { ChunkMeta, FallbackEntry, ProviderId, StreamChunk } from './types.js';

// Brain v2 · stream-bridge
// 把 router emit 的标准 Chunk 转成 OpenAI compat SSE
//
// Chunk 类型:
//   { type: 'reasoning', delta: string }
//   { type: 'content',   delta: string }
//   { type: 'tool_call_delta', delta: Array<{index, id?, function?: {name?, arguments?}}> }
//   { type: 'usage', usage: unknown }
//   { type: 'finish',    reason: string }
//   { type: 'tool_progress', event: 'start'|'end', name: string, ms?: number, ok?: boolean, summary?: string, details?: string[] }
//   { type: 'error', error: string, ...extra }

type SSEEmitterOptions = { id: string; model?: string };
type ProviderMeta = { active_provider: ProviderId; fallback_from?: FallbackEntry[] };

export function makeSSEEmitter(res: ServerResponse, { id, model = 'lynn-v2' }: SSEEmitterOptions) {
  const created = Math.floor(Date.now() / 1000);
  const originalModel = model;        // C13: preserve client-requested model in SSE chunks
  let currentProviderId: ProviderId | null = null;
  let writableEnded = false;
  let errored = false;                // C25: skip [DONE] on error

  function write(payload: unknown) {
    if (writableEnded) return;
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  }

  // C11: SSE keep-alive heartbeat every 15s — avoid proxy idle-close on slow upstream
  const heartbeat = setInterval(() => {
    if (writableEnded) return;
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  function emitRole() {
    write({
      id, object: 'chat.completion.chunk', created, model: originalModel,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
  }

  function emitChunk(chunk: StreamChunk, meta: Partial<ChunkMeta> = {}) {
    if (meta.providerId && meta.providerId !== currentProviderId) {
      currentProviderId = meta.providerId;
      // 2026-05-25 P0-1: 在 provider 切换(包括 first emit)时,把 fallback chain 一并发给 UI,
      // 让用户看到"StepFun → Spark fallback (probe-failed)"。fallback_from 来自 router 的
      // fallbackChain 数组(skipped/failed providers 顺序列表 [{id, reason}])。
      const providerMeta: ProviderMeta = { active_provider: meta.providerId };
      if (Array.isArray(meta.fallback_from) && meta.fallback_from.length > 0) {
        providerMeta.fallback_from = meta.fallback_from;
      }
      write({ id, object: 'lynn.provider', created, model: originalModel, meta: providerMeta });
    }
    if (chunk.type === 'reasoning') {
      write({ id, object: 'chat.completion.chunk', created, model: originalModel,
              choices: [{ index: 0, delta: { reasoning_content: chunk.delta }, finish_reason: null }] });
    } else if (chunk.type === 'content') {
      write({ id, object: 'chat.completion.chunk', created, model: originalModel,
              choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null }] });
    } else if (chunk.type === 'tool_call_delta') {
      write({ id, object: 'chat.completion.chunk', created, model: originalModel,
              choices: [{ index: 0, delta: { tool_calls: chunk.delta }, finish_reason: null }] });
    } else if (chunk.type === 'usage') {
      write({ id, object: 'chat.completion.chunk', created, model: originalModel,
              choices: [], usage: chunk.usage });
    } else if (chunk.type === 'finish') {
      write({ id, object: 'chat.completion.chunk', created, model: originalModel,
              choices: [{ index: 0, delta: {}, finish_reason: chunk.reason || 'stop' }] });
    } else if (chunk.type === 'tool_progress') {
      // F5: server-tool 进度通过自定义 SSE object (不污染 OpenAI compat content stream)
      // Lynn UI 消费 `object: 'lynn.tool_progress'`,非 Lynn 客户端 ignored (per OpenAI spec)
      write({
        id, object: 'lynn.tool_progress', created, model: originalModel,
        tool_progress: {
          event: chunk.event,
          name: chunk.name,
          ...(typeof chunk.ms === 'number' ? { ms: chunk.ms } : {}),
          ...(typeof chunk.ok === 'boolean' ? { ok: chunk.ok } : {}),
          ...(typeof chunk.summary === 'string' && chunk.summary ? { summary: chunk.summary } : {}),
          ...(Array.isArray(chunk.details) && chunk.details.length ? { details: chunk.details } : {}),
        },
      });
    } else if (chunk.type === 'error') {
      // F7: max_iterations_reached / capability error 等 — 明确告知客户端不撒谎成 stop
      errored = true;
      write({
        id, object: 'lynn.error', created, model: originalModel,
        error: chunk.error,
        ...Object.fromEntries(Object.entries(chunk).filter(([k]) => k !== 'type' && k !== 'error')),
      });
    }
  }

  function emitError(message: string, errors: unknown = null) {
    errored = true;
    write({ error: message, errors });
  }

  function done() {
    if (writableEnded) return;
    clearInterval(heartbeat);
    if (!errored) {
      res.write('data: [DONE]\n\n');
    }
    res.end();
    writableEnded = true;
  }

  return { emitRole, emitChunk, emitError, done };
}
