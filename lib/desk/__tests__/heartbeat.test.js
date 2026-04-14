import { describe, expect, it } from "vitest";

import { hasActionableJianContent } from "../heartbeat.js";

describe("heartbeat jian gating", () => {
  it("does not wake the model for plain notes or recent execution logs", () => {
    const content = [
      "# 今天的计划",
      "",
      "- [x] 发 V0.75.5",
      "",
      "## 最近执行",
      "- 04-11 15:00 巡检：巡检完毕，一切正常",
    ].join("\n");

    expect(hasActionableJianContent(content, "zh-CN")).toBe(false);
  });

  it("wakes the model for unfinished todos", () => {
    expect(hasActionableJianContent("- [ ] 整理桌面并合并报表", "zh-CN")).toBe(true);
  });

  it("does not keep waking the model for already scheduled recurring todos", () => {
    const content = "- [ ] 每天 09:00 整理日报 ⏰ 自动任务 · 下次 04-12 09:00";
    expect(hasActionableJianContent(content, "zh-CN")).toBe(false);
  });

  it("still detects new recurring todos before they are scheduled", () => {
    expect(hasActionableJianContent("- [ ] 每周一 09:30 汇总周报", "zh-CN")).toBe(true);
  });
});
