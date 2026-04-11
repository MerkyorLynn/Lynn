import { describe, expect, it } from "vitest";
import {
  containsPseudoToolSimulation,
  countPseudoToolMarkers,
  stripPseudoToolCallMarkup,
} from "../shared/pseudo-tool-call.js";

describe("pseudo tool call sanitizer", () => {
  it("strips malformed pseudo tool markup while keeping trailing natural language", () => {
    const raw = [
      '<tool_call>glob pattern="*/笺*" path="/Users/lynn/Desktop/Lynn"</arg_value>我先查看一下你的工作空间和笺文件。',
      '<read_file>',
      '<path>/Users/lynn/Desktop/Lynn</path>',
      "</read_file>",
    ].join("\n");

    expect(stripPseudoToolCallMarkup(raw)).toContain("我先查看一下你的工作空间和笺文件。");
    expect(stripPseudoToolCallMarkup(raw)).not.toMatch(/tool_call|read_file|arg_value|<path>/i);
  });

  it("strips minimax pseudo tool blocks", () => {
    const raw = [
      '<minimax:tool_call>',
      '<invoke name="exec">',
      '<parameter name="description">查看工作空间结构和文件</parameter>',
      '<parameter name="command">ls -la /Users/lynn/Desktop/Lynn</parameter>',
      '</invoke>',
      '</minimax:tool_call>',
      '接下来我会整理出最值得推进的事项。',
    ].join("\n");

    const cleaned = stripPseudoToolCallMarkup(raw);
    expect(cleaned).toContain("接下来我会整理出最值得推进的事项。");
    expect(cleaned).not.toMatch(/minimax:tool_call|invoke name|parameter name/i);
  });

  it("detects pseudo tool simulation markers", () => {
    expect(containsPseudoToolSimulation('<tool_call>list_dir path="/tmp" limit="10"')).toBe(true);
    expect(containsPseudoToolSimulation('<invoke name="exec"><parameter name="command">pwd</parameter></invoke>')).toBe(true);
    expect(containsPseudoToolSimulation("<read>\n<路径>/tmp/demo</路径>\n</read>")).toBe(true);
    expect(containsPseudoToolSimulation('stock_market(query="今天金价多少")')).toBe(true);
    expect(containsPseudoToolSimulation('weather(location="北京")')).toBe(true);
    expect(containsPseudoToolSimulation('live_news(topic="AI")')).toBe(true);
    expect(containsPseudoToolSimulation("我先看一下目录结构，然后再给你建议。")).toBe(false);
  });

  it("strips read blocks with localized tags", () => {
    const raw = [
      "我理解你的提醒。让我直接使用工具接口来检查文件。",
      "<read>",
      "<路径>/Users/lynn/Desktop/Lynn/笺.md</路径>",
      "</read>",
      "接下来我会给你整理出今天最值得推进的事项。",
    ].join("\n");

    const cleaned = stripPseudoToolCallMarkup(raw);
    expect(cleaned).toContain("我理解你的提醒。让我直接使用工具接口来检查文件。");
    expect(cleaned).toContain("接下来我会给你整理出今天最值得推进的事项。");
    expect(cleaned).not.toMatch(/<read>|<\/read>|<路径>|<\/路径>/u);
  });

  it("counts repeated pseudo tool markers", () => {
    const raw = [
      "<read>",
      "<路径>/tmp/one</路径>",
      "</read>",
      '<invoke name="exec"><parameter name="command">pwd</parameter></invoke>',
    ].join("\n");
    expect(countPseudoToolMarkers(raw)).toBeGreaterThanOrEqual(4);
  });
});
