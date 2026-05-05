// stream-sanitizer 测试 (v0.77.5 brain v1 vestigial nuke 后)
// stripStreamingPseudoToolBlocks 现在是纯 passthrough,不再 strip 任何 pseudo tool markup
// 测试目标:验证 sanitizer 不破坏 chunk 内容 + containsNonProgressPseudoToolSimulation 仍正常工作
import { describe, expect, it } from "vitest";

import {
  containsNonProgressPseudoToolSimulation,
  stripStreamingPseudoToolBlocks,
} from "../server/chat/stream-sanitizer.js";

describe("stream sanitizer (post brain v1 nuke)", () => {
  it("passes plain text through unchanged", () => {
    expect(stripStreamingPseudoToolBlocks({}, "普通回答，没有内部标签。")).toEqual({
      text: "普通回答，没有内部标签。",
      suppressed: false,
    });
  });

  it("preserves shared-registry pseudo XML chunks across boundaries (passthrough,模型自决)", () => {
    const ss = {};
    // 第一片 + 第二片各自原样透传(不再 strip)
    expect(stripStreamingPseudoToolBlocks(ss, "<apply_")).toEqual({
      text: "<apply_",
      suppressed: false,
    });
    expect(stripStreamingPseudoToolBlocks(ss, "patch>{\"cmd\":\"x\"}</apply_patch>最终答案")).toEqual({
      text: "patch>{\"cmd\":\"x\"}</apply_patch>最终答案",
      suppressed: false,
    });
  });

  it("preserves orphan backend template fragments (visible answer text untouched)", () => {
    const ss = {};
    const out = stripStreamingPseudoToolBlocks(ss, "_calls></inv> </_calls>\n最终答案：建议带伞。");
    expect(out.suppressed).toBe(false);
    expect(out.text).toContain("最终答案");
    // 也不再剥离碎片(passthrough),客户端自行决定如何渲染
    expect(out.text).toContain("_calls");
  });

  it("preserves Qwen tool-code blocks + think tags (passthrough)", () => {
    const ss = {};
    const out = stripStreamingPseudoToolBlocks(
      ss,
      "</think>\n<|tool_code_begin|>bash\nfind ~/Downloads -name '*.zip'\n<|tool_code_end|>\n完成。",
    );
    expect(out.suppressed).toBe(false);
    expect(out.text).toContain("完成。");
    expect(out.text).toContain("tool_code");  // 不再剥离
  });

  it("preserves Qwen tool-code chunks across boundaries", () => {
    const ss = {};
    expect(stripStreamingPseudoToolBlocks(ss, "<|tool_code_begin|>bash\nfind ~/Downloads")).toEqual({
      text: "<|tool_code_begin|>bash\nfind ~/Downloads",
      suppressed: false,
    });
    expect(stripStreamingPseudoToolBlocks(ss, " -name '*.zip'\n<|tool_code_end|>已处理。")).toEqual({
      text: " -name '*.zip'\n<|tool_code_end|>已处理。",
      suppressed: false,
    });
  });

  it("preserves file-tool XML and bare tool JSON pseudo blocks (passthrough)", () => {
    const ss = {};
    const xml = stripStreamingPseudoToolBlocks(
      ss,
      "<find_files>\n*.zzzzzztest\n\n/Users/lynn/Downloads\n</find_files>\n完成。",
    );
    expect(xml.suppressed).toBe(false);
    expect(xml.text).toContain("完成。");
    expect(xml.text).toContain("find_files");  // 不再剥离

    const json = stripStreamingPseudoToolBlocks(
      {},
      'bash\n\n{“cmd”: “find /Users/lynn/Downloads -type f -name "*zzzzzztest" 2>/dev/null”}\n',
    );
    expect(json.suppressed).toBe(false);
    expect(json.text).toContain("zzzzzztest");
  });

  it("preserves bare tool JSON pseudo blocks across chunk boundaries", () => {
    const ss = {};
    expect(stripStreamingPseudoToolBlocks(ss, "bash\n\n")).toEqual({
      text: "bash\n\n",
      suppressed: false,
    });
    const next = stripStreamingPseudoToolBlocks(
      ss,
      '{“cmd”: “find /Users/lynn/Downloads -type f -name "*zzzzzztest" 2>/dev/null”}\n已处理。',
    );
    expect(next.suppressed).toBe(false);
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
