import { describe, expect, it } from "vitest";
import {
  buildDecomposePrompt,
  parseDecomposition,
  validateDependencyGraph,
  readySubtasks,
  topologicalWaves,
  buildSynthesisPrompt,
  extractJsonObject,
  runUltraTask,
  type UltraSubtask,
  type UltraSubtaskResult,
  type UltraWorkerOutput,
} from "../src/code-ultra.js";

describe("buildDecomposePrompt", () => {
  it("instructs strict JSON, self-contained briefs, parallelism, and the cap", () => {
    const prompt = buildDecomposePrompt("refactor the auth module", { maxSubtasks: 4 });
    expect(prompt).toContain("PLANNER");
    expect(prompt).toContain("between 1 and 4 sub-tasks");
    expect(prompt).toContain("self-contained");
    expect(prompt).toContain("PARALLELISM");
    expect(prompt).toContain("STRICT JSON");
    expect(prompt).toContain('"dependsOn"');
    expect(prompt).toContain("refactor the auth module");
  });
});

describe("extractJsonObject", () => {
  it("returns a raw balanced object", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });
  it("pulls JSON out of a ```json fence", () => {
    expect(extractJsonObject('```json\n{"a":[1,2]}\n```')).toBe('{"a":[1,2]}');
  });
  it("pulls JSON out of surrounding prose", () => {
    expect(extractJsonObject('Sure! Here:\n{"x":true}\nHope that helps')).toBe('{"x":true}');
  });
  it("respects braces inside strings", () => {
    expect(extractJsonObject('{"s":"a } b","n":1}')).toBe('{"s":"a } b","n":1}');
  });
  it("handles nested objects", () => {
    expect(extractJsonObject('prefix {"a":{"b":{"c":1}}} suffix')).toBe('{"a":{"b":{"c":1}}}');
  });
  it("returns empty string when there is no object", () => {
    expect(extractJsonObject("no json here")).toBe("");
  });
});

describe("parseDecomposition", () => {
  it("parses a valid plan with ids and dependencies", () => {
    const text = JSON.stringify({
      strategy: "split by file",
      subtasks: [
        { id: "t1", title: "A", brief: "do A", dependsOn: [] },
        { id: "t2", title: "B", brief: "do B", dependsOn: ["t1"] },
      ],
    });
    const plan = parseDecomposition(text, "task");
    expect(plan.fallback).toBe(false);
    expect(plan.strategy).toBe("split by file");
    expect(plan.subtasks.map((s) => s.id)).toEqual(["t1", "t2"]);
    expect(plan.subtasks[1].dependsOn).toEqual(["t1"]);
  });

  it("parses JSON wrapped in a fence + prose", () => {
    const text = 'Here is the plan:\n```json\n{"subtasks":[{"title":"only","brief":"do it"}]}\n```';
    const plan = parseDecomposition(text, "task");
    expect(plan.fallback).toBe(false);
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0].id).toBe("t1");
    expect(plan.subtasks[0].brief).toBe("do it");
  });

  it("accepts the depends_on snake_case alias", () => {
    const text = JSON.stringify({
      subtasks: [
        { id: "t1", title: "A", brief: "a" },
        { id: "t2", title: "B", brief: "b", depends_on: ["t1"] },
      ],
    });
    const plan = parseDecomposition(text, "task");
    expect(plan.subtasks[1].dependsOn).toEqual(["t1"]);
  });

  it("falls back to a single worker on garbage", () => {
    const plan = parseDecomposition("the model rambled and gave no json", "BIG TASK");
    expect(plan.fallback).toBe(true);
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0].brief).toBe("BIG TASK");
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it("falls back on an empty subtasks array", () => {
    const plan = parseDecomposition(JSON.stringify({ subtasks: [] }), "T");
    expect(plan.fallback).toBe(true);
  });

  it("caps the number of sub-tasks and warns", () => {
    const subtasks = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, brief: `b${i}`, dependsOn: [] }));
    const plan = parseDecomposition(JSON.stringify({ subtasks }), "task", { maxSubtasks: 3 });
    expect(plan.subtasks).toHaveLength(3);
    expect(plan.warnings.some((w) => w.includes("capped at 3"))).toBe(true);
  });

  it("auto-assigns ids for missing or duplicate ids", () => {
    const text = JSON.stringify({
      subtasks: [
        { title: "A", brief: "a" },
        { id: "dup", title: "B", brief: "b" },
        { id: "dup", title: "C", brief: "c" },
      ],
    });
    const plan = parseDecomposition(text, "task");
    const ids = plan.subtasks.map((s) => s.id);
    expect(new Set(ids).size).toBe(3); // all unique
  });

  it("skips empty entries", () => {
    const text = JSON.stringify({ subtasks: [{ title: "", brief: "" }, { title: "real", brief: "do" }] });
    const plan = parseDecomposition(text, "task");
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0].title).toBe("real");
  });
});

