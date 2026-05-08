import { describe, it, expect, beforeEach, vi } from 'vitest';

// Set env keys BEFORE importing the module so racers register correctly
process.env.ZHIPU_KEY = 'test-zhipu';
process.env.MIMO_SEARCH_KEY = 'test-mimo';
delete process.env.BOCHA_KEY;
delete process.env.TAVILY_KEY;
delete process.env.SERPER_KEY;

const { webSearch, __testing__ } = await import('../tool-exec/web_search.js');

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
