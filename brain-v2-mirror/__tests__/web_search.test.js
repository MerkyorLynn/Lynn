import { describe, it, expect, beforeEach, vi } from 'vitest';

// Set env keys BEFORE importing the module so racers register correctly
process.env.ZHIPU_KEY = 'test-zhipu';
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

  it('returns aggregated results when Zhipu and an optional source succeed', async () => {
    process.env.BOCHA_KEY = 'test-bocha';
    __testing__.cache.clear();
    global.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes('bochaai')) {
        return Promise.resolve(jsonResp({ data: { webPages: { value: [{ name: 'Bocha Page', url: 'http://b', snippet: 'b-snippet' }] } } }));
      }
      return Promise.resolve(jsonResp({  // zhipu
        choices: [{ message: { content: 'Zhipu summary', tool_calls: [{ type: 'web_search', web_search: { search_result: [{ title: 'A', link: 'http://a', content: 'a-snippet' }] } }] } }],
      }));
    });
    const r = await webSearch('test query');
    expect(r).toContain('── zhipu ──');
    expect(r).toContain('── bocha ──');
    expect(r).toContain('Zhipu summary');
    expect(r).toContain('Bocha Page');
    expect(r).toContain('http://a');
    expect(r).toContain('http://b');
    delete process.env.BOCHA_KEY;
  });

  it('returns when only one source succeeds', async () => {
    process.env.BOCHA_KEY = 'test-bocha';
    __testing__.cache.clear();
    global.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes('bochaai')) {
        return Promise.resolve(jsonResp({ data: { webPages: { value: [{ name: 'Bocha only', url: 'http://b', snippet: 'b' }] } } }));
      }
      return Promise.resolve({ ok: false, status: 500, text: async () => 'down', json: async () => ({}) });  // zhipu fail
    });
    const r = await webSearch('q');
    expect(r).toContain('── bocha ──');
    expect(r).not.toContain('── zhipu ──');
    expect(r).toContain('Bocha only');
    delete process.env.BOCHA_KEY;
  });

  it('returns error JSON when all sources fail', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => '', json: async () => ({}) });
    const r = await webSearch('q');
    const parsed = JSON.parse(r);
    expect(parsed.error).toBe('all search sources failed');
    expect(parsed.detail).toHaveLength(1);  // only zhipu racer when no optional keys
  });

  it('caches successful results (5min LRU)', async () => {
    let fetchCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      fetchCount++;
      return Promise.resolve(jsonResp({ choices: [{ message: { content: 'cached!', tool_calls: [{ type: 'web_search', web_search: { search_result: [{ title: 'C', link: 'http://c', content: 'c' }] } }] } }] }));
    });
    const r1 = await webSearch('cache-test');
    const r2 = await webSearch('cache-test');
    expect(r1).toBe(r2);
    expect(fetchCount).toBe(1);  // only Zhipu on first call (no optional racers), cache on second
  });

  it('returns error for empty query without calling fetch', async () => {
    global.fetch = vi.fn();
    const r = await webSearch('');
    expect(JSON.parse(r).error).toBe('empty query');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('skips optional racers when env keys absent (only zhipu called)', async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(jsonResp({ choices: [{ message: { content: 'x', tool_calls: [{ type: 'web_search', web_search: { search_result: [{ title: 'X', link: 'http://x', content: 'x' }] } }] } }] }));
    });
    await webSearch('opt-test');
    expect(calls).toBe(1);  // only zhipu, no bocha/tavily/serper
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
      return Promise.resolve(jsonResp({ choices: [{ message: { content: 'x', tool_calls: [{ type: 'web_search', web_search: { search_result: [{ title: 'X', link: 'http://x', content: 'x' }] } }] } }] }));
    });
    const r = await webSearch('with-bocha');
    expect(calls).toBe(2);  // zhipu + bocha
    expect(r).toContain('── bocha ──');
    delete process.env.BOCHA_KEY;
  });

  it('includes MiMo (platform web_search) with api-key header + web_search tool when MIMO_SEARCH_KEY is set', async () => {
    process.env.MIMO_SEARCH_KEY = 'test-mimo';
    __testing__.cache.clear();
    const seen = {};
    global.fetch = vi.fn().mockImplementation((url, opts) => {
      if (String(url).includes('xiaomimimo')) {
        const body = JSON.parse(opts.body);
        seen.apiKey = opts.headers['api-key'];
        seen.tool = body.tools?.[0]?.type;
        return Promise.resolve(jsonResp({ choices: [{ message: { content: 'MiMo 摘要', annotations: [{ type: 'url_citation', title: 'M', url: 'http://m', summary: 'm-snip' }] } }] }));
      }
      return Promise.resolve(jsonResp({ choices: [{ message: { content: 'Zhipu', tool_calls: [{ type: 'web_search', web_search: { search_result: [{ title: 'Z', link: 'http://z', content: 'z' }] } }] } }] }));
    });
    const r = await webSearch('实时新闻');
    expect(seen.apiKey).toBe('test-mimo');   // api-key header per MiMo platform docs
    expect(seen.tool).toBe('web_search');    // web_search tool enabled
    expect(r).toContain('── mimo ──');
    expect(r).toContain('http://m');
    delete process.env.MIMO_SEARCH_KEY;
  });
});

