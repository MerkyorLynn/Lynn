import { describe, expect, it } from "vitest";

import {
  containsNonProgressPseudoToolSimulation,
  stripStreamingPseudoToolBlocks,
} from "../server/chat/stream-sanitizer.js";

describe("stream sanitizer", () => {
  it("suppresses shared-registry pseudo XML blocks across chunk boundaries", () => {
    const ss = {};

    expect(stripStreamingPseudoToolBlocks(ss, "<apply_")).toEqual({
      text: "",
      suppressed: false,
    });
    expect(stripStreamingPseudoToolBlocks(ss, "patch>{\"cmd\":\"x\"}</apply_patch>最终答案")).toEqual({
      text: "最终答案",
      suppressed: true,
    });
  });

  it("strips orphan backend template fragments without removing visible answer text", () => {
    const ss = {};
    const stripped = stripStreamingPseudoToolBlocks(ss, "_calls></inv> </_calls>\n最终答案：建议带伞。");

    expect(stripped.suppressed).toBe(true);
    expect(stripped.text).toContain("最终答案");
    expect(stripped.text).not.toMatch(/_calls|<\/?inv/i);
  });

  it("ignores progress markers for pseudo-tool detection", () => {
    expect(containsNonProgressPseudoToolSimulation(
      '<lynn_tool_progress event="start" name="web_search"></lynn_tool_progress>',
    )).toBe(false);
    expect(containsNonProgressPseudoToolSimulation(
      '<lynn_tool_progress event="start" name="web_search"></lynn_tool_progress><web_search>深圳天气</web_search>',
    )).toBe(true);
  });
});
