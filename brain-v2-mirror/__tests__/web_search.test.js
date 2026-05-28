import { describe, it, expect, beforeEach, vi } from 'vitest';

// Set env keys BEFORE importing the module so racers register correctly
process.env.ZHIPU_KEY = 'test-zhipu';
process.env.MIMO_SEARCH_KEY = 'test-mimo';
delete process.env.BOCHA_KEY;
delete process.env.TAVILY_KEY;
delete process.env.SERPER_KEY;

const { webSearch, webSearchStructured, __testing__ } = await import('../tool-exec/web_search.js');

function jsonResp(obj, status = 200) {
  return { ok: status === 200, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

describe('web_search aggregator', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __testing__.cache.clear();
  });

  it('returns aggregated results when both Zhipu and MiMo succeed', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResp({  // zhipu
        choices: [{ message: { content: 'Zhipu summary', tool_calls: [{ type: 'web_search', web_search: { search_result: [{ title: 'A', link: 'http://a', content: 'a-snippet' }] } }] } }],
      }))
      .mockResolvedValueOnce(jsonResp({  // mimo
        choices: [{ message: { content: 'MiMo summary', annotations: [{ type: 'url_citation', title: 'B', url: 'http://b', summary: 'b-snippet' }] } }],
      }));
    const r = await webSearch('test query');
    expect(r).toContain('── zhipu ──');
    expect(r).toContain('── mimo ──');
    expect(r).toContain('Zhipu summary');
    expect(r).toContain('MiMo summary');
    expect(r).toContain('http://a');
    expect(r).toContain('http://b');
  });

  it('returns when only one source succeeds', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'down', json: async () => ({}) })  // zhipu fail
      .mockResolvedValueOnce(jsonResp({  // mimo OK
        choices: [{ message: { content: 'mimo only', annotations: [] } }],
      }));
    const r = await webSearch('q');
    expect(r).toContain('── mimo ──');
    expect(r).not.toContain('── zhipu ──');
    expect(r).toContain('mimo only');
  });

  it('returns error JSON when all sources fail', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => '', json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => '', json: async () => ({}) });
    const r = await webSearch('q');
    const parsed = JSON.parse(r);
    expect(parsed.error).toBe('all search sources failed');
    expect(parsed.detail).toHaveLength(2);
  });

  it('caches successful results (5min LRU)', async () => {
    let fetchCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      fetchCount++;
      return Promise.resolve(jsonResp({ choices: [{ message: { content: 'cached!', annotations: [] } }] }));
    });
    const r1 = await webSearch('cache-test');
    const r2 = await webSearch('cache-test');
    expect(r1).toBe(r2);
    expect(fetchCount).toBe(2);  // only Zhipu+MiMo on first call (no Bocha/Tavily/Serper)
  });

  it('returns error for empty query without calling fetch', async () => {
    global.fetch = vi.fn();
    const r = await webSearch('');
    expect(JSON.parse(r).error).toBe('empty query');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('skips optional racers when env keys absent (only zhipu+mimo called)', async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(jsonResp({ choices: [{ message: { content: 'x', annotations: [] } }] }));
    });
    await webSearch('opt-test');
    expect(calls).toBe(2);  // only zhipu + mimo, no bocha/tavily/serper
  });

  it('includes optional racers when their env key is set', async () => {
    process.env.BOCHA_KEY = 'test-bocha';
    __testing__.cache.clear();
    let calls = 0;
    global.fetch = vi.fn().mockImplementation((url) => {
      calls++;
      if (url.includes('bochaai')) {
        return Promise.resolve(jsonResp({ data: { webPages: { value: [{ name: 'Bocha', url: 'http://bo', snippet: 'bo!' }] } } }));
      }
      return Promise.resolve(jsonResp({ choices: [{ message: { content: 'x', annotations: [] } }] }));
    });
    const r = await webSearch('with-bocha');
    expect(calls).toBe(3);  // zhipu + mimo + bocha
    expect(r).toContain('── bocha ──');
    delete process.env.BOCHA_KEY;
  });
});

describe('webSearchStructured (Lynn brain proxy backend)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __testing__.cache.clear();
    __testing__.structuredCache.clear();
  });

  it('returns structured items + summary + per-source trace when MiMo and Zhipu succeed', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResp({  // zhipu
        choices: [{ message: { content: 'GLM 综合答案', tool_calls: [{ type: 'web_search', web_search: { search_result: [{ title: 'Z', link: 'http://z', content: 'z-snip' }] } }] } }],
      }))
      .mockResolvedValueOnce(jsonResp({  // mimo
        choices: [{ message: { content: 'MiMo 综合答案', annotations: [{ type: 'url_citation', title: 'M', url: 'http://m', summary: 'm-snip' }] } }],
      }));
    const r = await webSearchStructured('结构化测试');
    expect(r.ok).toBe(true);
    // primary should be MiMo or Zhipu (LLM-summarized), not random
    expect(['mimo', 'zhipu']).toContain(r.provider);
    expect(r.summary).toMatch(/综合答案/);
    // items deduped across sources
    const urls = r.items.map((it) => it.url);
    expect(urls).toContain('http://m');
    expect(urls).toContain('http://z');
    // sources trace contains both racers
    const names = r.sources.map((s) => s.name).sort();
    expect(names).toEqual(['mimo', 'zhipu']);
    expect(r.sources.every((s) => s.ok)).toBe(true);
  });

  it('falls back to non-summary source when MiMo and Zhipu both fail and Bocha is configured', async () => {
    process.env.BOCHA_KEY = 'test-bocha';
    __testing__.structuredCache.clear();
    global.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes('bochaai')) {
        return Promise.resolve(jsonResp({ data: { webPages: { value: [{ name: 'Bocha Article', url: 'http://b', snippet: 'b-snip' }] } } }));
      }
      return Promise.resolve({ ok: false, status: 500, text: async () => 'down', json: async () => ({}) });
    });
    const r = await webSearchStructured('mimo-zhipu-down');
    expect(r.ok).toBe(true);
    expect(r.provider).toBe('bocha');
    expect(r.summary).toBeUndefined();
    expect(r.items).toEqual([
      { title: 'Bocha Article', url: 'http://b', snippet: 'b-snip' },
    ]);
    delete process.env.BOCHA_KEY;
  });

  it('returns ok=false when all racers fail', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '', json: async () => ({}) });
    const r = await webSearchStructured('all-down');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('all search sources failed');
    expect(r.sources.every((s) => !s.ok)).toBe(true);
  });

  it('rejects empty query without calling fetch', async () => {
    global.fetch = vi.fn();
    const r = await webSearchStructured('');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('empty query');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('serves the second call from the structured cache', async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(jsonResp({ choices: [{ message: { content: 'cached', annotations: [{ type: 'url_citation', title: 'C', url: 'http://c', summary: 'c-snip' }] } }] }));
    });
    const a = await webSearchStructured('cache-key-q');
    const b = await webSearchStructured('cache-key-q');
    expect(a).toBe(b);
    expect(calls).toBe(2);  // zhipu + mimo, only on first call
  });
});
