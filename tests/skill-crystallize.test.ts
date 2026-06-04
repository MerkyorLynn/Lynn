import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  skillCrystallizeEnabled,
  loadSkills,
  appendSkill,
  skillsStorePath,
  buildDistillPrompt,
  parseDistilledSkill,
  tokenize,
  recallSkills,
  formatSkillRecallFrame,
  recallSkillFrame,
  type DistilledSkill,
} from "../server/chat/skill-crystallize.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brain-skill-"));
}

function skill(over: Partial<DistilledSkill> = {}): DistilledSkill {
  return {
    id: "s1",
    title: "Add retry to fetch",
    whenToUse: "when network calls need resilience",
    steps: ["wrap fetch in a loop", "add backoff"],
    keywords: ["retry", "fetch", "network", "backoff"],
    createdAt: "2026-01-01T00:00:00Z",
    sourceTask: "add retry",
    ...over,
  };
}

describe("skillCrystallizeEnabled (opt-in)", () => {
  it("defaults off, on with BRAIN_SKILL_CRYSTALLIZE=1", () => {
    expect(skillCrystallizeEnabled({})).toBe(false);
    expect(skillCrystallizeEnabled({ BRAIN_SKILL_CRYSTALLIZE: "1" })).toBe(true);
  });
});

describe("parseDistilledSkill", () => {
  it("parses a valid SOP and declines trivial ones", () => {
    const text = JSON.stringify({ title: "Wire a tool", whenToUse: "adding a tool", steps: ["a", "b"], keywords: ["tool"] });
    expect(parseDistilledSkill(text, "add a tool")?.title).toBe("Wire a tool");
    expect(parseDistilledSkill(JSON.stringify({ title: "" }), "t")).toBeNull();
    expect(parseDistilledSkill("garbage", "t")).toBeNull();
  });
  it("reads JSON from a fence and falls back to task keywords", () => {
    const s = parseDistilledSkill('```json\n{"title":"Build parser","steps":["x"]}\n```', "build a json parser module");
    expect(s?.title).toBe("Build parser");
    expect(s?.keywords.length).toBeGreaterThan(0);
  });
});

describe("buildDistillPrompt", () => {
  it("asks for a strict-JSON reusable SOP with the task", () => {
    const p = buildDistillPrompt("refactor auth", "done");
    expect(p).toContain("STRICT JSON");
    expect(p).toContain('"steps"');
    expect(p).toContain("refactor auth");
  });
});

describe("tokenize + recall", () => {
  const skills = [
    skill({ id: "a", title: "Add retry to fetch", keywords: ["retry", "fetch", "network"] }),
    skill({ id: "b", title: "Format dates", keywords: ["date", "format", "time"] }),
  ];
  it("tokenizes (drops stopwords + dedupes, keeps CJK)", () => {
    const toks = tokenize("Add the retry to fetch 数据库 数据库");
    expect(toks).toContain("retry");
    expect(toks).not.toContain("the");
    expect(toks.filter((t) => t === "数据库")).toHaveLength(1);
  });
  it("recalls the relevant skill by keyword overlap, nothing below min score", () => {
    expect(recallSkills("add retry to my fetch network calls", skills).map((s) => s.id)).toEqual(["a"]);
    expect(recallSkills("write a poem", skills)).toEqual([]);
  });
  it("matches multi-word keywords by tokenizing them", () => {
    const s = [skill({ id: "m", title: "Create and verify a script", keywords: ["create file", "run script", "verify output"] })];
    expect(recallSkills("create a python script and verify its output", s).map((x) => x.id)).toEqual(["m"]);
  });
});

describe("formatSkillRecallFrame", () => {
  it("renders SOPs as a labeled optional frame, empty for none", () => {
    const frame = formatSkillRecallFrame([skill()]);
    expect(frame).toContain("Relevant SOPs");
    expect(frame).toContain("1. wrap fetch in a loop");
    expect(formatSkillRecallFrame([])).toBe("");
  });
});

describe("store (append/load/dedup/cap) + recallSkillFrame", () => {
  it("appends, loads, dedupes by title, caps newest", () => {
    const dir = tmpDir();
    appendSkill(dir, skill({ id: "old", title: "Same", steps: ["old"] }));
    appendSkill(dir, skill({ id: "new", title: "same", steps: ["new"] }));
    expect(loadSkills(dir)).toHaveLength(1);
    expect(loadSkills(dir)[0].steps).toEqual(["new"]);
    for (let i = 0; i < 5; i += 1) appendSkill(dir, skill({ id: `c${i}`, title: `T${i}` }), 3);
    expect(loadSkills(dir).map((s) => s.title)).toEqual(["T2", "T3", "T4"]);
    expect(fs.existsSync(skillsStorePath(dir))).toBe(true);
  });
  it("recallSkillFrame loads + recalls + formats, guarded on missing dir", () => {
    const dir = tmpDir();
    appendSkill(dir, skill({ title: "Add retry to fetch", keywords: ["retry", "fetch", "network"] }));
    expect(recallSkillFrame(dir, "add retry to fetch network")).toContain("Add retry to fetch");
    expect(recallSkillFrame(path.join(dir, "nope"), "anything")).toBe("");
  });
});
