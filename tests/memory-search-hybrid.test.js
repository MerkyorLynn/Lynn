import { describe, expect, it } from "vitest";
import { createMemorySearchTool } from "../lib/memory/memory-search.js";

function makeFactStore() {
  return {
    size: 2,
    searchByTags() { return []; },
    searchFullText() { return []; },
    getRelatedFacts() {
      return new Map([
        [2, [{ relation: "related_to", fact: "决定保留米色暖阳主题", category: "event" }]],
      ]);
    },
    searchByCategory() {
      return [{
        id: 2,
        fact: "用户喜欢暖纸和米色主题",
        tags: ["主题", "暖色"],
        category: "preference",
        confidence: 0.8,
        evidence: "用户多次强调保留暖阳主题",
        time: "2026-04-02T09:00",
      }];
    },
  };
}

describe("memory search hybrid path", () => {
  it("labels vector-heavy results as vector source", async () => {
    const tool = createMemorySearchTool(makeFactStore(), {
      retriever: {
        async search() {
          return [{
            id: 1,
            fact: "React suspense streaming patterns",
            tags: ["react"],
            time: "2026-04-01T10:00",
            score: 2.4,
            vectorScore: 0.8,
          }];
        },
      },
    });

    const result = await tool.execute("call-1", {
      query: "react suspense",
      tags: ["react"],
    });

    expect(result.details).toEqual({ resultCount: 1 });
    expect(result.content[0].text).toContain("React suspense streaming patterns");
  });

  it("supports category-only structured memory search", async () => {
    const tool = createMemorySearchTool(makeFactStore());

    const result = await tool.execute("call-2", {
      query: "",
      category: "preference",
    });

    expect(result.details).toEqual({ resultCount: 1 });
    expect(result.content[0].text).toContain("[preference]");
    expect(result.content[0].text).toContain("80%");
    expect(result.content[0].text).toContain("用户多次强调保留暖阳主题");
    expect(result.content[0].text).toContain("related_to: 决定保留米色暖阳主题");
  });
});
