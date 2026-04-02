import { describe, expect, it } from "vitest";
import { createMemorySearchTool } from "../lib/memory/memory-search.js";

function makeFactStore() {
  return {
    size: 2,
    searchByTags() { return []; },
    searchFullText() { return []; },
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
});
