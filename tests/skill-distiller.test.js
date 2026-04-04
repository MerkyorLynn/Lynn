import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(),
}));

vi.mock("../server/i18n.js", () => ({
  getLocale: () => "zh-CN",
}));

import { callText } from "../core/llm-client.js";
import { SkillDistiller } from "../lib/memory/skill-distiller.js";

const tempRoots = [];

function makeTempAgentDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-skill-distiller-"));
  fs.mkdirSync(path.join(dir, "learned-skills"), { recursive: true });
  tempRoots.push(dir);
  return dir;
}

function makeResolvedModel(model = "brain-default") {
  return {
    model,
    provider: "brain",
    api: "openai-completions",
    api_key: "",
    base_url: "http://example.com/v1",
    allow_missing_api_key: true,
  };
}

function writeLearnedSkill(agentDir, skillName, {
  description = "Use this skill when stabilizing a repeated workflow.",
  meta = {},
  body = "# Learned Skill\n## When to use\nUse it.\n## Steps\n1. Do it.\n",
} = {}) {
  const skillDir = path.join(agentDir, "learned-skills", skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${skillName}\ndescription: ${description}\n---\n${body}\n`, "utf-8");
  fs.writeFileSync(path.join(skillDir, "_meta.json"), JSON.stringify({
    version: 1,
    source: "auto-distilled",
    createdAt: new Date().toISOString(),
    reason: "test",
    matchedSignals: ["tool_usage"],
    usageCount: 0,
    successCount: 0,
    failureCount: 0,
    lastUsedAt: null,
    ...meta,
  }, null, 2), "utf-8");
  return skillDir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("SkillDistiller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a learned skill and records metadata", async () => {
    callText
      .mockResolvedValueOnce(JSON.stringify({
        action: "create",
        reason: "这次会话沉淀出稳定的发布收尾流程。",
        skill_name: "release-wrap-up",
        skill_md: `---
name: release-wrap-up
description: Use this skill when wrapping up a multi-step release and verification workflow.
---
# 发布收尾
## 适用场景
当需要完成多步骤发布收尾、核对输出并记录结果时使用。
## 步骤
1. 先检查关键产物和验证状态。
2. 再整理结果并补齐必要记录。
## 注意事项
- 只在发布收尾场景使用。
`,
      }))
      .mockResolvedValueOnce("safe");

    const onInstalled = vi.fn().mockResolvedValue(undefined);
    const agentDir = makeTempAgentDir();
    const distiller = new SkillDistiller({
      agentDir,
      factStore: null,
      listExistingSkills: () => [{ name: "summarize", description: "Summarize content." }],
      resolveDistillModel: () => makeResolvedModel("step-3.5-flash-2603"),
      resolveSafetyModel: () => makeResolvedModel("glm-z1-9b-0414"),
      onInstalled,
    });

    const result = await distiller.distillFromSession({
      summaryText: "这次会话里，先检查了发布产物，再核对日志和验证结果，最后把结论整理成固定格式并写入文档。整个流程使用了 read、grep、write、todo 等多个工具，已经收口完成。".repeat(3),
      sessionStats: {
        turnCount: 9,
        toolUsage: { read: 2, grep: 1, write: 1 },
      },
    });

    const skillDir = path.join(agentDir, "learned-skills", "release-wrap-up");
    expect(result.status).toBe("created");
    expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, "_meta.json"))).toBe(true);
    expect(onInstalled).toHaveBeenCalledWith("release-wrap-up", expect.objectContaining({
      matchedSignals: expect.arrayContaining(["turn_count", "tool_usage", "completion_signal"]),
    }));
  });

  it("skips when the session does not meet distillation signals", async () => {
    const distiller = new SkillDistiller({
      agentDir: makeTempAgentDir(),
      factStore: null,
      listExistingSkills: () => [],
      resolveDistillModel: () => makeResolvedModel(),
      resolveSafetyModel: () => makeResolvedModel(),
      onInstalled: vi.fn(),
    });

    const result = await distiller.distillFromSession({
      summaryText: "只是简单聊了下一个小问题，没有稳定工作流。".repeat(6),
      sessionStats: {
        turnCount: 2,
        toolUsage: {},
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("not_enough_signals");
    expect(callText).not.toHaveBeenCalled();
  });

  it("skips duplicate generated skills", async () => {
    callText.mockResolvedValueOnce(JSON.stringify({
      action: "create",
      reason: "与现有技能很像，用来验证重复去重。",
      skill_name: "summarize",
      skill_md: `---
name: summarize
description: Use this skill when summarizing content.
---
# Summarize
## When to use
Need a summary.
## Steps
1. Read.
2. Summarize.
`,
    }));

    const onInstalled = vi.fn().mockResolvedValue(undefined);
    const distiller = new SkillDistiller({
      agentDir: makeTempAgentDir(),
      factStore: null,
      listExistingSkills: () => [{ name: "summarize", description: "Use this skill when summarizing content." }],
      resolveDistillModel: () => makeResolvedModel(),
      resolveSafetyModel: () => makeResolvedModel(),
      onInstalled,
    });

    const result = await distiller.distillFromSession({
      summaryText: "这次会话确实有很多总结动作，也用了多个工具，最后顺利完成。".repeat(5),
      sessionStats: {
        turnCount: 10,
        toolUsage: { read: 1, write: 1, grep: 1 },
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("duplicate_skill");
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it("tracks learned skill usage and writes success outcomes back to metadata", async () => {
    const agentDir = makeTempAgentDir();
    writeLearnedSkill(agentDir, "release-wrap-up");

    const distiller = new SkillDistiller({
      agentDir,
      factStore: null,
      listExistingSkills: () => [],
      resolveDistillModel: () => makeResolvedModel(),
      resolveSafetyModel: () => makeResolvedModel(),
      onInstalled: vi.fn(),
      onUpdated: vi.fn(),
    });

    distiller.recordSkillActivation({
      skillName: "release-wrap-up",
      skillFilePath: path.join(agentDir, "learned-skills", "release-wrap-up", "SKILL.md"),
      sessionPath: "/tmp/session-a.jsonl",
    });
    distiller.recordSkillActivation({
      skillName: "release-wrap-up",
      skillFilePath: path.join(agentDir, "learned-skills", "release-wrap-up", "SKILL.md"),
      sessionPath: "/tmp/session-a.jsonl",
    });

    const result = await distiller.finalizeSession({
      sessionPath: "/tmp/session-a.jsonl",
      summaryText: "这次把发布收尾流程跑通了，已经修好了并顺利完成验证。",
    });

    const meta = JSON.parse(fs.readFileSync(path.join(agentDir, "learned-skills", "release-wrap-up", "_meta.json"), "utf-8"));
    expect(result.status).toBe("finalized");
    expect(result.outcome).toBe("success");
    expect(meta.usageCount).toBe(2);
    expect(meta.successCount).toBe(2);
    expect(meta.failureCount).toBe(0);
    expect(meta.lastOutcome).toBe("success");
  });

  it("revises a learned skill automatically after repeated failures", async () => {
    callText
      .mockResolvedValueOnce(JSON.stringify({
        action: "revise",
        reason: "补强失败场景下的前置检查和回退步骤。",
        skill_md: `---
name: flaky-release-skill
description: Use this skill when wrapping up a release that often fails during verification.
---
# 发布收尾（修订版）
## 适用场景
当发布收尾经常卡在验证或回退时使用。
## 步骤
1. 先检查依赖和环境前置条件。
2. 执行发布动作。
3. 如果验证失败，立即按回退步骤恢复。
## 注意事项
- 每次完成后记录失败原因。
`,
      }))
      .mockResolvedValueOnce("safe");

    const onUpdated = vi.fn().mockResolvedValue(undefined);
    const agentDir = makeTempAgentDir();
    writeLearnedSkill(agentDir, "flaky-release-skill", {
      meta: {
        usageCount: 1,
        successCount: 0,
        failureCount: 1,
      },
      body: "# 旧版技能\n## 步骤\n1. 直接做。\n",
    });

    const distiller = new SkillDistiller({
      agentDir,
      factStore: null,
      listExistingSkills: () => [],
      resolveDistillModel: () => makeResolvedModel("step-3.5-flash-2603"),
      resolveSafetyModel: () => makeResolvedModel("glm-z1-9b-0414"),
      onInstalled: vi.fn(),
      onUpdated,
    });

    distiller.recordSkillActivation({
      skillName: "flaky-release-skill",
      skillFilePath: path.join(agentDir, "learned-skills", "flaky-release-skill", "SKILL.md"),
      sessionPath: "/tmp/session-b.jsonl",
    });

    const result = await distiller.finalizeSession({
      sessionPath: "/tmp/session-b.jsonl",
      summaryText: "这次发布收尾失败了，验证阶段报错，流程没生效，需要补回退和前置检查。",
    });

    const meta = JSON.parse(fs.readFileSync(path.join(agentDir, "learned-skills", "flaky-release-skill", "_meta.json"), "utf-8"));
    const skillMd = fs.readFileSync(path.join(agentDir, "learned-skills", "flaky-release-skill", "SKILL.md"), "utf-8");
    expect(result.revised).toContain("flaky-release-skill");
    expect(meta.failureCount).toBe(2);
    expect(meta.version).toBe(2);
    expect(meta.revisionCount).toBe(1);
    expect(skillMd).toContain("回退步骤");
    expect(onUpdated).toHaveBeenCalledWith("flaky-release-skill", expect.objectContaining({
      version: 2,
    }));
  });
});
