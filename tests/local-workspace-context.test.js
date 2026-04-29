import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildLocalWorkspaceDirectReply,
  buildLocalWorkspaceContext,
  shouldAttachLocalWorkspaceContext,
} from "../server/chat/local-workspace-context.js";

describe("local workspace context", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-workspace-context-"));
    fs.writeFileSync(path.join(tmpDir, "jian.md"), "# 今日笺\n\n- [ ] 修复默认模型读取工作区\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "report.md"), "# 报告\n\n真实内容\n", "utf8");
    fs.mkdirSync(path.join(tmpDir, "docs"));
    fs.writeFileSync(path.join(tmpDir, "docs", "note.txt"), "nested note", "utf8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("only attaches for local workspace utility requests", () => {
    expect(shouldAttachLocalWorkspaceContext("读一下桌面Lynn文件夹", "utility")).toBe(true);
    expect(shouldAttachLocalWorkspaceContext("读一下这个项目/Users/lynn/DEV/Lynn", "utility")).toBe(true);
    expect(shouldAttachLocalWorkspaceContext("请先看看当前工作空间和笺", "utility")).toBe(true);
    expect(shouldAttachLocalWorkspaceContext("请把下载文件夹的所有后缀 zip 文件都删除", "utility")).toBe(true);
    expect(shouldAttachLocalWorkspaceContext("今天深圳天气如何", "utility")).toBe(false);
    expect(shouldAttachLocalWorkspaceContext("随便聊两句", "chat")).toBe(false);
  });

  it("does not attach workspace snapshots to internal automation prompts", () => {
    const prompt = [
      "[目录巡检] /Users/lynn/Desktop/Lynn",
      "注意：这是系统自动触发的目录巡检，不是用户发来的消息。",
      "## 笺",
      "# 今天的计划",
    ].join("\n");

    expect(shouldAttachLocalWorkspaceContext(prompt, "utility")).toBe(false);
  });

  it("builds a real local snapshot with directory and note previews", () => {
    const context = buildLocalWorkspaceContext({
      promptText: "请先看看当前工作空间和笺",
      cwd: tmpDir,
      now: new Date("2026-04-11T04:00:00Z"),
    });

    expect(context).toContain("Lynn 本地工作区快照");
    expect(context).toContain(`工作区路径：${tmpDir}`);
    expect(context).toContain("[file] jian.md");
    expect(context).toContain("[dir] docs");
    expect(context).toContain("# 今日笺");
    expect(context).toContain("不要说“没有文件系统权限”");
  });

  it("builds a direct user-facing reply for local folder reads", () => {
    const result = buildLocalWorkspaceDirectReply({
      promptText: "读一下桌面Lynn文件夹",
      cwd: tmpDir,
      now: new Date("2026-04-11T04:00:00Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("我已读取");
    expect(result.text).toContain("[文件] jian.md");
    expect(result.text).toContain("未完成事项");
    expect(result.text).toContain("修复默认模型读取工作区");
  });

  it("prefers an explicit absolute directory in the prompt over the session cwd", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-workspace-other-"));
    try {
      const result = buildLocalWorkspaceDirectReply({
        promptText: `读一下这个项目${tmpDir}`,
        cwd: otherDir,
        now: new Date("2026-04-11T04:00:00Z"),
      });

      expect(result.ok).toBe(true);
      expect(result.root).toBe(tmpDir);
      expect(result.text).toContain("[文件] jian.md");
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
