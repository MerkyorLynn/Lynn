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
import { InferredProfile } from "../lib/memory/inferred-profile.js";

const tempRoots = [];

function makeTempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-inferred-profile-"));
  tempRoots.push(dir);
  return path.join(dir, "user-inferred.json");
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("InferredProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("infers and persists traits/goals from session summaries", async () => {
    callText.mockResolvedValueOnce(JSON.stringify({
      new_traits: [
        { dimension: "communication", value: "喜欢直接简洁的回答", evidence_strength: 0.9 },
        { dimension: "tech_preference", value: "偏好 TypeScript + React 技术栈", evidence_strength: 0.8 },
      ],
      updated_traits: [],
      new_goals: [
        { goal: "打造 Lynn 桌面 AI 助手产品并商业化", evidence_strength: 0.95 },
      ],
      updated_goals: [],
    }));

    const profilePath = makeTempFile();
    const inferred = new InferredProfile({ profilePath });
    const result = await inferred.inferFromSession(
      "这次对话明确提到希望 Lynn 回答更直接，并且反复讨论了 TypeScript + React 技术栈以及产品商业化目标。".repeat(3),
      { model: "test", provider: "brain", api: "openai-completions", api_key: "", base_url: "http://example.com/v1" },
    );

    expect(result.traits).toHaveLength(2);
    expect(result.goals).toHaveLength(1);
    expect(result.traits[0].value).toContain("直接简洁");
    expect(inferred.formatForPrompt(true)).toContain("用户特征：");
    expect(fs.existsSync(profilePath)).toBe(true);
  });

  it("keeps the old value when a contradicting update is weaker", () => {
    const inferred = new InferredProfile({ profilePath: makeTempFile() });
    inferred.applyInference({
      new_traits: [
        { dimension: "communication", value: "喜欢直接简洁的回答", evidence_strength: 0.8 },
      ],
      updated_traits: [],
      new_goals: [],
      updated_goals: [],
    });

    const beforeConfidence = inferred.getRawProfile().traits[0].confidence;
    inferred.applyInference({
      new_traits: [],
      updated_traits: [
        {
          dimension: "communication",
          direction: "contradict",
          new_value: "喜欢详细展开的解释",
          evidence_strength: 0.4,
        },
      ],
      new_goals: [],
      updated_goals: [],
    });

    const after = inferred.getRawProfile().traits[0];
    expect(after.value).toBe("喜欢直接简洁的回答");
    expect(after.confidence).toBeLessThan(beforeConfidence);
  });

  it("raises confidence on confirmed traits and hides low-confidence prompt items", () => {
    const inferred = new InferredProfile({ profilePath: makeTempFile() });
    inferred.applyInference({
      new_traits: [
        { dimension: "communication", value: "喜欢直接简洁的回答", evidence_strength: 0.6 },
        { dimension: "work_pattern", value: "偶尔夜间集中工作", evidence_strength: 0.2 },
      ],
      updated_traits: [],
      new_goals: [],
      updated_goals: [],
    });

    inferred.applyInference({
      new_traits: [],
      updated_traits: [
        {
          dimension: "communication",
          direction: "confirm",
          new_value: "喜欢直接简洁的回答",
          evidence_strength: 0.7,
        },
      ],
      new_goals: [],
      updated_goals: [],
    });

    const profile = inferred.getRawProfile();
    const communication = profile.traits.find((item) => item.dimension === "communication");
    const workPattern = profile.traits.find((item) => item.dimension === "work_pattern");

    expect(communication.confidence).toBeGreaterThan(0.6);
    expect(workPattern).toBeUndefined();
    expect(inferred.formatForPrompt(true)).toContain("喜欢直接简洁的回答");
  });
});