describe("validateDependencyGraph", () => {
  it("drops dependencies on unknown ids", () => {
    const { subtasks, warnings } = validateDependencyGraph([
      { id: "t1", title: "A", brief: "a", dependsOn: ["ghost"] },
    ]);
    expect(subtasks[0].dependsOn).toEqual([]);
    expect(warnings.some((w) => w.includes("unknown dependency"))).toBe(true);
  });

  it("drops self-dependencies", () => {
    const { subtasks, warnings } = validateDependencyGraph([
      { id: "t1", title: "A", brief: "a", dependsOn: ["t1"] },
    ]);
    expect(subtasks[0].dependsOn).toEqual([]);
    expect(warnings.some((w) => w.includes("self-dependency"))).toBe(true);
  });

  it("breaks a cycle and warns", () => {
    const { subtasks, warnings } = validateDependencyGraph([
      { id: "t1", title: "A", brief: "a", dependsOn: ["t2"] },
      { id: "t2", title: "B", brief: "b", dependsOn: ["t1"] },
    ]);
    // At least one edge of the cycle is removed so the graph is a DAG.
    const totalEdges = subtasks.reduce((n, s) => n + s.dependsOn.length, 0);
    expect(totalEdges).toBeLessThan(2);
    expect(warnings.some((w) => w.includes("cyclic"))).toBe(true);
  });

  it("dedupes repeated dependencies", () => {
    const { subtasks } = validateDependencyGraph([
      { id: "t1", title: "A", brief: "a", dependsOn: [] },
      { id: "t2", title: "B", brief: "b", dependsOn: ["t1", "t1"] },
    ]);
    expect(subtasks[1].dependsOn).toEqual(["t1"]);
  });
});

describe("readySubtasks", () => {
  const subtasks: UltraSubtask[] = [
    { id: "t1", title: "A", brief: "a", dependsOn: [] },
    { id: "t2", title: "B", brief: "b", dependsOn: ["t1"] },
    { id: "t3", title: "C", brief: "c", dependsOn: ["t1"] },
  ];

  it("returns only dependency-free tasks at the start", () => {
    expect(readySubtasks(subtasks, new Set()).map((s) => s.id)).toEqual(["t1"]);
  });

  it("unlocks dependents once a dependency is done", () => {
    expect(readySubtasks(subtasks, new Set(["t1"])).map((s) => s.id)).toEqual(["t2", "t3"]);
  });

  it("never returns done or failed tasks", () => {
    expect(readySubtasks(subtasks, new Set(["t1"]), new Set(["t2"])).map((s) => s.id)).toEqual(["t3"]);
  });
});

describe("topologicalWaves", () => {
  it("groups independent tasks into one wave", () => {
    const waves = topologicalWaves([
      { id: "t1", title: "A", brief: "a", dependsOn: [] },
      { id: "t2", title: "B", brief: "b", dependsOn: [] },
    ]);
    expect(waves).toHaveLength(1);
    expect(waves[0].map((s) => s.id).sort()).toEqual(["t1", "t2"]);
  });

  it("orders a dependency chain into successive waves", () => {
    const waves = topologicalWaves([
      { id: "t1", title: "A", brief: "a", dependsOn: [] },
      { id: "t2", title: "B", brief: "b", dependsOn: ["t1"] },
      { id: "t3", title: "C", brief: "c", dependsOn: ["t2"] },
    ]);
    expect(waves.map((w) => w.map((s) => s.id))).toEqual([["t1"], ["t2"], ["t3"]]);
  });

  it("diamond dependency fans out then back in", () => {
    const waves = topologicalWaves([
      { id: "t1", title: "root", brief: "r", dependsOn: [] },
      { id: "t2", title: "left", brief: "l", dependsOn: ["t1"] },
      { id: "t3", title: "right", brief: "r", dependsOn: ["t1"] },
      { id: "t4", title: "merge", brief: "m", dependsOn: ["t2", "t3"] },
    ]);
    expect(waves[0].map((s) => s.id)).toEqual(["t1"]);
    expect(waves[1].map((s) => s.id).sort()).toEqual(["t2", "t3"]);
    expect(waves[2].map((s) => s.id)).toEqual(["t4"]);
  });
});

