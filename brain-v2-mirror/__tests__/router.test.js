// Brain v2 · Router tests (vi.mock provider-registry + wire-adapter for hermetic DI)
import { describe, it, expect, beforeEach, vi } from 'vitest';

// hoisted shared mock state
const mockState = vi.hoisted(() => ({
  cooldown: new Set(),
  providers: {},
  adapterFn: null,
  adapterCalls: [],
}));

vi.mock('../provider-registry.js', () => ({
  universalOrder: ['p-mimo', 'p-spark', 'p-cloud', 'p-vision'],
  getProvider: (id) => mockState.providers[id] || null,
  isInCooldown: (id) => mockState.cooldown.has(id),
  markUnhealthy: (id, reason) => mockState.cooldown.add(id),
  clearUnhealthy: (id) => mockState.cooldown.delete(id),
  PROVIDERS: mockState.providers,
}));

vi.mock('../wire-adapter/index.js', () => ({
  getAdapter: () => mockState.adapterFn,
  ADAPTERS: {},
}));

import { run, detectCapability } from '../router.js';

function makeProvider(id, capability = {}) {
  return {
    id, wire: 'mock', endpoint: 'http://mock', apiKey: 'k', model: 'm',
    capability: { vision: false, audio: false, tools: true, thinking: true, ...capability },
  };
}

async function* yieldChunks(...chunks) { for (const c of chunks) yield c; }

beforeEach(() => {
  mockState.cooldown.clear();
  mockState.providers = {
    'p-mimo':   makeProvider('p-mimo'),
    'p-spark':  makeProvider('p-spark'),
    'p-cloud':  makeProvider('p-cloud'),
    'p-vision': makeProvider('p-vision', { vision: true }),
  };
  mockState.adapterCalls = [];
  mockState.adapterFn = null;
});

describe('Router', () => {
  it('uses first provider on success', async () => {
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'hi' };
      yield { type: 'finish', reason: 'stop' };
    };
    const chunks = [];
    const r = await run({ messages: [{ role: 'user', content: 'q' }], tools: null, capabilityRequired: { vision: false, audio: false }, onChunk: async c => chunks.push(c) });
    expect(r.ok).toBe(true);
    expect(r.providerId).toBe('p-mimo');
    expect(mockState.adapterCalls).toEqual(['p-mimo']);
    expect(chunks.map(c => c.type)).toEqual(['content', 'finish']);
  });

  it('falls back on HTTP error (markUnhealthy + try next)', async () => {
    let callIdx = 0;
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      callIdx++;
      if (callIdx === 1) throw new Error('mimo HTTP 500 fail');
      yield { type: 'content', delta: 'fallback ok' };
    };
    const chunks = [];
    const r = await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async c => chunks.push(c) });
    expect(r.providerId).toBe('p-spark');
    expect(mockState.adapterCalls).toEqual(['p-mimo', 'p-spark']);
    expect(mockState.cooldown.has('p-mimo')).toBe(true);  // HTTP error 2192 markUnhealthy
  });

  it('empty-emit single hit: still tries next but no cooldown (P1#4 threshold=2)', async () => {
    let callIdx = 0;
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      callIdx++;
      if (callIdx === 1) {
        // empty: no yield
        return;
      }
      yield { type: 'content', delta: 'real answer' };
    };
    const chunks = [];
    const r = await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async c => chunks.push(c) });
    expect(r.providerId).toBe('p-spark');
    expect(mockState.cooldown.has('p-mimo')).toBe(false);  // P1#4: 1st empty doesn't cooldown yet
  });

  it('skips providers in cooldown', async () => {
    mockState.cooldown.add('p-mimo');
    mockState.cooldown.add('p-spark');
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'cloud took it' };
    };
    const r = await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async () => {} });
    expect(r.providerId).toBe('p-cloud');
    expect(mockState.adapterCalls).toEqual(['p-cloud']);
  });

  it('clears cooldown on successful provider run', async () => {
    mockState.cooldown.add('p-mimo');  // mimo was unhealthy
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'x' };
    };
    await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async () => {} });
    // p-spark succeeded, cooldown cleared for p-spark (was not set anyway)
    // p-mimo's cooldown remains (we skipped it)
    expect(mockState.cooldown.has('p-mimo')).toBe(true);  // pre-set cooldown unchanged
    expect(mockState.cooldown.has('p-spark')).toBe(false);
  });

  it('capability gate skips providers without vision when vision required', async () => {
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'visioned ok' };
    };
    const r = await run({
      messages: [{ role: 'user', content: 'describe image' }],
      capabilityRequired: { vision: true, audio: false },
      onChunk: async () => {},
    });
    expect(r.providerId).toBe('p-vision');
    expect(mockState.adapterCalls).toEqual(['p-vision']);
  });

  it('throws when all providers fail with errors collected', async () => {
    mockState.adapterFn = async function* ({ provider }) {
      throw new Error(`${provider.id} dead`);
    };
    await expect(
      run({ messages: [{ role: 'user', content: 'q' }], onChunk: async () => {} })
    ).rejects.toThrow(/all providers failed/);
  });

  it('forwards onChunk meta with providerId', async () => {
    mockState.adapterFn = async function* () {
      yield { type: 'content', delta: 'a' };
      yield { type: 'content', delta: 'b' };
    };
    const metas = [];
    await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async (c, meta) => metas.push(meta) });
    expect(metas.every(m => m.providerId === 'p-mimo')).toBe(true);
  });
});

describe('detectCapability', () => {
  it('detects vision from image_url content part', () => {
    const cap = detectCapability([{ role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image_url', image_url: { url: 'data:...' } }] }]);
    expect(cap.vision).toBe(true);
    expect(cap.audio).toBe(false);
  });
  it('detects audio from input_audio content part', () => {
    const cap = detectCapability([{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }]);
    expect(cap.audio).toBe(true);
  });
  it('returns false for plain text', () => {
    const cap = detectCapability([{ role: 'user', content: 'just text' }]);
    expect(cap.vision).toBe(false);
    expect(cap.audio).toBe(false);
  });
  it('handles empty messages array', () => {
    expect(detectCapability([])).toEqual({ vision: false, audio: false });
    expect(detectCapability(null)).toEqual({ vision: false, audio: false });
  });
});