describe('webSearchStructured (Lynn brain proxy backend)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __testing__.cache.clear();
    __testing__.structuredCache.clear();
  });

  it('returns structured items + summary + per-source trace when Zhipu and an optional source succeed', async () => {
    process.env.BOCHA_KEY = 'test-bocha';
    __testing__.structuredCache.clear();
    global.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes('bochaai')) {
        return Promise.resolve(jsonResp({ data: { webPages: { value: [{ name: 'Bocha Article', url: 'http://b', snippet: 'b-snip' }] } } }));
      }
      return Promise.resolve(jsonResp({  // zhipu
        choices: [{ message: { content: 'GLM 综合答案', tool_calls: [{ type: 'web_search', web_search: { search_result: [{ title: 'Z', link: 'http://z', content: 'z-snip' }] } }] } }],
      }));
    });
    const r = await webSearchStructured('结构化测试');
    expect(r.ok).toBe(true);
    // primary should be Zhipu (the only LLM-summarized source)
    expect(r.provider).toBe('zhipu');
    expect(r.summary).toMatch(/综合答案/);
    // items deduped across sources
    const urls = r.items.map((it) => it.url);
    expect(urls).toContain('http://z');
    expect(urls).toContain('http://b');
    // sources trace contains both racers
    const names = r.sources.map((s) => s.name).sort();
    expect(names).toEqual(['bocha', 'zhipu']);
    expect(r.sources.every((s) => s.ok)).toBe(true);
    delete process.env.BOCHA_KEY;
  });

  it('falls back to non-summary source when Zhipu fails and Bocha is configured', async () => {
    process.env.BOCHA_KEY = 'test-bocha';
    __testing__.structuredCache.clear();
    global.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes('bochaai')) {
        return Promise.resolve(jsonResp({ data: { webPages: { value: [{ name: 'Bocha Article', url: 'http://b', snippet: 'b-snip' }] } } }));
      }
      return Promise.resolve({ ok: false, status: 500, text: async () => 'down', json: async () => ({}) });
    });
    const r = await webSearchStructured('zhipu-down');
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
      return Promise.resolve(jsonResp({ choices: [{ message: { content: 'cached', tool_calls: [{ type: 'web_search', web_search: { search_result: [{ title: 'C', link: 'http://c', content: 'c-snip' }] } }] } }] }));
    });
    const a = await webSearchStructured('cache-key-q');
    const b = await webSearchStructured('cache-key-q');
    expect(a).toBe(b);
    expect(calls).toBe(1);  // zhipu only, on first call
  });

  it('prefers MiMo (paid platform search) as the primary provider over Zhipu', async () => {
    process.env.MIMO_SEARCH_KEY = 'test-mimo';
    __testing__.structuredCache.clear();
    global.fetch = vi.fn().mockImplementation((url) => {
      if (String(url).includes('xiaomimimo')) {
        return Promise.resolve(jsonResp({ choices: [{ message: { content: 'MiMo 综合答案', annotations: [{ type: 'url_citation', title: 'M', url: 'http://m', summary: 'm-snip' }] } }] }));
      }
      return Promise.resolve(jsonResp({ choices: [{ message: { content: 'Zhipu 答案', tool_calls: [{ type: 'web_search', web_search: { search_result: [{ title: 'Z', link: 'http://z', content: 'z' }] } }] } }] }));
    });
    const r = await webSearchStructured('结构化 mimo');
    expect(r.ok).toBe(true);
    expect(r.provider).toBe('mimo');          // MiMo preferred over Zhipu for the summary
    expect(r.summary).toMatch(/综合答案/);
    const urls = r.items.map((it) => it.url);
    expect(urls).toContain('http://m');
    expect(urls).not.toContain('http://z');   // MiMo success short-circuits fallback sources
    delete process.env.MIMO_SEARCH_KEY;
  });

  it('falls back to Zhipu when preferred MiMo search fails', async () => {
    process.env.MIMO_SEARCH_KEY = 'test-mimo';
    __testing__.structuredCache.clear();
    global.fetch = vi.fn().mockImplementation((url) => {
      if (String(url).includes('xiaomimimo')) {
        return Promise.resolve({ ok: false, status: 401, text: async () => 'bad key', json: async () => ({}) });
      }
      return Promise.resolve(jsonResp({ choices: [{ message: { content: 'Zhipu fallback', tool_calls: [{ type: 'web_search', web_search: { search_result: [{ title: 'Z', link: 'http://z', content: 'z' }] } }] } }] }));
    });
    const r = await webSearchStructured('mimo-down');
    expect(r.ok).toBe(true);
    expect(r.provider).toBe('zhipu');
    expect(r.summary).toMatch(/fallback/);
    expect(r.sources.map((s) => [s.name, s.ok])).toEqual([
      ['mimo', false],
      ['zhipu', true],
    ]);
    delete process.env.MIMO_SEARCH_KEY;
  });
});
