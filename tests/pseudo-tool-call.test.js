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
    expect(containsPseudoToolSimulation("<web_search>\n今日黄金价格 2026年4月27日\n</web_search>")).toBe(true);
    expect(containsPseudoToolSimulation("<weather>\n深圳 2026年4月28日 天气预报\n</weather>")).toBe(true);
    expect(containsPseudoToolSimulation("<stock_market>\n腾讯控股 股价\n</stock_market>")).toBe(true);
    expect(containsPseudoToolSimulation('<invoke name="exec"><parameter name="command">pwd</parameter></invoke>')).toBe(true);
    expect(containsPseudoToolSimulation("<read>\n<路径>/tmp/demo</路径>\n</read>")).toBe(true);
    expect(containsPseudoToolSimulation('stock_market(query="今天金价多少")')).toBe(true);
    expect(containsPseudoToolSimulation('weather(location="北京")')).toBe(true);
    expect(containsPseudoToolSimulation('live_news(topic="AI")')).toBe(true);
    expect(containsPseudoToolSimulation("我先看一下目录结构，然后再给你建议。")).toBe(false);
  });

  it("detects global-regex pseudo patterns consistently across repeated calls", () => {
    const raw = '<weather>{"city":"北京"}';
    expect([
      containsPseudoToolSimulation(raw),
      containsPseudoToolSimulation(raw),
      containsPseudoToolSimulation(raw),
    ]).toEqual([true, true, true]);
  });

  it("keeps detection and stripping aligned for Qwen and tool-arg leak formats", () => {
    const cases = [
      '<|tool_calls_section_begin|><|tool_call_begin|>weather<|tool_call_argument_begin|>{"city":"上海"}<|tool_call_argument_end|><|tool_call_end|><|tool_calls_section_end|>',
      "list_dir path=/Users/lynn/Downloads/Lynn limit=20",
      '<bash command="ls">',
    ];

    for (const raw of cases) {
      expect(containsPseudoToolSimulation(raw)).toBe(true);
      expect(countPseudoToolMarkers(raw)).toBeGreaterThan(0);
      expect(stripPseudoToolCallMarkup(raw)).toBe("");
    }
  });

  it("detects fenced tool_params blocks as pseudo tool calls", () => {
    const raw = [
      "我来执行。",
      "```bash/tool_params",
      '{"command":"echo \\"hi\\" > hello.txt && cat hello.txt"}',
      "```",
    ].join("\n");

    expect(containsPseudoToolSimulation(raw)).toBe(true);
    expect(countPseudoToolMarkers(raw)).toBeGreaterThanOrEqual(1);
    const cleaned = stripPseudoToolCallMarkup(raw);
    expect(cleaned).toContain("我来执行。");
    expect(cleaned).not.toContain("bash/tool_params");
    expect(cleaned).not.toContain("hello.txt");
  });

  it("strips leaked backend tool-template tags and orphan fragments", () => {
    const raw = [
      "<tavily>",
      "深圳 2026年4月29日 天气预报",
      "</tavily>",
      "_calls></inv> </_calls>",
      "最终答案：明天深圳有雨，建议带伞。",
    ].join("\n");

    expect(containsPseudoToolSimulation(raw)).toBe(true);
    expect(countPseudoToolMarkers(raw)).toBeGreaterThanOrEqual(2);
    const cleaned = stripPseudoToolCallMarkup(raw);
    expect(cleaned).toContain("最终答案");
    expect(cleaned).not.toMatch(/tavily|_calls|<\/?inv/i);
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
      "<web_search>",
      "深圳天气",
      "</web_search>",
      '<invoke name="exec"><parameter name="command">pwd</parameter></invoke>',
    ].join("\n");
    expect(countPseudoToolMarkers(raw)).toBeGreaterThanOrEqual(4);
  });

  // [PIPE-NUMBERED-PSEUDO v1 · 2026-04-28] WeChat 桥接漏的 ||N tool||{json} 格式
  // 修微信反馈:"明天深圳天气\n||1read||{...}||2read||{...}...||7"
  it("strips ||N tool||{json} pipe-numbered pseudo tool format (WeChat bridge bug)", () => {
    const raw = '明天深圳天气\n||1read||{"path": "/Users/lynn/.lynn/skills/weather/SKILL.md"} ||2read||{"path": "/Users/lynn/.lynn/skills/weather/SKILL.md"} ||3read||{"path": "/Users/lynn/.lynn/skills/weather/SKILL.md"} ||4read||{"path": "/Users/lynn/.lynn/skills/weather/SKILL.md"} ||5read||{"path": "/Users/lynn/.lynn/skills/weather/SKILL.md"} ||6read||{"path": "/Users/lynn/.lynn/skills/weather/SKILL.md"} ||7';
    expect(containsPseudoToolSimulation(raw)).toBe(true);
    expect(countPseudoToolMarkers(raw)).toBe(6);
    const cleaned = stripPseudoToolCallMarkup(raw);
    expect(cleaned).toBe("明天深圳天气");
    expect(cleaned).not.toMatch(/\|\|\d+/);
  });

  it("does not false-positive on legit markdown tables (double-pipe)", () => {
    const raw = "| 列1 | 列2 |\n|---|---|\n| a | b |\n表格正常显示。";
    expect(containsPseudoToolSimulation(raw)).toBe(false);
    expect(stripPseudoToolCallMarkup(raw)).toContain("表格正常显示");
  });
});
