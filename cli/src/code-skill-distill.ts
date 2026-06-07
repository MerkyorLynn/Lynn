import type { DistilledSkill } from "./code-skill-store.js";

// Skill crystallization — the hybrid pattern:
//   ② after a successful task: distill the trace into a reusable SOP and store it
//   ① before a task: recall the most relevant SOP(s) and inject them as context
// Pure logic here (prompts, parse, match, format); the model call + store I/O are
// wired in the command. Opt-in, dependency-free.

export function skillCrystallizeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LYNN_CLI_SKILL_CRYSTALLIZE === "1";
}

const MAX_STEPS = 8;
const MAX_KEYWORDS = 12;

export type DistilledSkillDraft = Omit<DistilledSkill, "id" | "createdAt">;

export function buildDistillPrompt(task: string, finalText: string): string {
  return [
    "You just finished a coding task successfully. Distill it into ONE reusable SOP (standard operating procedure) so a future agent can solve a similar task faster.",
    "",
    "Respond with STRICT JSON only:",
    "{",
    '  "title": "short imperative name, <8 words",',
    '  "whenToUse": "one sentence: when this SOP applies",',
    '  "steps": ["ordered, concrete, reusable steps — not task-specific details"],',
    '  "keywords": ["lowercase tokens a future task might contain"]',
    "}",
    "",
    "Rules: generalize (drop one-off names/paths), keep steps actionable, 3-8 steps. If the task was trivial or not reusable, return {\"title\":\"\"}.",
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
  if (!title) return null; // model declined (trivial/non-reusable)
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

const STOPWORDS = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "that", "this", "it", "is", "be", "add", "make", "use", "do", "code", "file", "files"]);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

export function scoreSkillMatch(taskTokens: Set<string>, skill: DistilledSkill): number {
  // Tokenize the skill's keywords + title so multi-word keywords ("create file")
  // still match single task tokens. Each unique token counts once.
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
