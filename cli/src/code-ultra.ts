// Lynn CLI "ultra" mode — clean-room task-level orchestration.
//
// This is the MACRO half of Lynn's reliability story. The MICRO half already
// ships in v0.80.6: each agent loop runs atomic tool steps (one action tool
// per turn, defer the rest) + verify-after-each-mutation + the reliability
// guards (#1-#7). That makes a single worker trustworthy.
//
// Ultra adds the layer on top: decompose a big task into atomic sub-tasks with
// a dependency graph, fan them out across reliable workers (each worker = the
// existing atomic agent loop), then adversarially synthesize the results with a
// completeness critic. This module is pure orchestration: the model call
// (`complete`) and the worker (`runSubtask`) are INJECTED, so the core is fully
// unit-testable and carries no coupling to brain-client / runCodeAgentLoop.

export interface UltraSubtask {
  /** Stable id, e.g. "t1". Used by dependsOn and by the scheduler. */
  id: string;
  /** Short human label. */
  title: string;
  /** Self-contained instruction for a worker agent that has NO memory of siblings. */
  brief: string;
  /** Ids of sub-tasks that must finish successfully before this one runs. */
  dependsOn: string[];
}

export interface UltraPlan {
  /** One-line rationale for the decomposition ("" if the model gave none). */
  strategy: string;
  subtasks: UltraSubtask[];
  /** True when decomposition failed/was trivial and we fell back to a single worker. */
  fallback: boolean;
  /** Non-fatal sanitation notes (dropped deps, broken cycles, caps applied). */
  warnings: string[];
}

export interface UltraSubtaskResult {
  id: string;
  title: string;
  ok: boolean;
  /** Worker's final answer / report. */
  text: string;
  maxStepsReached?: boolean;
  error?: string;
  /** An independent refuter doubted this (advisory — does NOT fail the sub-task). */
  verifyConcern?: string;
  /** True when a dependency failed and this sub-task was never run. */
  skipped?: boolean;
}

export interface UltraResult {
  plan: UltraPlan;
  results: UltraSubtaskResult[];
  /** Final synthesized answer. */
  synthesis: string;
  /** True when every non-skipped sub-task finished ok. */
  ok: boolean;
  /** Number of dependency waves that ran. */
  waves: number;
}

export interface UltraOptions {
  /** Hard cap on sub-tasks (default 6). Extra sub-tasks are dropped with a warning. */
  maxSubtasks?: number;
  /** Max workers running concurrently within a wave (default 3). */
  maxConcurrency?: number;
  /** Below this many sub-tasks we just run a single worker (default 2). */
  minSubtasks?: number;
  /** Run an independent refuter on each ok sub-task that changed files; a refuted
   * sub-task is flagged as an advisory concern for the synthesizer (not failed). */
  adversarialVerify?: boolean;
}

export interface UltraVerifyVerdict {
  pass: boolean;
  reason?: string;
}

export type UltraEvent =
  | { type: "ultra.plan"; plan: UltraPlan }
  | { type: "ultra.wave"; wave: number; ids: string[] }
  | { type: "ultra.subtask.started"; id: string; title: string }
  | { type: "ultra.subtask.verified"; id: string; title: string; pass: boolean; reason?: string }
  | { type: "ultra.subtask.finished"; id: string; title: string; ok: boolean; skipped: boolean }
  | { type: "ultra.synthesis.started" }
  | { type: "ultra.synthesis"; text: string };

export interface UltraSubtaskContext {
  /** All sub-tasks in the plan (for the worker to understand its place). */
  allSubtasks: UltraSubtask[];
  /** Results of this sub-task's dependencies (already finished, ok). */
  dependencyResults: UltraSubtaskResult[];
}

export interface UltraWorkerOutput {
  ok: boolean;
  text: string;
  maxStepsReached?: boolean;
  error?: string;
  /** The worker changed at least one file (used to scope adversarial verify). */
  mutated?: boolean;
}

