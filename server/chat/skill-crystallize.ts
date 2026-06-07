import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Brain-side skill crystallization (the additive, low-risk half of the CLI's
// feature, ported into the brain so the GUI gets it too):
//   ② distill a successful turn into a reusable SOP and persist it
//   ① recall the most relevant SOP(s) and PREPEND them to the assembled prompt
// Pure logic + an isolated JSON-lines store. No coupling to the streaming/tool
// machinery — recall is a string prepend; distill is a best-effort post-turn hook.
// Opt-in via BRAIN_SKILL_CRYSTALLIZE=1.

export interface DistilledSkill {
  id: string;
  title: string;
  whenToUse: string;
  steps: string[];
  keywords: string[];
  createdAt: string;
  sourceTask: string;
}

export type DistilledSkillDraft = Omit<DistilledSkill, "id" | "createdAt">;

const DEFAULT_MAX_SKILLS = 200;
const MAX_STEPS = 8;
const MAX_KEYWORDS = 12;

export function skillCrystallizeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BRAIN_SKILL_CRYSTALLIZE === "1";
}

// --- store -----------------------------------------------------------------

/** Brain user-data dir (mirrors server/index.ts: LYNN_HOME or ~/.lynn). */
export function resolveBrainDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.LYNN_HOME?.trim();
  if (home) return home.startsWith("~/") ? path.join(os.homedir(), home.slice(2)) : home;
  return path.join(os.homedir(), ".lynn");
}

export function skillsStorePath(dataDir: string): string {
  return path.join(dataDir, "skills", "distilled.jsonl");
}

export function loadSkills(dataDir: string): DistilledSkill[] {
  let raw: string;
  try {
    raw = fs.readFileSync(skillsStorePath(dataDir), "utf8");
  } catch {
    return [];
  }
  const out: DistilledSkill[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as DistilledSkill;
      if (parsed && typeof parsed.title === "string" && Array.isArray(parsed.steps)) out.push(parsed);
    } catch {
      // skip torn line
    }
  }
  return out;
}

export function appendSkill(dataDir: string, skill: DistilledSkill, maxSkills = DEFAULT_MAX_SKILLS): void {
  const file = skillsStorePath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const kept = loadSkills(dataDir).filter((s) => s.title.toLowerCase() !== skill.title.toLowerCase());
  kept.push(skill);
  const capped = kept.slice(Math.max(0, kept.length - maxSkills));
  fs.writeFileSync(file, `${capped.map((s) => JSON.stringify(s)).join("\n")}\n`, "utf8");
}

// --- distill ---------------------------------------------------------------

export function buildDistillPrompt(task: string, finalText: string): string {
  return [
    "You just finished a task successfully. Distill it into ONE reusable SOP (standard operating procedure) so a future agent can solve a similar task faster.",
    "",
    "Respond with STRICT JSON only:",
    "{",
    '  "title": "short imperative name, <8 words",',
    '  "whenToUse": "one sentence: when this SOP applies",',
    '  "steps": ["ordered, concrete, reusable steps — not task-specific details"],',
    '  "keywords": ["lowercase tokens a future task might contain"]',
    "}",
    "",
    'Rules: generalize (drop one-off names/paths), 3-8 steps. If trivial or not reusable, return {"title":""}.',
    "",
    "Task:",
    task.trim(),
    "",
    "Outcome / final answer:",
    finalText.trim().slice(0, 4000),
  ].join("\n");
}

export function parseDistilledSkill(text: string, task: string): DistilledSkillDraft | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const title = asText(parsed.title);
  if (!title) return null;
  const steps = asStringArray(parsed.steps).slice(0, MAX_STEPS);
  if (!steps.length) return null;
  const keywordsRaw = asStringArray(parsed.keywords).map((k) => k.toLowerCase());
  const keywords = (keywordsRaw.length ? keywordsRaw : tokenize(`${title} ${task}`)).slice(0, MAX_KEYWORDS);
  return {
    title,
    whenToUse: asText(parsed.whenToUse) || title,
    steps,
    keywords,
    sourceTask: task.trim().slice(0, 240),
  };
}

// --- recall ----------------------------------------------------------------

const STOPWORDS = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "that", "this", "it", "is", "be", "add", "make", "use", "do", "code", "file", "files", "请", "帮", "我", "的", "了", "一个", "如何", "怎么"]);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_一-鿿]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

export function scoreSkillMatch(taskTokens: Set<string>, skill: DistilledSkill): number {
  const skillTokens = new Set<string>();
  for (const kw of skill.keywords) for (const t of tokenize(kw)) skillTokens.add(t);
  for (const t of tokenize(skill.title)) skillTokens.add(t);
  let score = 0;
  for (const t of skillTokens) if (taskTokens.has(t)) score += 1;
  return score;
}

export function recallSkills(task: string, skills: DistilledSkill[], limit = 2, minScore = 2): DistilledSkill[] {
  const taskTokens = new Set(tokenize(task));
  return skills
    .map((skill) => ({ skill, score: scoreSkillMatch(taskTokens, skill) }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.skill);
}

export function formatSkillRecallFrame(skills: DistilledSkill[]): string {
  if (!skills.length) return "";
  const blocks = skills.map((s) => [`### ${s.title}`, `When: ${s.whenToUse}`, ...s.steps.map((step, i) => `${i + 1}. ${step}`)].join("\n"));
  return ["## Relevant SOPs you crystallized from past similar tasks (use if they fit; ignore if not)", ...blocks].join("\n\n");
}

/** Convenience: load + recall + format in one call, fully guarded (returns "" on any error). */
export function recallSkillFrame(dataDir: string, task: string): string {
  try {
    return formatSkillRecallFrame(recallSkills(task, loadSkills(dataDir)));
  } catch {
    return "";
  }
}

// --- helpers ---------------------------------------------------------------

function extractJsonObject(text: string): string {
  if (!text) return "";
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const haystack = fenced ? fenced[1] : text;
  const start = haystack.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < haystack.length; i += 1) {
    const ch = haystack[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  return "";
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const t = asText(item);
    if (t) out.push(t);
  }
  return out;
}
