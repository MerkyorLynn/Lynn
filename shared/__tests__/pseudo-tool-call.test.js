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
    expect(containsPseudoToolSimulation('<invoke name="read_file">x</invoke>')).toBe(true);
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
      "<tool_call name=\"web_search\">x</tool_call>",
      "",
      "再继续总结",
    ].join("\n");
    expect(stripPseudoToolCallMarkup(raw)).toBe("先看一下\n\n再继续总结");
  });
});
