// [VISION-ARG-FIX v0.76.5] Regression guard for pi-agent-core prompt signature.
//
// 背景：@mariozechner/pi-agent-core 0.56.3 的 Agent.prompt() 签名是：
//   prompt(input: string, images?: ImageContent[]): Promise<void>;
//
// 第二参数必须是 ImageContent 数组（或 undefined），不能是 { images: array } 这种对象包装。
// 历史上 Lynn 三个调用点把 images 包成对象后 `images.length === undefined`，
// 条件判断 `if (images && images.length > 0)` 永远 false，图片从未真正送达模型。
// 结果：用户上传图片后模型回复 "没有收到图片"。
//
// 此测试用静态扫描做守护：
//   1) 确保源码里不再出现 `{ images: opts.images }` / `{ images: opts?.images }` 之类的对象包装。
//   2) 确保 session.prompt() 的第二参数不是 `{` 起头的对象字面量。
//
// 如果未来有人重新引入这个 bug（refactor 顺手包了对象），这个测试会立刻红。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const GUARDED_FILES = [
  "core/session-coordinator.js",
  "core/bridge-session-manager.js",
];

function readSource(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("[VISION-ARG-FIX] pi-sdk prompt image-argument regression guard", () => {
  // 历史演化说明:
  //   v0.76.5: pi-agent-core prompt(input, images?: ImageContent[]) 签名 · 直接传数组
  //   v0.76.6: pi-ai 底层改成 options 对象 · 改用 toSessionPromptOptions 统一构造
  //   任何版本都不应该出现 `{ images: opts.images }` 这种裸字面量 - 那是 v0.76.5 修过的 bug
  it.each(GUARDED_FILES)(
    "%s · does not use deprecated { images: opts.images } bare literal",
    (file) => {
      const src = readSource(file);
      const badWrapping = /\{\s*images\s*:\s*opts\??\.images\s*\}/g;
      const matches = src.match(badWrapping) || [];
      expect(
        matches,
        `Found ${matches.length} instance(s) of legacy { images: opts.images } literal in ${file}. ` +
        `Use toSessionPromptOptions(opts.images) helper instead.`,
      ).toHaveLength(0);
    },
  );

  it.each(GUARDED_FILES)(
    "%s · session.prompt() uses _promptOpts variable (not inline bare { images: ... })",
    (file) => {
      const src = readSource(file);
      // 允许 session.prompt(text, _promptOpts) 或 session.prompt(text, variable_name)
      // 禁止 session.prompt(text, { images: ... }) 这种内联对象字面量
      const inlineObj = /\.prompt\s*\([^,)]+,\s*\{\s*images\b/g;
      const matches = src.match(inlineObj) || [];
      expect(
        matches,
        `Found ${matches.length} inline { images: ... } object literal at session.prompt call site in ${file}. ` +
        `Use a named variable from toSessionPromptOptions() instead.`,
      ).toHaveLength(0);
    },
  );

  it.each(GUARDED_FILES)(
    "%s · uses toSessionPromptOptions helper (v0.76.6 canonicalized) for images",
    (file) => {
      const src = readSource(file);
      // v0.76.6 之后 · 两边都应该用 toSessionPromptOptions(opts.images) 统一
      // 而不是裸传数组 · 因为 pi-ai 底层字段布局已改(source.base64 + 顶层 data/mimeType 双带)
      const usesHelper = /toSessionPromptOptions\s*\(/.test(src);
      expect(
        usesHelper,
        `${file} should use toSessionPromptOptions() helper to build prompt options with correct image shape for current pi-ai.`,
      ).toBe(true);
    },
  );

  it.each(GUARDED_FILES)(
    "%s · carries a [VISION-ARG-FIX ...] marker (any version) near prompt call site",
    (file) => {
      const src = readSource(file);
      const hasMarker = /\[VISION-ARG-FIX v0\.\d+\.\d+\]/.test(src);
      expect(
        hasMarker,
        `${file} should carry a [VISION-ARG-FIX vX.Y.Z] marker near session.prompt() to signal the image-arg invariant is being actively enforced.`,
      ).toBe(true);
    },
  );

  it("@mariozechner/pi-agent-core.d.ts prompt signature is known", () => {
    // pi-sdk 升级会改 prompt 签名 · 早期版本签名是 prompt(input: string, images?: ImageContent[])
    // v0.76.6 之后改成 prompt(input: string, options?: { images?: ImageContent[] })
    // 只要签名是这两种之一 · 就算通过;如果出现全新签名 · 测试红 · 提醒我们重新审
    const agentDts = path.join(
      REPO_ROOT,
      "node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts",
    );
    if (!fs.existsSync(agentDts)) {
      return;
    }
    const src = fs.readFileSync(agentDts, "utf8");
    const hasArraySig = /prompt\s*\(\s*input\s*:\s*string\s*,\s*images\?\s*:\s*ImageContent\[\]\s*\)/.test(src);
    const hasOptionsSig = /prompt\s*\(\s*input\s*:\s*string\s*,\s*(?:options|opts)\?\s*:/.test(src);
    expect(
      hasArraySig || hasOptionsSig,
      "@mariozechner/pi-agent-core 的 prompt() 签名已变为全新格式。请重新审视 core/session-coordinator.js 和 core/bridge-session-manager.js 的 toSessionPromptOptions 逻辑。",
    ).toBe(true);
  });
});
