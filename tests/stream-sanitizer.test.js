// stream-sanitizer 测试
// 目标:伪工具/内部标签不泄漏给用户,但普通文本与 progress marker 检测仍保持稳定。
import { describe, expect, it } from "vitest";

import {
  containsNonProgressPseudoToolSimulation,
  stripStreamingPseudoToolBlocks,
} from "../server/chat/stream-sanitizer.js";

describe("stream sanitizer", () => {
  it("passes plain text through unchanged", () => {
    expect(stripStreamingPseudoToolBlocks({}, "普通回答，没有内部标签。")).toEqual({
      text: "普通回答，没有内部标签。",
      suppressed: false,
    });
  });

  it("suppresses shared-registry pseudo XML chunks across boundaries", () => {
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

  it("suppresses orphan backend template fragments while preserving visible answer text", () => {
    const ss = {};
    const out = stripStreamingPseudoToolBlocks(ss, "_calls></inv> </_calls>\n最终答案：建议带伞。");
    expect(out.suppressed).toBe(true);
    expect(out.text).toContain("最终答案");
    expect(out.text).not.toContain("_calls");
  });

  it("suppresses Qwen tool-code blocks + think tags", () => {
    const ss = {};
    const out = stripStreamingPseudoToolBlocks(
      ss,
      "</think>\n<|tool_code_begin|>bash\nfind ~/Downloads -name '*.zip'\n<|tool_code_end|>\n完成。",
    );
    expect(out.suppressed).toBe(true);
    expect(out.text).toContain("完成。");
    expect(out.text).not.toContain("tool_code");
    expect(out.text).not.toContain("</think>");
  });

  it("suppresses Qwen tool-code chunks across boundaries", () => {
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
    expect(xml.text).toContain("完成。");
    expect(xml.text).not.toContain("find_files");

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
    expect(next.text).toContain("已处理。");
  });

  it("ignores progress markers for pseudo-tool detection (containsNonProgressPseudoToolSimulation 仍 active)", () => {
    expect(containsNonProgressPseudoToolSimulation(
      '<lynn_tool_progress event="start" name="web_search"></lynn_tool_progress>',
    )).toBe(false);
    expect(containsNonProgressPseudoToolSimulation(
      '<lynn_tool_progress event="start" name="web_search"></lynn_tool_progress><web_search>深圳天气</web_search>',
    )).toBe(true);
  });
});
