import { describe, expect, it } from "vitest";
import {
  artifactPreviewFromToolCall,
  artifactPreviewsFromContent,
} from "../server/chat/artifact-recovery.js";

describe("artifact recovery", () => {
  it("recovers create_artifact toolCall blocks with HTML content", () => {
    const preview = artifactPreviewFromToolCall({
      type: "toolCall",
      id: "call_html",
      name: "create_artifact",
      arguments: {
        type: "html",
        title: "女性泛娱乐策略",
        content: "<!doctype html><html><body><h1>报告</h1></body></html>",
      },
    });

    expect(preview).toMatchObject({
      type: "artifact",
      artifactId: "call_html",
      artifactType: "html",
      title: "女性泛娱乐策略",
      language: "html",
      recovered: true,
      recoveredFromTool: "create_artifact",
    });
    expect(preview.content).toContain("<h1>报告</h1>");
  });

  it("parses JSON string arguments from provider tool calls", () => {
    const preview = artifactPreviewFromToolCall({
      type: "toolCall",
      id: "call_json",
      name: "create_artifact",
      arguments: JSON.stringify({
        type: "html",
        title: "HTML 报告",
        content: "<html><body>ok</body></html>",
      }),
    });

    expect(preview?.artifactId).toBe("call_json");
    expect(preview?.content).toContain("ok");
  });

  it("recovers artifact previews from mixed assistant content", () => {
    const previews = artifactPreviewsFromContent([
      { type: "text", text: "准备生成" },
      { type: "toolCall", name: "web_search", arguments: { query: "x" } },
      {
        type: "toolCall",
        name: "create_artifact",
        arguments: {
          title: "Recovered",
          content: "<style>body{}</style><main>hello</main>",
        },
      },
    ]);

    expect(previews).toHaveLength(1);
    expect(previews[0].artifactType).toBe("html");
    expect(previews[0].title).toBe("Recovered");
  });

  it("ignores unsupported or empty tool calls", () => {
    expect(artifactPreviewFromToolCall({ type: "toolCall", name: "web_search", arguments: { query: "x" } })).toBeNull();
    expect(artifactPreviewFromToolCall({ type: "toolCall", name: "create_artifact", arguments: { title: "empty" } })).toBeNull();
    expect(artifactPreviewsFromContent("not-blocks")).toEqual([]);
  });
});
