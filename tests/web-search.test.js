import { afterEach, describe, expect, it, vi } from "vitest";
import { runSearchQuery, searchBingHtml, searchDuckDuckGoHtml } from "../lib/tools/web-search.js";

describe("web search fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("tries DuckDuckGo HTML before requiring a configured search provider", async () => {
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

  it("falls back to simplified Chinese query and then Bing when DuckDuckGo has no results", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("duckduckgo.com")) {
        return {
          ok: true,
          status: 200,
          text: async () => "<html><body>no results</body></html>",
        };
      }
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
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runSearchQuery("查询行情 可灵拆分融资20亿对什么A股股票会有利好", 5, { sceneHint: "finance" });

    expect(result.provider).toBe("bing-html");
    expect(result.results[0]?.title).toContain("可灵");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("duckduckgo.com"), expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("cn.bing.com"), expect.any(Object));
  });
});
