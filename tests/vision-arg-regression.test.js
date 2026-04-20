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

describe("[VISION-ARG-FIX v0.76.5] pi-sdk prompt signature regression guard", () => {
  it.each(GUARDED_FILES)(
    "%s · does not wrap images as { images: opts.images } object",
    (file) => {
      const src = readSource(file);
      // 匹配错误模式：{ images: opts.images } 或 { images: opts?.images }
      const badWrapping = /\{\s*images\s*:\s*opts\??\.images\s*\}/g;
      const matches = src.match(badWrapping) || [];
      expect(
        matches,
        `Found ${matches.length} instance(s) of { images: opts.images } object wrapping in ${file}. ` +
        `pi-agent-core.prompt(input, images?: ImageContent[]) expects images as a direct array, not wrapped in an object. ` +
        `Fix: const _imagesArg = opts?.images?.length ? opts.images : undefined;`,
      ).toHaveLength(0);
    },
  );

  it.each(GUARDED_FILES)(
    "%s · session.prompt() second argument is never a bare { images: ... } object literal",
    (file) => {
      const src = readSource(file);
      // 匹配：session.prompt(something, { images  ← 这种直接传对象字面量
      //       或 this._session.prompt(..., { images
      const wrappedAtCallsite = /\.prompt\s*\([^,)]+,\s*\{\s*images\b/g;
      const matches = src.match(wrappedAtCallsite) || [];
      expect(
        matches,
        `Found ${matches.length} call site(s) in ${file} passing { images: ... } literal to session.prompt(). ` +
        `Pass images as a direct array instead.`,
      ).toHaveLength(0);
    },
  );

  it("session-coordinator.js marks the fix with [VISION-ARG-FIX v0.76.5] comment", () => {
    const src = readSource("core/session-coordinator.js");
    const markerCount = (src.match(/\[VISION-ARG-FIX v0\.76\.5\]/g) || []).length;
    expect(
      markerCount,
      "session-coordinator.js should have 2 [VISION-ARG-FIX v0.76.5] markers (one per prompt call site).",
    ).toBe(2);
  });

  it("bridge-session-manager.js marks the fix with [VISION-ARG-FIX v0.76.5] comment", () => {
    const src = readSource("core/bridge-session-manager.js");
    const markerCount = (src.match(/\[VISION-ARG-FIX v0\.76\.5\]/g) || []).length;
    expect(
      markerCount,
      "bridge-session-manager.js should have 1 [VISION-ARG-FIX v0.76.5] marker at the prompt call site.",
    ).toBe(1);
  });

  it("@mariozechner/pi-agent-core.d.ts still declares prompt(input, images?)", () => {
    // 如果 pi-sdk 升级改了签名，提早警报 · 告诉我们要重新审 VISION-ARG-FIX
    const agentDts = path.join(
      REPO_ROOT,
      "node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts",
    );
    if (!fs.existsSync(agentDts)) {
      // 在 CI 没装 node_modules 的环境下，跳过（不算失败）
      return;
    }
    const src = fs.readFileSync(agentDts, "utf8");
    const hasExpectedSig = /prompt\s*\(\s*input\s*:\s*string\s*,\s*images\?\s*:\s*ImageContent\[\]\s*\)/.test(src);
    expect(
      hasExpectedSig,
      "@mariozechner/pi-agent-core 的 prompt() 签名已变。请重新审视 core/session-coordinator.js 和 core/bridge-session-manager.js 的 _imagesArg 逻辑。",
    ).toBe(true);
  });
});
