// Brain v2 · Router tests (vi.mock provider-registry + wire-adapter for hermetic DI)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import { run, detectCapability, __testing__ } from '../router.js';

function makeProvider(id, capability = {}) {
  return {
    id, wire: 'mock', endpoint: 'http://mock', apiKey: 'k', model: 'm',
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, ...capability },
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

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BRAIN_V2_PRE_SEARCH;
  delete process.env.MIMO_SEARCH_KEY;
  delete process.env.BRAIN_V2_STORM_DETECT;
  delete process.env.BRAIN_V2_STORM_THRESHOLD;
  delete process.env.BRAIN_V2_STORM_MAX;
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

  it('probes local providers through explicit health_path before fallback use', async () => {
    mockState.cooldown.add('p-mimo');
    mockState.providers['p-spark'] = {
      ...makeProvider('p-spark'),
      endpoint: 'http://127.0.0.1:18098/v1',
      health_path: '/health',
      health_probe_ms: 25,
    };
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls.push(provider.id);
      yield { type: 'content', delta: 'spark ok' };
    };

    const r = await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async () => {} });

    expect(r.providerId).toBe('p-spark');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:18098/health', expect.any(Object));
    expect(mockState.adapterCalls).toEqual(['p-spark']);
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

  it('injects pre-search context before the selected non-native provider runs', async () => {
    process.env.BRAIN_V2_PRE_SEARCH = '1';
    process.env.MIMO_SEARCH_KEY = 'test-mimo';
    mockState.cooldown.add('p-mimo');
    mockState.providers['p-spark'] = makeProvider('p-spark', { native_search: false });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        choices: [{
          message: {
            content: '杭州今日有小雨。',
            annotations: [{ type: 'url_citation', title: 'weather', url: 'https://weather.example', summary: 'rain' }],
          },
        }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    let adapterMessages = null;
    mockState.adapterFn = async function* ({ messages }) {
      adapterMessages = messages;
      yield { type: 'content', delta: 'ok' };
    };

    const chunks = [];
    const metas = [];
    const result = await run({
      messages: [{ role: 'user', content: '今天天气怎么样' }],
      onChunk: async (chunk, meta) => {
        chunks.push(chunk);
        metas.push(meta);
      },
    });

    expect(result.providerId).toBe('p-spark');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chunks.map(c => c.type)).toEqual(['pre_search', 'content']);
    expect(chunks[0]).toMatchObject({ source: 'mimo', hit: true, cached: null });
    expect(metas[0].fallback_from).toEqual([{ id: 'p-mimo', reason: 'cooldown' }]);
    expect(adapterMessages).toHaveLength(2);
    expect(adapterMessages[0].role).toBe('system');
    expect(String(adapterMessages[0].content)).toContain('【实时信息上下文】');
    expect(adapterMessages[1].role).toBe('user');
  });

  it('suppresses repeated server tool calls when storm detection is enabled', async () => {
    process.env.BRAIN_V2_STORM_DETECT = '1';
    process.env.BRAIN_V2_STORM_THRESHOLD = '2';
    process.env.BRAIN_V2_STORM_MAX = '3';
    let adapterRuns = 0;
    mockState.adapterFn = async function* () {
      adapterRuns += 1;
      yield {
        type: 'tool_call_delta',
        delta: [{
          index: 0,
          id: `tc-${adapterRuns}`,
          type: 'function',
          function: { name: 'unit_convert', arguments: '{"query":"100公里"}' },
        }],
      };
      yield { type: 'finish', reason: 'tool_calls' };
    };

    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: '重复换算测试' }],
      onChunk: async (chunk) => chunks.push(chunk),
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'tool_storm_limit',
      providerId: 'p-mimo',
      iterations: 4,
    });
    expect(adapterRuns).toBe(4);
    expect(chunks.filter(c => c.type === 'error')).toEqual([
      expect.objectContaining({ error: 'tool_storm_limit', tool: 'unit_convert', storms: 3 }),
    ]);
    expect(chunks.filter(c => c.type === 'tool_progress' && c.event === 'end').map(c => c.ok))
      .toEqual([true, false, false, false]);
  });
});

describe('detectCapability', () => {
  it('detects vision from image_url content part', () => {
    const cap = detectCapability([{ role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image_url', image_url: { url: 'data:...' } }] }]);
    expect(cap.vision).toBe(true);
    expect(cap.audio).toBe(false);
    expect(cap.video).toBe(false);
  });
  it('detects audio from input_audio content part', () => {
    const cap = detectCapability([{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }]);
    expect(cap.audio).toBe(true);
    expect(cap.video).toBe(false);
  });
  it('detects video from video_url content part', () => {
    const cap = detectCapability([{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://x.mp4' } }] }]);
    expect(cap.video).toBe(true);
    expect(cap.vision).toBe(false);
    expect(cap.audio).toBe(false);
  });
  it('detects video from input_video content part', () => {
    const cap = detectCapability([{ role: 'user', content: [{ type: 'input_video', video_url: 'https://x.mp4' }] }]);
    expect(cap.video).toBe(true);
  });
  it('detects all three (mixed multimodal)', () => {
    const cap = detectCapability([{
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'data:...' } },
        { type: 'input_audio', input_audio: {} },
        { type: 'video_url', video_url: { url: 'https://x.mp4' } },
      ],
    }]);
    expect(cap.vision).toBe(true);
    expect(cap.audio).toBe(true);
    expect(cap.video).toBe(true);
  });
  it('returns false for plain text', () => {
    const cap = detectCapability([{ role: 'user', content: 'just text' }]);
    expect(cap.vision).toBe(false);
    expect(cap.audio).toBe(false);
    expect(cap.video).toBe(false);
  });
  it('handles empty messages array', () => {
    expect(detectCapability([])).toEqual({ vision: false, audio: false, video: false });
    expect(detectCapability(null)).toEqual({ vision: false, audio: false, video: false });
  });
});

describe('router local probe helpers', () => {
  it('builds root health URLs for local llama.cpp endpoints', () => {
    expect(__testing__.buildLocalProbeUrl({
      endpoint: 'http://127.0.0.1:18098/v1',
      health_path: '/health',
    })).toBe('http://127.0.0.1:18098/health');
  });

  it('keeps relative probe paths under the OpenAI-compatible endpoint', () => {
    expect(__testing__.buildLocalProbeUrl({
      endpoint: 'http://127.0.0.1:18098/v1',
      health_path: 'models',
    })).toBe('http://127.0.0.1:18098/v1/models');
  });
});