export interface UltraRunInput {
  task: string;
  /** Single model completion. `kind` lets the bridge tune reasoning/budget. */
  complete: (prompt: string, kind: "decompose" | "synthesize") => Promise<string>;
  /** Run one sub-task as a reliable atomic worker (wraps runCodeAgentLoop). */
  runSubtask: (subtask: UltraSubtask, ctx: UltraSubtaskContext) => Promise<UltraWorkerOutput>;
  /** Optional independent refuter (used only when options.adversarialVerify is on). */
  verifySubtask?: (subtask: UltraSubtask, output: UltraWorkerOutput) => Promise<UltraVerifyVerdict>;
  options?: UltraOptions;
  onEvent?: (event: UltraEvent) => void;
}

const DEFAULT_MAX_SUBTASKS = 6;
const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_MIN_SUBTASKS = 2;

// ---------------------------------------------------------------------------
// Decomposition prompt
// ---------------------------------------------------------------------------

export function buildDecomposePrompt(task: string, options: UltraOptions = {}): string {
  const maxSubtasks = clampInt(options.maxSubtasks, 1, 20, DEFAULT_MAX_SUBTASKS);
  return [
    "You are the PLANNER for Lynn's ultra mode. Decompose the task below into atomic sub-tasks that independent worker agents will execute in parallel.",
    "",
    "Hard rules:",
    `- Produce between 1 and ${maxSubtasks} sub-tasks. If the task is small and atomic, return exactly ONE sub-task that restates it.`,
    "- Each sub-task MUST be self-contained: the worker that runs it has NO memory of the other sub-tasks, so its `brief` must include every file path, constraint, and piece of context it needs.",
    "- Prefer PARALLELISM. Only add a `dependsOn` edge when a sub-task genuinely needs another sub-task's output. Never create a cycle.",
    "- Split by independent surface area (different files/modules/concerns), not by trivial mechanical steps. Do not over-split.",
    "- Keep `title` under 8 words. Keep `brief` actionable and specific.",
    "",
    "Respond with STRICT JSON and nothing else, in exactly this shape:",
    "{",
    '  "strategy": "one sentence on how you split it",',
    '  "subtasks": [',
    '    { "id": "t1", "title": "...", "brief": "...", "dependsOn": [] },',
    '    { "id": "t2", "title": "...", "brief": "...", "dependsOn": ["t1"] }',
    "  ]",
    "}",
    "",
    "Task:",
    task.trim(),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Decomposition parsing (robust: fenced / raw / prose+json / garbage→fallback)
// ---------------------------------------------------------------------------

interface RawSubtask {
  id?: unknown;
  title?: unknown;
  brief?: unknown;
  dependsOn?: unknown;
  depends_on?: unknown;
}

export function parseDecomposition(text: string, task: string, options: UltraOptions = {}): UltraPlan {
  const maxSubtasks = clampInt(options.maxSubtasks, 1, 20, DEFAULT_MAX_SUBTASKS);
  const warnings: string[] = [];
  const parsed = safeParseObject(extractJsonObject(text));
  const rawList = Array.isArray((parsed as { subtasks?: unknown })?.subtasks)
    ? ((parsed as { subtasks: unknown[] }).subtasks as RawSubtask[])
    : [];

  if (!rawList.length) {
    return singleTaskFallback(task, "decomposition produced no usable sub-tasks; running the task as a single worker");
  }

  const strategy = typeof (parsed as { strategy?: unknown })?.strategy === "string"
    ? ((parsed as { strategy: string }).strategy).trim()
    : "";

  // Pass 1: build sub-tasks with normalized, unique ids.
  const usedIds = new Set<string>();
  const cleaned: UltraSubtask[] = [];
  for (let i = 0; i < rawList.length; i += 1) {
    if (cleaned.length >= maxSubtasks) {
      warnings.push(`capped at ${maxSubtasks} sub-tasks (${rawList.length} proposed)`);
      break;
    }
    const raw = rawList[i];
    const title = asText(raw?.title);
    const brief = asText(raw?.brief);
    if (!brief && !title) continue; // skip empty entries
    const id = uniqueId(asText(raw?.id), i, usedIds);
    cleaned.push({
      id,
      title: title || brief.slice(0, 48) || id,
      brief: brief || title,
      dependsOn: asStringArray(raw?.dependsOn ?? raw?.depends_on),
    });
  }

  if (!cleaned.length) {
    return singleTaskFallback(task, "decomposition entries were empty; running the task as a single worker");
  }

  const { subtasks, warnings: graphWarnings } = validateDependencyGraph(cleaned);
  return {
    strategy,
    subtasks,
    fallback: false,
    warnings: [...warnings, ...graphWarnings],
  };
}

function singleTaskFallback(task: string, warning: string): UltraPlan {
  return {
    strategy: "",
    subtasks: [{ id: "t1", title: truncate(task.trim(), 48) || "task", brief: task.trim(), dependsOn: [] }],
    fallback: true,
    warnings: [warning],
  };
}

// ---------------------------------------------------------------------------
// Dependency graph sanitation
// ---------------------------------------------------------------------------

export function validateDependencyGraph(subtasks: UltraSubtask[]): { subtasks: UltraSubtask[]; warnings: string[] } {
  const warnings: string[] = [];
  const ids = new Set(subtasks.map((s) => s.id));

  // Drop self-edges and edges to unknown ids.
  const pruned = subtasks.map((s) => {
    const deps: string[] = [];
    for (const dep of s.dependsOn) {
      if (dep === s.id) {
        warnings.push(`${s.id}: dropped self-dependency`);
        continue;
      }
      if (!ids.has(dep)) {
        warnings.push(`${s.id}: dropped unknown dependency "${dep}"`);
        continue;
      }
      if (!deps.includes(dep)) deps.push(dep);
    }
    return { ...s, dependsOn: deps };
  });

  // Break cycles by removing back-edges discovered during DFS.
  const byId = new Map(pruned.map((s) => [s.id, s]));
  const state = new Map<string, 0 | 1 | 2>(); // 0=unvisited 1=on-stack 2=done
  const visit = (id: string): void => {
    state.set(id, 1);
    const node = byId.get(id);
    if (node) {
      node.dependsOn = node.dependsOn.filter((dep) => {
        const depState = state.get(dep) ?? 0;
        if (depState === 1) {
          warnings.push(`${id}: removed cyclic dependency on "${dep}"`);
          return false;
        }
        if (depState === 0) visit(dep);
        return true;
      });
    }
    state.set(id, 2);
  };
  for (const s of pruned) {
    if ((state.get(s.id) ?? 0) === 0) visit(s.id);
  }

  return { subtasks: pruned, warnings };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Sub-tasks whose dependencies are all satisfied and that have not run yet. */
export function readySubtasks(
  subtasks: UltraSubtask[],
  done: ReadonlySet<string>,
  failed: ReadonlySet<string> = new Set(),
): UltraSubtask[] {
  return subtasks.filter((s) => {
    if (done.has(s.id) || failed.has(s.id)) return false;
    return s.dependsOn.every((dep) => done.has(dep));
  });
}

/**
 * Group sub-tasks into dependency waves (Kahn layering). Each wave is a set of
 * sub-tasks that can run in parallel. Assumes a sanitized DAG (cycles already
 * broken by validateDependencyGraph). Any leftover node (shouldn't happen on a
 * DAG) is flushed into a final wave so nothing is silently dropped.
 */
export function topologicalWaves(subtasks: UltraSubtask[]): UltraSubtask[][] {
  const waves: UltraSubtask[][] = [];
  const done = new Set<string>();
  const remaining = [...subtasks];
  while (remaining.length) {
    const wave = remaining.filter((s) => s.dependsOn.every((dep) => done.has(dep)));
    if (!wave.length) {
      // Defensive: unsatisfiable deps (should be impossible post-sanitation).
      waves.push(remaining.splice(0));
      break;
    }
    for (const s of wave) {
      done.add(s.id);
      remaining.splice(remaining.indexOf(s), 1);
    }
    waves.push(wave);
  }
  return waves;
}

// ---------------------------------------------------------------------------
// Synthesis prompt (adversarial cross-check + completeness critic)
// ---------------------------------------------------------------------------

export function buildSynthesisPrompt(task: string, results: UltraSubtaskResult[]): string {
  const blocks = results.map((r) => {
    const status = r.skipped ? "SKIPPED (dependency failed)" : r.ok ? "OK" : "FAILED";
    const body = r.skipped
      ? "(not executed)"
      : r.text.trim() || (r.error ? `(no output; error: ${r.error})` : "(no output)");
    const concern = r.verifyConcern
      ? `\n⚠ FLAGGED by an independent refuter — scrutinize before trusting: ${r.verifyConcern}`
      : "";
    return [`### ${r.id} — ${r.title} [${status}]`, `${body}${concern}`].join("\n");
  });
  return [
    "You are the SYNTHESIZER for Lynn's ultra mode. Several worker agents each completed one sub-task in parallel. Combine their results into one correct, coherent answer for the original task.",
    "",
    "Do this rigorously:",
    "1. CROSS-CHECK: if two workers contradict each other, call it out and resolve it — do not paper over conflicts.",
    "2. COMPLETENESS CRITIC: list anything still missing, unverified, or assumed. If a sub-task was SKIPPED or FAILED, state the resulting gap plainly.",
    "3. SCRUTINIZE FLAGS: any sub-task marked FLAGGED was doubted by an independent refuter — do not trust it blindly; validate or correct it in your answer.",
    "4. SYNTHESIZE: give the integrated final answer the user asked for. Be concrete; reference the relevant sub-task ids.",
    "",
    "Original task:",
    task.trim(),
    "",
    "Worker results:",
    blocks.join("\n\n"),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runUltraTask(input: UltraRunInput): Promise<UltraResult> {
  const options = input.options ?? {};
  const minSubtasks = clampInt(options.minSubtasks, 1, 20, DEFAULT_MIN_SUBTASKS);
  const maxConcurrency = clampInt(options.maxConcurrency, 1, 16, DEFAULT_MAX_CONCURRENCY);

  // 1) Decompose.
  let plan: UltraPlan;
  try {
    const decomposeText = await input.complete(buildDecomposePrompt(input.task, options), "decompose");
    plan = parseDecomposition(decomposeText, input.task, options);
  } catch (error) {
    plan = singleTaskFallback(input.task, `decomposition call failed (${errorMessage(error)}); running the task as a single worker`);
  }
  input.onEvent?.({ type: "ultra.plan", plan });

  // 2) Run sub-tasks wave by wave (respecting dependencies + concurrency cap).
  const resultMap = new Map<string, UltraSubtaskResult>();
  const done = new Set<string>();
  const failed = new Set<string>();
  const waves = topologicalWaves(plan.subtasks);
  let waveCount = 0;

  for (let w = 0; w < waves.length; w += 1) {
    const runnable = waves[w].filter((s) => s.dependsOn.every((dep) => done.has(dep)));
    const skippedInWave = waves[w].filter((s) => !runnable.includes(s));
    for (const s of skippedInWave) {
      const result: UltraSubtaskResult = { id: s.id, title: s.title, ok: false, text: "", skipped: true };
      resultMap.set(s.id, result);
      failed.add(s.id);
      input.onEvent?.({ type: "ultra.subtask.finished", id: s.id, title: s.title, ok: false, skipped: true });
    }
    if (!runnable.length) continue;
    waveCount += 1;
    input.onEvent?.({ type: "ultra.wave", wave: waveCount, ids: runnable.map((s) => s.id) });

    for (const chunk of chunkArray(runnable, maxConcurrency)) {
      const settled = await Promise.all(
        chunk.map(async (subtask): Promise<UltraSubtaskResult> => {
          input.onEvent?.({ type: "ultra.subtask.started", id: subtask.id, title: subtask.title });
          const dependencyResults = subtask.dependsOn
            .map((dep) => resultMap.get(dep))
            .filter((r): r is UltraSubtaskResult => Boolean(r));
          try {
            const output = await input.runSubtask(subtask, { allSubtasks: plan.subtasks, dependencyResults });
            const result: UltraSubtaskResult = {
              id: subtask.id,
              title: subtask.title,
              ok: output.ok,
              text: output.text,
              maxStepsReached: output.maxStepsReached,
              error: output.error,
            };
            // Adversarial verify (advisory): an ok sub-task that CHANGED files is
            // checked by an independent refuter. A refuted sub-task is flagged as a
            // concern for the synthesizer — NOT downgraded — so one over-zealous
            // refuter can't fail a good result or cascade-skip its dependents.
            // Read-only sub-tasks are skipped to bound the extra model calls.
            if (output.ok && output.mutated && options.adversarialVerify && input.verifySubtask) {
              try {
                const verdict = await input.verifySubtask(subtask, output);
                input.onEvent?.({ type: "ultra.subtask.verified", id: subtask.id, title: subtask.title, pass: verdict.pass, reason: verdict.reason });
                if (!verdict.pass) {
                  result.verifyConcern = verdict.reason || "no reason given";
                }
              } catch {
                // A verifier failure must not crash the run; keep the worker's verdict.
              }
            }
            return result;
          } catch (error) {
            return { id: subtask.id, title: subtask.title, ok: false, text: "", error: errorMessage(error) };
          }
        }),
      );
      for (const result of settled) {
        resultMap.set(result.id, result);
        if (result.ok) done.add(result.id);
        else failed.add(result.id);
        input.onEvent?.({ type: "ultra.subtask.finished", id: result.id, title: result.title, ok: result.ok, skipped: false });
      }
    }
  }

  const results = plan.subtasks.map((s) => resultMap.get(s.id)).filter((r): r is UltraSubtaskResult => Boolean(r));
  const ok = results.every((r) => r.ok);

  // 3) Synthesize. A single (or fallback) sub-task needs no synthesis pass.
  let synthesis: string;
  const realResults = results.filter((r) => !r.skipped);
  if (plan.fallback || realResults.length <= 1) {
    synthesis = realResults[0]?.text ?? results[0]?.text ?? "";
  } else {
    input.onEvent?.({ type: "ultra.synthesis.started" });
    try {
      synthesis = (await input.complete(buildSynthesisPrompt(input.task, results), "synthesize")).trim();
    } catch (error) {
      synthesis = `${formatResultsDigest(results)}\n\n(synthesis call failed: ${errorMessage(error)})`;
    }
    input.onEvent?.({ type: "ultra.synthesis", text: synthesis });
  }

  // Below the minimum split we still ran (a single worker) — fine, but flag it
  // so callers know ultra effectively degraded to a normal run.
  if (!plan.fallback && plan.subtasks.length < minSubtasks) {
    plan.warnings.push(`only ${plan.subtasks.length} sub-task(s); ultra degraded to a near-single run`);
  }

  return { plan, results, synthesis, ok, waves: waveCount };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatResultsDigest(results: UltraSubtaskResult[]): string {
  return results
    .map((r) => {
      const status = r.skipped ? "SKIPPED" : r.ok ? "OK" : "FAILED";
      return `## ${r.id} — ${r.title} [${status}]\n${r.text.trim() || "(no output)"}`;
    })
    .join("\n\n");
}

/** Extract the first balanced JSON object from text (handles fences + prose). */
export function extractJsonObject(text: string): string {
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

function safeParseObject(json: string): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = asText(item);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function uniqueId(candidate: string, index: number, used: Set<string>): string {
  let id = candidate.replace(/\s+/g, "_");
  if (!id || used.has(id)) id = `t${index + 1}`;
  let suffix = index + 1;
  while (used.has(id)) {
    id = `t${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
