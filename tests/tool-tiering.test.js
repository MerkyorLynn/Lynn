/**
 * tool-tiering.test.js — 工具分层裁剪回归测试
 */
import { describe, it, expect } from "vitest";
import { lookupToolTier } from "../shared/known-models.js";

// 直接测试 filterCustomToolsByTier 逻辑（从 session-coordinator 复制，保持同步）
const MINIMAL_CUSTOM_TOOLS = new Set([
  "web_search", "web_fetch", "stock_market",
]);
const STANDARD_CUSTOM_TOOLS = new Set([
  "web_search", "web_fetch", "stock_market", "todo", "present_files", "notify",
  "search_memory", "pin_memory", "unpin_memory",
  "recall_experience", "record_experience",
]);

function filterCustomToolsByTier(customTools, tier) {
  if (!tier || tier === "full") return customTools;
  const allowed = tier === "minimal" ? MINIMAL_CUSTOM_TOOLS : STANDARD_CUSTOM_TOOLS;
  return customTools.filter(t => allowed.has(t.name));
}

// 模拟工具列表
const ALL_TOOLS = [
  { name: "search_memory" }, { name: "pin_memory" }, { name: "unpin_memory" },
  { name: "recall_experience" }, { name: "record_experience" },
  { name: "web_search" }, { name: "web_fetch" }, { name: "stock_market" },
  { name: "todo" }, { name: "cron" }, { name: "present_files" },
  { name: "create_artifact" }, { name: "channel" }, { name: "browser" },
  { name: "install_skill" }, { name: "notify" }, { name: "update_settings" },
  { name: "delegate" },
];

describe("filterCustomToolsByTier", () => {
  it("full tier 返回全部工具", () => {
    expect(filterCustomToolsByTier(ALL_TOOLS, "full")).toEqual(ALL_TOOLS);
    expect(filterCustomToolsByTier(ALL_TOOLS, null)).toEqual(ALL_TOOLS);
    expect(filterCustomToolsByTier(ALL_TOOLS, undefined)).toEqual(ALL_TOOLS);
  });

  it("standard tier 保留核心工具", () => {
    const result = filterCustomToolsByTier(ALL_TOOLS, "standard");
    const names = result.map(t => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    expect(names).toContain("stock_market");
    expect(names).toContain("todo");
    expect(names).toContain("present_files");
    expect(names).toContain("notify");
    expect(names).toContain("search_memory");
    expect(names).not.toContain("delegate");
    expect(names).not.toContain("cron");
    expect(names).not.toContain("browser");
    expect(names).not.toContain("create_artifact");
    expect(result.length).toBe(11);
  });

  it("minimal tier 只保留搜索工具", () => {
    const result = filterCustomToolsByTier(ALL_TOOLS, "minimal");
    const names = result.map(t => t.name);
    expect(names).toEqual(["web_search", "web_fetch", "stock_market"]);
  });
});

describe("lookupToolTier", () => {
  it("已标注 standard 的模型返回 standard", () => {
    // qwen-max context=32768，应该被标注
    const tier = lookupToolTier("dashscope", "qwen-max");
    expect(["standard", "minimal"]).toContain(tier);
  });

  it("大模型（reasoning + 高 context）返回 null（默认 full）", () => {
    const tier = lookupToolTier("dashscope", "qwen3.5-max");
    expect(tier).toBeNull();
  });

  it("未知模型返回 null", () => {
    const tier = lookupToolTier("unknown-provider", "nonexistent-model");
    expect(tier).toBeNull();
  });
});
