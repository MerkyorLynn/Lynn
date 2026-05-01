import { describe, expect, it, vi } from "vitest";
import { ProactiveRecall } from "../lib/memory/proactive-recall.js";

describe("ProactiveRecall category-aware recall", () => {
  it("passes pitfall preferences to the retriever and formats them as notes", async () => {
    const retriever = {
      search: vi.fn(async () => [
        {
          id: 1,
          fact: "V8 timeout 曾经导致工具调用门禁卡死，先查 streaming 结束事件。",
          category: "pitfall",
        },
      ]),
    };
    const recall = new ProactiveRecall({
      factStore: { get size() { return 1; } },
      experienceDir: null,
      experienceIndexPath: null,
      isMemoryEnabled: () => true,
    });
    recall.setRetriever(retriever);

    const result = await recall.recall("V8 门禁 timeout 是不是踩过坑？", {
      projectTags: ["lynn"],
      projectPath: "/repo/lynn",
    });

    expect(retriever.search).toHaveBeenCalledTimes(1);
    expect(retriever.search.mock.calls[0][2]).toMatchObject({
      projectPath: "/repo/lynn",
      preferredCategories: expect.arrayContaining(["pitfall", "model_benchmark"]),
    });
    expect(result.preferredCategories).toContain("pitfall");

    const formatted = recall.formatForInjection(result, true);
    expect(formatted).toContain("注意事项");
    expect(formatted).toContain("streaming 结束事件");
  });
});
