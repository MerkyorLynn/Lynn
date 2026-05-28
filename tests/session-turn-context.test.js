import { describe, expect, it, vi } from "vitest";
import {
  clearSessionTurnContext,
  prepareSessionTurnContext,
} from "../core/session-turn-context.js";

describe("session turn context helpers", () => {
  it("prepares recall, route, skill, at-file, and turn instruction context", async () => {
    const entry = {
      session: {
        sessionManager: { getCwd: () => "/tmp/workspace" },
      },
    };
    const agent = {
      recallForMessage: vi.fn(async () => "remembered facts"),
    };
    const routeAroundBrokenToolModel = vi.fn();

    await prepareSessionTurnContext({
      entry,
      text: "请修改 app.ts 修复这个 bug",
      agent,
      imagesCount: 0,
      turnInstruction: "reply briefly",
      locale: "zh-CN",
      getSkills: () => ({
        suggestSkillsForText: () => [{ name: "ts-fix", description: "TypeScript fix" }],
      }),
      routeAroundBrokenToolModel,
    });

    expect(agent.recallForMessage).toHaveBeenCalledWith("请修改 app.ts 修复这个 bug", "/tmp/workspace");
    expect(entry._lastRecallContext).toBe("remembered facts");
    expect(entry._routeIntentValue).toBe("coding");
    expect(typeof entry._routeIntentHintContext).toBe("string");
    expect(typeof entry._scenarioContractHintContext).toBe("string");
    expect(entry._lastSkillHintContext).toContain("ts-fix");
    expect(entry._atInjectionHintContext).toContain("@app.ts");
    expect(entry._turnInstructionHintContext).toBe("reply briefly");
    expect(routeAroundBrokenToolModel).toHaveBeenCalledWith("coding");
  });

  it("clears transient context after a turn", () => {
    const entry = {
      _lastRecallContext: "memory",
      _lastSkillHintContext: "skill",
      _atInjectionHintContext: "at",
      _turnInstructionHintContext: "instruction",
      _routeIntentHintContext: "route",
      _scenarioContractHintContext: "scenario",
      _routeIntentValue: "coding",
    };

    clearSessionTurnContext(entry);

    expect(entry).toMatchObject({
      _lastRecallContext: "",
      _lastSkillHintContext: "",
      _atInjectionHintContext: "",
      _turnInstructionHintContext: "",
      _routeIntentHintContext: "",
      _scenarioContractHintContext: "",
      _routeIntentValue: "chat",
    });
  });
});
