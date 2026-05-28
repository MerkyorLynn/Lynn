import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSearchQuery, searchBingHtml, searchDuckDuckGoHtml } from "../lib/tools/web-search.js";

describe("web search fallback", () => {
  beforeEach(() => {
    // Keep DDG/Bing path tests deterministic by disabling the brain proxy tier.
    process.env.LYNN_DISABLE_BRAIN_SEARCH = '1';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LYNN_DISABLE_BRAIN_SEARCH;
  });

  it("parses DuckDuckGo HTML fallback results and decodes redirect urls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => `
        <html>
          <body>
            <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">Example <b>Doc</b></a>
            <a class="result__a" href="https://example.org/plain">Plain Result</a>
          </body>
        </html>
      `,
    })));

    const results = await searchDuckDuckGoHtml("lynn", 5);
    expect(results).toEqual([
      {
        title: "Example Doc",
        url: "https://example.com/doc",
        snippet: "",
      },
      {
        title: "Plain Result",
        url: "https://example.org/plain",
        snippet: "",
      },
    ]);
  });

  it("falls through to DuckDuckGo HTML when brain proxy is disabled and no paid provider is configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => `
        <html>
          <body>
            <a class="result__a" href="https://example.com/fast">Fast Result</a>
          </body>
        </html>
      `,
    })));

    const result = await runSearchQuery("OpenAI docs", 5);
    expect(result.provider).toBe("duckduckgo-html");
    expect(result.results[0]?.url).toBe("https://example.com/fast");
  });

  it("parses Bing HTML fallback results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => `
        <html>
          <body>
            <li class="b_algo">
              <h2><a href="https://finance.example.com/news">可灵融资 <strong>新闻</strong></a></h2>
              <p>快手旗下可灵 AI 被曝融资。</p>
            </li>
          </body>
        </html>
      `,
    })));

    const results = await searchBingHtml("可灵 融资", 5);
    expect(results).toEqual([
      {
        title: "可灵融资 新闻",
        url: "https://finance.example.com/news",
        snippet: "快手旗下可灵 AI 被曝融资。",
      },
    ]);
  });

  it("uses Bing first for Chinese locale and never calls DDG when Bing succeeds", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      // zh locale 主路 = Bing-first;Bing 返 OK 时 DDG 不应被调
      if (u.includes("cn.bing.com")) {
        return {
          ok: true,
          status: 200,
          text: async () => `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="https://news.example.com/kling">估值200亿美元，可灵 AI 被曝融资</a></h2>
                  <p>中文财经热点搜索结果。</p>
                </li>
              </body>
            </html>
          `,
        };
      }
      throw new Error('unexpected fetch: ' + u);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runSearchQuery("查询行情 可灵拆分融资20亿对什么A股股票会有利好", 5, { sceneHint: "finance" });

    expect(result.provider).toBe("bing-html");
    expect(result.results[0]?.title).toContain("可灵");
    // Bing called; DDG NEVER called for zh locale when Bing wins
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("cn.bing.com"), expect.any(Object));
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("duckduckgo.com"), expect.any(Object));
  });
});

describe("web search Tier 1 brain proxy", () => {
  beforeEach(() => {
    delete process.env.LYNN_DISABLE_BRAIN_SEARCH;
    process.env.BRAIN_V2_URL = 'http://127.0.0.1:8790';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BRAIN_V2_URL;
    delete process.env.LYNN_DISABLE_BRAIN_SEARCH;
  });

  it("uses brain proxy first and surfaces summary + sources", async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(String(url)).toContain('/v1/web-search');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          provider: 'mimo',
          summary: '小米 V2 已发布,定价 4999 元。',
          items: [
            { title: '小米 V2 发布会', url: 'https://example.cn/v2', snippet: '关键定价' },
            { title: '小米 V2 评测', url: 'https://example.cn/review', snippet: '上手' },
          ],
          sources: [
            { name: 'mimo', ok: true, items: [{ title: '小米 V2 发布会', url: 'https://example.cn/v2', snippet: '关键定价' }], summary: '小米 V2 已发布,定价 4999 元。' },
            { name: 'zhipu', ok: true, items: [{ title: '小米 V2 评测', url: 'https://example.cn/review', snippet: '上手' }], summary: 'GLM 综合' },
          ],
        }),
        json: async () => ({
          ok: true,
          provider: 'mimo',
          summary: '小米 V2 已发布,定价 4999 元。',
          items: [
            { title: '小米 V2 发布会', url: 'https://example.cn/v2', snippet: '关键定价' },
            { title: '小米 V2 评测', url: 'https://example.cn/review', snippet: '上手' },
          ],
          sources: [
            { name: 'mimo', ok: true, items: [{ title: '小米 V2 发布会', url: 'https://example.cn/v2', snippet: '关键定价' }], summary: '小米 V2 已发布,定价 4999 元。' },
            { name: 'zhipu', ok: true, items: [{ title: '小米 V2 评测', url: 'https://example.cn/review', snippet: '上手' }], summary: 'GLM 综合' },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runSearchQuery('小米 V2 发布', 5);
    expect(result.provider).toBe('lynn-brain/mimo');
    expect(result.summary).toContain('4999');
    expect(result.results).toHaveLength(2);
    expect(result.sources).toHaveLength(2);
    expect(result.sources?.[0].name).toBe('mimo');
    // Brain proxy was called, DDG/Bing were NOT
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v1/web-search'), expect.any(Object));
  });

  it("falls through to DDG/Bing when brain proxy returns ok=false", async () => {
    let brainCalled = false;
    let ddgCalled = false;
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/v1/web-search')) {
        brainCalled = true;
        return {
          ok: true,
          status: 503,
          text: async () => JSON.stringify({ ok: false, error: 'all search sources failed' }),
          json: async () => ({ ok: false, error: 'all search sources failed' }),
        };
      }
      if (u.includes('duckduckgo.com')) {
        ddgCalled = true;
        return {
          ok: true,
          status: 200,
          text: async () => `<a class="result__a" href="https://fallback.example.com">DDG fallback</a>`,
        };
      }
      return { ok: true, status: 200, text: async () => '' };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runSearchQuery('cascade fallback test', 5);
    expect(brainCalled).toBe(true);
    expect(ddgCalled).toBe(true);
    expect(result.provider).toBe('duckduckgo-html');
    // URL constructor normalizes bare hostnames with trailing slash
    expect(result.results[0]?.url).toBe('https://fallback.example.com/');
  });

  it("falls through to DDG/Bing when brain proxy is unreachable", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/v1/web-search')) {
        throw new Error('ECONNREFUSED 127.0.0.1:8790');
      }
      if (u.includes('duckduckgo.com')) {
        return {
          ok: true,
          status: 200,
          text: async () => `<a class="result__a" href="https://ddg.example.com">No brain available</a>`,
        };
      }
      return { ok: true, status: 200, text: async () => '' };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runSearchQuery('brain offline', 5);
    expect(result.provider).toBe('duckduckgo-html');
  });

  it("respects LYNN_DISABLE_BRAIN_SEARCH=1 and skips brain proxy entirely", async () => {
    process.env.LYNN_DISABLE_BRAIN_SEARCH = '1';
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      expect(u).not.toContain('/v1/web-search');
      if (u.includes('duckduckgo.com')) {
        return {
          ok: true,
          status: 200,
          text: async () => `<a class="result__a" href="https://direct-ddg.example.com">Direct DDG</a>`,
        };
      }
      return { ok: true, status: 200, text: async () => '' };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runSearchQuery('brain disabled', 5);
    expect(result.provider).toBe('duckduckgo-html');
  });
});
