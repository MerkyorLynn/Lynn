import { describe, expect, it } from "vitest";

import {
  buildVisionUnsupportedMessage,
  normalizeVisionPromptText,
} from "../shared/vision-prompt.js";

const image = [{ type: "image", data: "abc", mimeType: "image/png" }];

describe("vision prompt helpers", () => {
  it("turns image-only prompts into an explicit image analysis request", () => {
    expect(normalizeVisionPromptText("", image)).toContain("请分析这张图片");
    expect(normalizeVisionPromptText("（看图）", image)).toContain("请分析这张图片");
    expect(normalizeVisionPromptText("[来自 Harvino] ", image)).toBe("[来自 Harvino] 请分析这张图片，提取主要内容，并用一段文字做总结。");
  });

  it("keeps meaningful user text intact when an image is attached", () => {
    expect(normalizeVisionPromptText("帮我看看这张截图哪里报错", image)).toBe("帮我看看这张截图哪里报错");
  });

  it("explains when the selected model cannot process images", () => {
    const text = buildVisionUnsupportedMessage();

    expect(text).toContain("当前模型不支持视觉输入");
    expect(text).toContain("重新发送图片");
  });
});
