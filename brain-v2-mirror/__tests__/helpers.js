// Test helpers: mock fetch + SSE stream builder
import { vi } from 'vitest';

// Build an async iterable body from SSE event strings
export function makeSSEBody(...events) {
  const encoder = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield encoder.encode(ev);
    },
  };
}

// Convenience: build a single SSE event from a delta object
export function sseEvent(deltaObj, opts = {}) {
  const obj = {
    choices: [{
      index: 0,
      delta: deltaObj || {},
      finish_reason: opts.finishReason || null,
    }],
  };
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

export function sseDone() {
  return 'data: [DONE]\n\n';
}

// Mock global.fetch with a sequence of responses
export function mockFetch(...responses) {
  const f = vi.fn();
  for (const r of responses) f.mockResolvedValueOnce(r);
  global.fetch = f;
  return f;
}

// Convenience response builder
export function ok(body) {
  return { ok: true, status: 200, body, text: async () => '' };
}
export function fail(status, message = '') {
  return { ok: false, status, body: makeSSEBody(), text: async () => message };
}

// Drain async iterator into array
export async function drain(asyncIter) {
  const out = [];
  for await (const c of asyncIter) out.push(c);
  return out;
}
