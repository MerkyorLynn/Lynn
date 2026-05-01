import { describe, expect, it } from "vitest";
import {
  applyRecurringTaskMarkers,
  extractRecurringJianTasks,
  upsertRecentExecutionSection,
} from "../lib/desk/jian-runtime.js";

describe("extractRecurringJianTasks", () => {
  it("识别中文每天/工作日/每周待办", () => {
    const content = [
      "# 今天",
      "- [ ] 每天早上 9 点扫描 A 股异动",
      "- [ ] 工作日 18:30 整理日报",
      "- [ ] 每周一 10:00 更新周报",
      "- [ ] 普通待办不应该进自动任务",
    ].join("\n");

    const tasks = extractRecurringJianTasks(content, "zh-CN");
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toEqual(expect.objectContaining({
      schedule: "0 9 * * *",
      taskText: "扫描 A 股异动",
      mode: "daily",
    }));
    expect(tasks[1]).toEqual(expect.objectContaining({
      schedule: "30 18 * * 1,2,3,4,5",
      taskText: "整理日报",
      mode: "weekdays",
    }));
    expect(tasks[2]).toEqual(expect.objectContaining({
      schedule: "0 10 * * 1",
      taskText: "更新周报",
      mode: "weekly",
    }));
  });

  it("跳过已经设定的待办", () => {
    const content = "- [ ] 每天 9:00 扫描异动 ⏰ 已设定";
    const tasks = extractRecurringJianTasks(content, "zh-CN");
    expect(tasks).toHaveLength(0);
  });
});

describe("applyRecurringTaskMarkers", () => {
  it("为已创建自动任务的待办打上已设定标记", () => {
    const content = [
      "- [ ] 每天早上 9 点扫描 A 股异动",
      "- [ ] 普通任务",
    ].join("\n");
    const tasks = extractRecurringJianTasks(content, "zh-CN");
    const next = applyRecurringTaskMarkers(content, [{
      ...tasks[0],
      nextRunAt: new Date(2026, 3, 6, 9, 0, 0),
    }], "zh-CN");
    expect(next).toContain("每天早上 9 点扫描 A 股异动 ⏰ 自动任务 · 下次 04-06 09:00");
    expect(next).toContain("- [ ] 普通任务");
  });
});

describe("upsertRecentExecutionSection", () => {
  it("会追加最近执行区块并保留最新记录在前", () => {
    const initial = "# 今天\n\n- [ ] 检查文档";
    const once = upsertRecentExecutionSection(initial, {
      summary: "已完成 README 检查",
      type: "heartbeat",
      label: "根目录",
      at: new Date("2026-04-06T09:15:00+08:00"),
      locale: "zh-CN",
    });
    expect(once).toContain("## 最近执行");
    expect(once).toContain("根目录 · 巡检：已完成 README 检查");

    const twice = upsertRecentExecutionSection(once, {
      summary: "日报已写回笺",
      type: "cron",
      label: "每日汇总",
      at: new Date("2026-04-06T10:00:00+08:00"),
      locale: "zh-CN",
    });
    const lines = twice
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .filter((line) => line.includes("巡检：") || line.includes("自动任务："));
    expect(lines[0]).toContain("每日汇总 · 自动任务：日报已写回笺");
    expect(lines[1]).toContain("根目录 · 巡检：已完成 README 检查");
  });

  it("不会因为相同摘要不断重复写入", () => {
    const initial = "# 今天\n\n## 最近执行\n- 04-06 09:15 根目录 · 巡检：已完成 README 检查\n";
    const next = upsertRecentExecutionSection(initial, {
      summary: "已完成 README 检查",
      type: "heartbeat",
      label: "根目录",
      at: new Date("2026-04-06T09:20:00+08:00"),
      locale: "zh-CN",
    });
    const lines = next.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(1);
  });

  it("会把自动任务接管反馈写回最近执行", () => {
    const initial = "# 今天\n\n- [ ] 每天 9:00 扫描异动\n";
    const next = upsertRecentExecutionSection(initial, {
      summary: "已接管 1 条重复待办：扫描异动（下次 09:00）",
      type: "cron",
      label: "自动任务设定",
      at: new Date("2026-04-06T08:55:00+08:00"),
      locale: "zh-CN",
    });
    expect(next).toContain("## 最近执行");
    expect(next).toContain("自动任务设定 · 自动任务：已接管 1 条重复待办：扫描异动（下次 09:00）");
  });
});
