import { describe, expect, it } from "vitest";

import {
  containsNonProgressPseudoToolSimulation,
  stripStreamingPseudoToolBlocks,
} from "../server/chat/stream-sanitizer.js";

describe("stream sanitizer", () => {
  it("returns plain text without invoking pseudo XML state", () => {
    expect(stripStreamingPseudoToolBlocks({}, "普通回答，没有内部标签。")).toEqual({
      text: "普通回答，没有内部标签。",
      suppressed: false,
    });
  });

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

  it("suppresses Qwen tool-code blocks and orphan think close tags", () => {
    const ss = {};
    const stripped = stripStreamingPseudoToolBlocks(
      ss,
      "</think>\n<|tool_code_begin|>bash\nfind ~/Downloads -name '*.zip'\n<|tool_code_end|>\n完成。",
    );

    expect(stripped.suppressed).toBe(true);
    expect(stripped.text).toContain("完成。");
    expect(stripped.text).not.toMatch(/<\/?think|tool_code|find ~/i);
  });

  it("suppresses Qwen tool-code blocks across chunk boundaries", () => {
    const ss = {};

    expect(stripStreamingPseudoToolBlocks(ss, "<|tool_code_begin|>bash\nfind ~/Downloads")).toEqual({
      text: "",
      suppressed: true,
    });
    expect(stripStreamingPseudoToolBlocks(ss, " -name '*.zip'\n<|tool_code_end|>已处理。")).toEqual({
      text: "已处理。",
      suppressed: true,
    });
  });

  it("suppresses file-tool XML and bare tool JSON pseudo blocks", () => {
    const ss = {};
    const xml = stripStreamingPseudoToolBlocks(
      ss,
      "<find_files>\n*.zzzzzztest\n\n/Users/lynn/Downloads\n</find_files>\n完成。",
    );
    expect(xml.suppressed).toBe(true);
    expect(xml.text).toBe("\n完成。");
    expect(xml.text).not.toMatch(/find_files|zzzzzztest|Downloads/);

    const json = stripStreamingPseudoToolBlocks(
      {},
      'bash\n\n{“cmd”: “find /Users/lynn/Downloads -type f -name "*zzzzzztest" 2>/dev/null”}\n',
    );
    expect(json.suppressed).toBe(true);
    expect(json.text).toBe("");
  });

  it("suppresses bare tool JSON pseudo blocks across chunk boundaries", () => {
    const ss = {};

    expect(stripStreamingPseudoToolBlocks(ss, "bash\n\n")).toEqual({
      text: "",
      suppressed: false,
    });
    const next = stripStreamingPseudoToolBlocks(
      ss,
      '{“cmd”: “find /Users/lynn/Downloads -type f -name "*zzzzzztest" 2>/dev/null”}\n已处理。',
    );
    expect(next.suppressed).toBe(true);
    expect(next.text).toBe("\n已处理。");
    expect(next.text).not.toMatch(/bash|cmd|zzzzzztest/);
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