describe("buildSynthesisPrompt", () => {
  it("includes cross-check, completeness critic, and per-result status blocks", () => {
    const results: UltraSubtaskResult[] = [
      { id: "t1", title: "A", ok: true, text: "did A" },
      { id: "t2", title: "B", ok: false, text: "", skipped: true },
    ];
    const prompt = buildSynthesisPrompt("the big task", results);
    expect(prompt).toContain("CROSS-CHECK");
    expect(prompt).toContain("COMPLETENESS CRITIC");
    expect(prompt).toContain("the big task");
    expect(prompt).toContain("t1 — A [OK]");
    expect(prompt).toContain("did A");
    expect(prompt).toContain("t2 — B [SKIPPED (dependency failed)]");
  });
});

// --- Orchestrator integration (mock complete + runSubtask) -----------------

function planJson(subtasks: Array<Partial<UltraSubtask>>): string {
  return JSON.stringify({ strategy: "s", subtasks });
}

describe("runUltraTask", () => {
  it("decomposes, fans out independent sub-tasks, and synthesizes", async () => {
    const ran: string[] = [];
    const result = await runUltraTask({
      task: "do two things",
      complete: async (_prompt, kind) => {
        if (kind === "decompose") {
          return planJson([
            { id: "t1", title: "A", brief: "do A", dependsOn: [] },
            { id: "t2", title: "B", brief: "do B", dependsOn: [] },
          ]);
        }
        return "SYNTHESIZED";
      },
      runSubtask: async (subtask): Promise<UltraWorkerOutput> => {
        ran.push(subtask.id);
        return { ok: true, text: `${subtask.id}-output` };
      },
    });
    expect(ran.sort()).toEqual(["t1", "t2"]);
    expect(result.waves).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.synthesis).toBe("SYNTHESIZED");
    expect(result.results.map((r) => r.text).sort()).toEqual(["t1-output", "t2-output"]);
  });

  it("runs dependencies before dependents and passes dependency results", async () => {
    const order: string[] = [];
    let t2DepText = "";
    await runUltraTask({
      task: "chain",
      complete: async (_p, kind) =>
        kind === "decompose"
          ? planJson([
              { id: "t1", title: "first", brief: "do first", dependsOn: [] },
              { id: "t2", title: "second", brief: "do second", dependsOn: ["t1"] },
            ])
          : "DONE",
      runSubtask: async (subtask, ctx): Promise<UltraWorkerOutput> => {
        order.push(subtask.id);
        if (subtask.id === "t2") t2DepText = ctx.dependencyResults.map((r) => r.text).join(",");
        return { ok: true, text: `${subtask.id}!` };
      },
    });
    expect(order).toEqual(["t1", "t2"]);
    expect(t2DepText).toBe("t1!");
  });

  it("skips a dependent when its dependency fails", async () => {
    const ran: string[] = [];
    const result = await runUltraTask({
      task: "chain with failure",
      complete: async (_p, kind) =>
        kind === "decompose"
          ? planJson([
              { id: "t1", title: "first", brief: "do first", dependsOn: [] },
              { id: "t2", title: "second", brief: "do second", dependsOn: ["t1"] },
            ])
          : "DONE",
      runSubtask: async (subtask): Promise<UltraWorkerOutput> => {
        ran.push(subtask.id);
        if (subtask.id === "t1") return { ok: false, text: "", error: "boom" };
        return { ok: true, text: "should not run" };
      },
    });
    expect(ran).toEqual(["t1"]); // t2 never ran
    expect(result.ok).toBe(false);
    const t2 = result.results.find((r) => r.id === "t2");
    expect(t2?.skipped).toBe(true);
  });

  it("captures a thrown worker error as a failed result", async () => {
    const result = await runUltraTask({
      task: "one",
      complete: async () => planJson([{ id: "t1", title: "A", brief: "a", dependsOn: [] }]),
      runSubtask: async (): Promise<UltraWorkerOutput> => {
        throw new Error("worker exploded");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.results[0].error).toContain("worker exploded");
  });

  it("does not call synthesize for a single/fallback plan", async () => {
    let synthCalls = 0;
    const result = await runUltraTask({
      task: "atomic thing",
      complete: async (_p, kind) => {
        if (kind === "synthesize") synthCalls += 1;
        return "garbage, no json"; // forces fallback to single worker
      },
      runSubtask: async (): Promise<UltraWorkerOutput> => ({ ok: true, text: "only-output" }),
    });
    expect(result.plan.fallback).toBe(true);
    expect(synthCalls).toBe(0);
    expect(result.synthesis).toBe("only-output");
  });

  it("falls back to a single worker when decomposition throws", async () => {
    const result = await runUltraTask({
      task: "resilient",
      complete: async (_p, kind) => {
        if (kind === "decompose") throw new Error("model down");
        return "X";
      },
      runSubtask: async (): Promise<UltraWorkerOutput> => ({ ok: true, text: "ran-anyway" }),
    });
    expect(result.plan.fallback).toBe(true);
    expect(result.synthesis).toBe("ran-anyway");
  });

  it("flags a refuted sub-task as an advisory concern without cascading (adversarial verify)", async () => {
    const verified: Array<{ id: string; pass: boolean }> = [];
    const result = await runUltraTask({
      task: "verify chain",
      options: { adversarialVerify: true },
      complete: async (_p, kind) =>
        kind === "decompose"
          ? planJson([
              { id: "t1", title: "impl", brief: "do impl", dependsOn: [] },
              { id: "t2", title: "dependent", brief: "build on impl", dependsOn: ["t1"] },
            ])
          : "SYNTH",
      runSubtask: async (subtask): Promise<UltraWorkerOutput> => ({ ok: true, text: `${subtask.id} done`, mutated: true }),
      verifySubtask: async (subtask) => {
        const pass = subtask.id !== "t1";
        verified.push({ id: subtask.id, pass });
        return { pass, reason: pass ? undefined : "incomplete" };
      },
    });
    const t1 = result.results.find((r) => r.id === "t1");
    const t2 = result.results.find((r) => r.id === "t2");
    expect(t1?.ok).toBe(true); // advisory only — not downgraded
    expect(t1?.verifyConcern).toContain("incomplete");
    expect(t2?.skipped).toBeFalsy(); // dependent still runs — no cascade
    expect(verified).toEqual([{ id: "t1", pass: false }, { id: "t2", pass: true }]);
    expect(result.ok).toBe(true);
  });

  it("refutes only sub-tasks that changed files (cost bound)", async () => {
    const verified: string[] = [];
    await runUltraTask({
      task: "mixed",
      options: { adversarialVerify: true },
      complete: async (_p, kind) =>
        kind === "decompose"
          ? planJson([
              { id: "t1", title: "writes", brief: "edit a file", dependsOn: [] },
              { id: "t2", title: "reads", brief: "analyze only", dependsOn: [] },
            ])
          : "S",
      runSubtask: async (subtask): Promise<UltraWorkerOutput> => ({ ok: true, text: subtask.id, mutated: subtask.id === "t1" }),
      verifySubtask: async (subtask) => {
        verified.push(subtask.id);
        return { pass: true };
      },
    });
    expect(verified).toEqual(["t1"]); // t2 changed no files → refuter skipped
  });

  it("does not verify when adversarialVerify is off", async () => {
    let verifyCalls = 0;
    const result = await runUltraTask({
      task: "no verify",
      complete: async (_p, kind) => (kind === "decompose" ? planJson([{ id: "t1", title: "A", brief: "a", dependsOn: [] }]) : "S"),
      runSubtask: async (): Promise<UltraWorkerOutput> => ({ ok: true, text: "done" }),
      verifySubtask: async () => {
        verifyCalls += 1;
        return { pass: false, reason: "should not be called" };
      },
    });
    expect(verifyCalls).toBe(0);
    expect(result.results[0].ok).toBe(true);
  });

  it("respects the concurrency cap while still running every task", async () => {
    let active = 0;
    let peak = 0;
    const result = await runUltraTask({
      task: "five independent",
      options: { maxConcurrency: 2 },
      complete: async (_p, kind) =>
        kind === "decompose"
          ? planJson(Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, brief: `b${i}`, dependsOn: [] })))
          : "SYNTH",
      runSubtask: async (subtask): Promise<UltraWorkerOutput> => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return { ok: true, text: subtask.id };
      },
    });
    expect(result.results).toHaveLength(5);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
