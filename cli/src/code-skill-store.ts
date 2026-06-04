import fs from "node:fs";
import path from "node:path";

// CLI-local store for distilled skills (SOPs crystallized from successful tasks).
// JSONL under the data dir; separate from the brain's Skill Distiller (that is the
// GUI/brain side). Native, in-process, dependency-free.

export interface DistilledSkill {
  id: string;
  title: string;
  whenToUse: string;
  steps: string[];
  keywords: string[];
  createdAt: string;
  sourceTask: string;
}

const DEFAULT_MAX_SKILLS = 200;

export function skillsStorePath(dataDir: string): string {
  return path.join(dataDir, "skills", "distilled.jsonl");
}

export function loadSkills(dataDir: string): DistilledSkill[] {
  const file = skillsStorePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const skills: DistilledSkill[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as DistilledSkill;
      if (parsed && typeof parsed.title === "string" && Array.isArray(parsed.steps)) skills.push(parsed);
    } catch {
      // skip torn line
    }
  }
  return skills;
}

export function appendSkill(dataDir: string, skill: DistilledSkill, maxSkills = DEFAULT_MAX_SKILLS): void {
  const file = skillsStorePath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = loadSkills(dataDir);
  // De-dup by title (a re-learned skill overwrites the old one).
  const kept = existing.filter((s) => s.title.toLowerCase() !== skill.title.toLowerCase());
  kept.push(skill);
  const capped = kept.slice(Math.max(0, kept.length - maxSkills));
  fs.writeFileSync(file, `${capped.map((s) => JSON.stringify(s)).join("\n")}\n`, "utf8");
}
