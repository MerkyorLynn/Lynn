import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendSkill, loadSkills, skillsStorePath, type DistilledSkill } from "../src/code-skill-store.js";
import {
  skillCrystallizeEnabled,
  buildDistillPrompt,
  parseDistilledSkill,
  tokenize,
  scoreSkillMatch,
  recallSkills,
  formatSkillRecallFrame,
} from "../src/code-skill-distill.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-skill-"));
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
  it("defaults off, on with LYNN_CLI_SKILL_CRYSTALLIZE=1", () => {
    expect(skillCrystallizeEnabled({})).toBe(false);
    expect(skillCrystallizeEnabled({ LYNN_CLI_SKILL_CRYSTALLIZE: "1" })).toBe(true);
  });
});

describe("buildDistillPrompt", () => {
  it("asks for a strict-JSON reusable SOP and includes the task", () => {
    const p = buildDistillPrompt("refactor auth", "done");
    expect(p).toContain("STRICT JSON");
    expect(p).toContain('"whenToUse"');
    expect(p).toContain('"steps"');
    expect(p).toContain("refactor auth");
  });
});

describe("parseDistilledSkill", () => {
  it("parses a valid SOP", () => {
    const text = JSON.stringify({ title: "Wire a new tool", whenToUse: "adding a CLI tool", steps: ["a", "b"], keywords: ["tool", "cli"] });
    const s = parseDistilledSkill(text, "add a tool");
    expect(s?.title).toBe("Wire a new tool");
    expect(s?.steps).toEqual(["a", "b"]);
    expect(s?.keywords).toContain("tool");
  });
  it("returns null when the model declines (empty title)", () => {
    expect(parseDistilledSkill(JSON.stringify({ title: "" }), "t")).toBeNull();
  });
  it("returns null on garbage or missing steps", () => {
    expect(parseDistilledSkill("no json", "t")).toBeNull();
    expect(parseDistilledSkill(JSON.stringify({ title: "x", steps: [] }), "t")).toBeNull();
  });
  it("falls back to task-derived keywords when none given", () => {
    const s = parseDistilledSkill(JSON.stringify({ title: "Build parser", steps: ["x"] }), "build a json parser module");
    expect(s?.keywords.length).toBeGreaterThan(0);
  });
  it("reads JSON out of a fence", () => {
    const s = parseDistilledSkill('```json\n{"title":"T","steps":["s"]}\n```', "t");
    expect(s?.title).toBe("T");
  });
});

describe("tokenize", () => {
  it("drops stopwords, short tokens, and dedupes", () => {
    const toks = tokenize("Add the retry to the fetch fetch");
    expect(toks).toContain("retry");
    expect(toks).toContain("fetch");
    expect(toks).not.toContain("the");
    expect(toks.filter((t) => t === "fetch")).toHaveLength(1);
  });
});

describe("recallSkills", () => {
  const skills = [
    skill({ id: "a", title: "Add retry to fetch", keywords: ["retry", "fetch", "network"] }),
    skill({ id: "b", title: "Format dates", keywords: ["date", "format", "time"] }),
  ];
  it("recalls the relevant skill by keyword overlap", () => {
    const r = recallSkills("please add retry to my fetch network calls", skills);
    expect(r.map((s) => s.id)).toEqual(["a"]);
  });
  it("recalls nothing below the min score", () => {
    expect(recallSkills("write a poem", skills)).toEqual([]);
  });
  it("respects the limit and sorts by score", () => {
    const r = recallSkills("retry fetch network date format time", skills, 1);
    expect(r).toHaveLength(1);
  });
  it("matches multi-word keywords by tokenizing them", () => {
    const s = [skill({ id: "m", title: "Create and verify a script", keywords: ["create file", "run script", "verify output"] })];
    // task shares "create", "script", "verify" with the tokenized keywords
    const r = recallSkills("create a python script and verify its output", s);
    expect(r.map((x) => x.id)).toEqual(["m"]);
  });
});

describe("formatSkillRecallFrame", () => {
  it("renders SOPs as a labeled, optional frame", () => {
    const frame = formatSkillRecallFrame([skill()]);
    expect(frame).toContain("Relevant SOPs");
    expect(frame).toContain("Add retry to fetch");
    expect(frame).toContain("1. wrap fetch in a loop");
  });
  it("is empty for no skills", () => {
    expect(formatSkillRecallFrame([])).toBe("");
  });
});

describe("skill store (append/load/dedup/cap)", () => {
  it("appends and loads skills", () => {
    const dir = tmpDir();
    appendSkill(dir, skill({ id: "x", title: "First" }));
    appendSkill(dir, skill({ id: "y", title: "Second" }));
    const loaded = loadSkills(dir);
    expect(loaded.map((s) => s.title)).toEqual(["First", "Second"]);
    expect(fs.existsSync(skillsStorePath(dir))).toBe(true);
  });
  it("dedupes by title (re-learn overwrites)", () => {
    const dir = tmpDir();
    appendSkill(dir, skill({ id: "old", title: "Same", steps: ["old"] }));
    appendSkill(dir, skill({ id: "new", title: "same", steps: ["new"] }));
    const loaded = loadSkills(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].steps).toEqual(["new"]);
  });
  it("caps the store size keeping the newest", () => {
    const dir = tmpDir();
    for (let i = 0; i < 5; i += 1) appendSkill(dir, skill({ id: `s${i}`, title: `T${i}` }), 3);
    const loaded = loadSkills(dir);
    expect(loaded).toHaveLength(3);
    expect(loaded.map((s) => s.title)).toEqual(["T2", "T3", "T4"]);
  });
  it("returns [] for a missing store", () => {
    expect(loadSkills(tmpDir())).toEqual([]);
  });
});
