// Tool summary web_search surface — verifies the brain-proxy details.summary
// and details.sources land on publicSummary.webSearch so the UI can render
// the WebSearchSourcesPanel below the synthesized answer.
//
// Style follows tests/STYLE.md: English describe/it names, no global mocks.

import { describe, expect, it } from "vitest";
import { summarizeToolExecution } from "../server/chat/tool-summary.js";

describe("summarizeToolExecution for web_search", () => {
  it("surfaces brain-proxy synthesized summary + sources onto publicSummary.webSearch", () => {
    const result = summarizeToolExecution({
      toolName: "web_search",
      args: { query: "小米 V2 发布" },
      isError: false,
      result: {
        content: [{ type: "text", text: "📋 综合答案：\n小米 V2 已发布,定价 4999 元。\n\n搜索结果 (via lynn-brain/mimo):\n1. **小米 V2 发布会**\n   https://example.cn/v2" }],
        details: {
          provider: "lynn-brain/mimo",
          summary: "小米 V2 已发布,定价 4999 元。",
          sources: [
            {
              name: "mimo",
              ok: true,
              items: [
                { title: "小米 V2 发布会", url: "https://example.cn/v2", snippet: "关键定价" },
              ],
              summary: "MiMo 综合: 小米 V2 4999 元",
            },
            {
              name: "zhipu",
              ok: true,
              items: [
                { title: "小米 V2 评测", url: "https://example.cn/review", snippet: "上手体验" },
              ],
              summary: "GLM 综合: 评测要点",
            },
          ],
        },
      },
    });

    expect(result.publicSummary).toBeDefined();
    expect(result.publicSummary.outputPreview).toContain("综合答案");
    expect(result.publicSummary.webSearch).toEqual({
      provider: "lynn-brain/mimo",
      summary: "小米 V2 已发布,定价 4999 元。",
      sources: [
        {
          name: "mimo",
          ok: true,
          error: undefined,
          items: [
            { title: "小米 V2 发布会", url: "https://example.cn/v2", snippet: "关键定价" },
          ],
          summary: "MiMo 综合: 小米 V2 4999 元",
        },
        {
          name: "zhipu",
          ok: true,
          error: undefined,
          items: [
            { title: "小米 V2 评测", url: "https://example.cn/review", snippet: "上手体验" },
          ],
          summary: "GLM 综合: 评测要点",
        },
      ],
    });
  });

  it("omits webSearch when details has no synthesized fields (paid Tavily or DDG tier)", () => {
    const result = summarizeToolExecution({
      toolName: "web_search",
      args: { query: "openai docs" },
      isError: false,
      result: {
        content: [{ type: "text", text: "Search results (via duckduckgo-html): ..." }],
        // tier 3 zero-config DDG/Bing returns no summary, no sources structure
        details: { scene: "general", provider: "duckduckgo-html", preferredSources: [] },
      },
    });

    expect(result.publicSummary.outputPreview).toContain("Search results");
    expect(result.publicSummary.webSearch).toBeUndefined();
  });

  it("filters failed sources to ok-only and accepts string-typed error info", () => {
    const result = summarizeToolExecution({
      toolName: "web_search",
      args: { query: "partial fail" },
      isError: false,
      result: {
        content: [{ type: "text", text: "x" }],
        details: {
          provider: "lynn-brain/mimo",
          summary: "已综合",
          sources: [
            { name: "mimo", ok: true, items: [{ title: "T", url: "https://t", snippet: "s" }], summary: "ok summary" },
            { name: "zhipu", ok: false, error: "zhipu HTTP 500", items: [] },
            { name: "tavily", ok: false, error: "tavily timeout 14000ms", items: [] },
          ],
        },
      },
    });

    expect(result.publicSummary.webSearch?.sources).toHaveLength(3);
    expect(result.publicSummary.webSearch?.sources?.[0].ok).toBe(true);
    expect(result.publicSummary.webSearch?.sources?.[1].ok).toBe(false);
    expect(result.publicSummary.webSearch?.sources?.[1].error).toBe("zhipu HTTP 500");
    expect(result.publicSummary.webSearch?.sources?.[2].error).toBe("tavily timeout 14000ms");
  });

  it("ignores malformed source entries without throwing", () => {
    const result = summarizeToolExecution({
      toolName: "web_search",
      args: { query: "bad input" },
      isError: false,
      result: {
        content: [{ type: "text", text: "x" }],
        details: {
          provider: "lynn-brain/mimo",
          summary: "ok",
          sources: [
            null,
            { ok: true, items: [] }, // missing name → dropped
            { name: "valid", ok: true, items: [{ title: "T", url: "https://t", snippet: "s" }] },
            { name: "noisy", ok: true, items: [null, { title: "ok", url: "https://ok", snippet: "good" }, "weird"] },
          ],
        },
      },
    });

    const sources = result.publicSummary.webSearch?.sources;
    expect(sources).toHaveLength(2);
    expect(sources?.[0].name).toBe("valid");
    expect(sources?.[1].name).toBe("noisy");
    expect(sources?.[1].items).toEqual([
      { title: "ok", url: "https://ok", snippet: "good" },
    ]);
  });
});
