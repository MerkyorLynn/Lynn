import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ActiveTaskMemory } from "../lib/memory/active-task.js";
import { createActiveTaskTool } from "../lib/tools/active-task.js";

const tmpRoots = [];

function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-active-task-test-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
  }
});

describe("ActiveTaskMemory", () => {
  it("persists and formats the current active task", () => {
    const root = makeTempRoot();
    const memory = new ActiveTaskMemory({
      filePath: path.join(root, "memory", "active-task.json"),
    });

    memory.set({
      title: "记忆系统 P0",
      goal: "让 Lynn 先召回踩坑和当前任务",
      next_step: "补测试并跑 targeted suite",
      notes: ["不要在 Spark 上新增常驻 RAG 服务"],
      project_path: "/repo/lynn",
    });

    expect(memory.get()).toMatchObject({
      title: "记忆系统 P0",
      status: "active",
      next_step: "补测试并跑 targeted suite",
    });

    const prompt = memory.formatForPrompt(true);
    expect(prompt).toContain("## 当前任务状态");
    expect(prompt).toContain("让 Lynn 先召回踩坑和当前任务");
    expect(prompt).toContain("不要在 Spark 上新增常驻 RAG 服务");
  });

  it("does not inject idle or finished tasks", () => {
    const root = makeTempRoot();
    const memory = new ActiveTaskMemory({
      filePath: path.join(root, "active-task.json"),
    });

    memory.set({ title: "done", status: "done" });
    expect(memory.formatForPrompt(true)).toBe("");

    memory.clear();
    expect(memory.get()).toBeNull();
  });

  it("updates active task state through the tool wrapper", async () => {
    const root = makeTempRoot();
    const memory = new ActiveTaskMemory({
      filePath: path.join(root, "active-task.json"),
    });
    let refreshCount = 0;
    const tool = createActiveTaskTool(memory, {
      onUpdated: () => { refreshCount += 1; },
    });

    await tool.execute("call-1", {
      action: "set",
      title: "Spark RAG decision",
      goal: "Keep memory retrieval lightweight first",
      notes: ["Do not deploy a new Spark RAG service for P0"],
    });
    await tool.execute("call-2", {
      action: "patch",
      next_step: "Run targeted memory tests",
    });

    expect(refreshCount).toBe(2);
    expect(memory.get()).toMatchObject({
      title: "Spark RAG decision",
      next_step: "Run targeted memory tests",
    });
  });
});
