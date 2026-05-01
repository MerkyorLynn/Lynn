import { describe, expect, it } from "vitest";

import { ThinkTagParser } from "../core/events.js";

function collectEvents(input) {
  const parser = new ThinkTagParser();
  const events = [];
  parser.feed(input, (evt) => events.push(evt));
  parser.flush((evt) => events.push(evt));
  return events;
}

function collectVisibleText(input) {
  return collectEvents(input)
    .filter((evt) => evt.type === "text")
    .map((evt) => evt.data)
    .join("");
}

describe("ThinkTagParser", () => {
  it("strips a leading thinking-process header and keeps the actual answer", () => {
    const text = collectVisibleText("Here's a thinking process:\n最终答案是 42。");
    expect(text).toBe("最终答案是 42。");
  });

  it("strips a single leading think sentence without swallowing the answer body", () => {
    const text = collectVisibleText("Let me think through this. Final answer: 42.");
    expect(text).toBe("Final answer: 42.");
  });

  it("keeps the original text when the prefix-like sentence is the whole output", () => {
    const text = collectVisibleText("Let me think through this.");
    expect(text).toBe("Let me think through this.");
  });

  it("strips a leading Chinese user-intent prefix and keeps the answer body", () => {
    const text = collectVisibleText("用户要求我分析这个问题。最终答案是 42。");
    expect(text).toBe("最终答案是 42。");
  });

  it("keeps a Chinese prefix-like sentence when there is no answer body after it", () => {
    const text = collectVisibleText("用户要求我分析这个问题。");
    expect(text).toBe("用户要求我分析这个问题。");
  });

  it("suppresses Premise/Conduct/Reflection/Act planning scaffolds", () => {
    const text = collectVisibleText([
      "Premise:",
      " - User wants to move all HTML files.",
      "Conduct:",
      " - Check folder.",
      "Reflection:",
      " - No confirmation needed.",
      "Act:",
      " - Create folder and move files.",
    ].join("\n"));
    expect(text).toBe("");
  });

  it("buffers planning scaffolds across chunks instead of leaking the opening lines", () => {
    const parser = new ThinkTagParser();
    const events = [];
    parser.feed("Premise:\n - User wants files moved.\nConduct:\n - Check", (evt) => events.push(evt));
    expect(events).toEqual([]);
    parser.feed("\nReflection:\n - Continue.\nAct:\n - Move files.", (evt) => events.push(evt));
    parser.flush((evt) => events.push(evt));
    expect(events.filter((evt) => evt.type === "text")).toEqual([]);
  });
});
