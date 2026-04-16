import { afterEach, describe, expect, it, vi } from "vitest";
import { runSearchQuery, searchDuckDuckGoHtml } from "../lib/tools/web-search.js";

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
});
