import { describe, expect, it } from "vitest";

import {
  containsPseudoToolSimulation,
  countPseudoToolMarkers,
  stripPseudoToolCallMarkup,
} from "../pseudo-tool-call.js";

describe("pseudo tool detection", () => {
  it("detects function-style pseudo tool calls", () => {
    expect(containsPseudoToolSimulation('web_search(querys=["今日金价"])')).toBe(true);
    expect(containsPseudoToolSimulation('read_file(path="/tmp/a.txt")')).toBe(true);
    expect(containsPseudoToolSimulation('stock_market(query="今天金价多少")')).toBe(true);
    expect(containsPseudoToolSimulation('weather(location="北京")')).toBe(true);
    expect(containsPseudoToolSimulation('sports_score(team="湖人")')).toBe(true);
    expect(containsPseudoToolSimulation('live_news(topic="AI")')).toBe(true);
  });

  it("detects xml-style pseudo tool tags before cleanup", () => {
    expect(containsPseudoToolSimulation('<tool_call name="web_search">x</tool_call>')).toBe(true);
    expect(containsPseudoToolSimulation('<web_search>\n深圳天气\n</web_search>')).toBe(true);
    expect(containsPseudoToolSimulation('<weather location="深圳"></weather>')).toBe(true);
    expect(containsPseudoToolSimulation('<stock_market>\n今日金价\n</stock_market>')).toBe(true);
    expect(containsPseudoToolSimulation('<invoke name="read_file">x</invoke>')).toBe(true);
    expect(containsPseudoToolSimulation('<execute>\n\n</execute>')).toBe(true);
    expect(containsPseudoToolSimulation('<lynn_tool_progress event="start" name="web_search"></lynn_tool_progress>')).toBe(true);
  });

  it("detects shell-style pseudo commands", () => {
    expect(containsPseudoToolSimulation("shell: > ls /Users/lynn")).toBe(true);
    expect(containsPseudoToolSimulation("$ rg \"today\" /Users/lynn")).toBe(true);
  });

  it("counts multiple pseudo tool markers", () => {
    const raw = [
      '<tool_call name="web_search">x</tool_call>',
      '',
      'web_search(querys=["今日金价"])',
      '',
      'shell: > ls /Users/lynn',
    ].join("\n");
    expect(countPseudoToolMarkers(raw)).toBeGreaterThanOrEqual(3);
  });

  it("strips pseudo tool text while preserving surrounding prose", () => {
    const raw = [
      "先看一下",
      "",
      'web_search(querys=["今日金价"])',
      "",
      "<execute>\n\n</execute>",
      "",
      "<web_search>\n今日金价\n</web_search>",
      "",
      "<tool_call name=\"web_search\">x</tool_call>",
      "",
      "再继续总结",
    ].join("\n");
    expect(stripPseudoToolCallMarkup(raw)).toBe("先看一下\n\n再继续总结");
  });

  it("strips lynn tool-progress markers while preserving the answer text", () => {
    const raw = [
      "正在核对资料。",
      '<lynn_tool_progress event="start" name="web_search"></lynn_tool_progress>',
      "今天金价偏强。",
    ].join("");
    expect(stripPseudoToolCallMarkup(raw)).toBe("正在核对资料。今天金价偏强。");
  });

  it("detects and strips Qwen tool-code blocks plus orphan think close tags", () => {
    const raw = [
      "</think>",
      "",
      "<|tool_code_begin|>bash",
      "find ~/Downloads -name '*.zip' -delete",
      "<|tool_code_end|>",
    ].join("\n");

    expect(containsPseudoToolSimulation(raw)).toBe(true);
    expect(countPseudoToolMarkers(raw)).toBeGreaterThan(0);
    expect(stripPseudoToolCallMarkup(raw)).toBe("");
  });

  it("detects and strips file-tool XML and bare tool JSON argument blocks", () => {
    const cases = [
      "<find_files>\n*.zzzzzztest\n\n/Users/lynn/Downloads\n</find_files>",
      'bash\n\n{“cmd”: “find /Users/lynn/Downloads -type f -name "*zzzzzztest" 2>/dev/null”}',
    ];

    for (const raw of cases) {
      expect(containsPseudoToolSimulation(raw)).toBe(true);
      expect(countPseudoToolMarkers(raw)).toBeGreaterThan(0);
      expect(stripPseudoToolCallMarkup(raw)).toBe("");
    }
  });
});
