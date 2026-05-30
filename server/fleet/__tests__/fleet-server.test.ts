import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Hono } from "hono";
import { matchAnyGlob, evaluateScope, annotateChangedFiles } from "../forbidden-guard.js";
import { createLineParser, mapKnownCliJsonLine, spawnWorker } from "../worker-manager.js";
import { parseWorktreePorcelain } from "../worktree-manager.js";
import { FleetHub, evaluateGate, type FleetBrief } from "../fleet-hub.js";
import { resolveCliCommand, cliRuntimeAvailable } from "../worker-command.js";
import { DEFAULT_FLEET_REGISTRY, configuredCliProviderPreset, resolveFleetRegistry } from "../registry.js";
import { createFleetRoute } from "../../routes/fleet.js";

const pExecFile = promisify(execFile);

async function execGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await pExecFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for fleet event");
}

describe("forbidden-guard", () => {
  it("matches ** across segments and * within one", () => {
    expect(matchAnyGlob("server/routes/chat.ts", ["server/**"])).toBe(true);
    expect(matchAnyGlob("brain-v2-mirror/router.ts", ["brain-v2-mirror/**"])).toBe(true);
    expect(matchAnyGlob("core/engine.ts", ["core/engine*.ts"])).toBe(true);
    expect(matchAnyGlob("desktop/src/x.ts", ["server/**"])).toBe(false);
    expect(matchAnyGlob("server.ts", ["server/**"])).toBe(false);
  });

  it("flags forbidden + center-lock from the actual changed paths (not self-report)", () => {
    const v = evaluateScope(
      ["desktop/src/a.tsx", "server/routes/chat.ts"],
      ["server/**"],
      ["server/routes/chat.ts"],
    );
    expect(v.ok).toBe(false);
    expect(v.forbiddenPaths).toContain("server/routes/chat.ts");
    expect(v.centerLockPaths).toContain("server/routes/chat.ts");
  });

  it("annotateChangedFiles sets the forbidden flag for the GUI", () => {
    const out = annotateChangedFiles(
      [{ path: "server/routes/chat.ts" }, { path: "desktop/src/a.tsx" }],
      ["server/**"],
    );
    expect(out[0].forbidden).toBe(true);
    expect(out[1].forbidden).toBeUndefined();
  });
});

describe("worker line parser", () => {
  it("reassembles chunked JSONL, stamps workerId, wraps non-JSON as progress", () => {
    const parse = createLineParser("w1");
    const events = [
      ...parse('{"type":"worker.progress","message":"a"}\n{"type":"tool.started","na'),
      ...parse('me":"read"}\nplain log line\n'),
    ];
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "worker.progress", message: "a", workerId: "w1" });
    expect(events[1]).toMatchObject({ type: "tool.started", name: "read", workerId: "w1" });
    expect(events[2]).toMatchObject({ type: "worker.progress", message: "plain log line", workerId: "w1" });
  });

  it("flushes a final JSON event without a trailing newline", () => {
    const parse = createLineParser("w-flush");
    expect(parse('{"type":"worker.finished","ok":true,"exitCode":0,"summary":"done"}')).toEqual([]);
    expect(parse.flush()).toEqual([
      expect.objectContaining({ type: "worker.finished", workerId: "w-flush", ok: true, exitCode: 0, summary: "done" }),
    ]);
    expect(parse.flush()).toEqual([]);
  });

  it("flushes a final non-JSON line as progress", () => {
    const parse = createLineParser("w-log");
    expect(parse("final log line")).toEqual([]);
    expect(parse.flush()).toEqual([
      expect.objectContaining({ type: "worker.progress", workerId: "w-log", message: "final log line" }),
    ]);
  });

  it("translates nested Lynn code JSON events into fleet events", () => {
    expect(mapKnownCliJsonLine('{"type":"code.tool.requested","tool":"read_file","args":{"path":"README.md"}}', "w2")).toMatchObject({
      type: "tool.started",
      workerId: "w2",
      name: "read_file",
      argsPreview: expect.stringContaining("README.md"),
    });
    expect(mapKnownCliJsonLine('{"type":"code.tool.result","tool":"read_file","ok":true,"ms":12}', "w2")).toMatchObject({
      type: "tool.finished",
      workerId: "w2",
      name: "read_file",
      ok: true,
      ms: 12,
    });
    expect(mapKnownCliJsonLine('{"type":"code.plan.updated","items":[{"content":"Inspect","status":"in_progress"}]}', "w2")).toMatchObject({
      type: "worker.progress",
      workerId: "w2",
      message: "plan updated (1)",
      data: { kind: "plan", items: [{ content: "Inspect", status: "in_progress" }] },
    });
    expect(mapKnownCliJsonLine('{"type":"session.checkpoint","line":"assistant","path":"/tmp/session.jsonl"}', "w2")).toMatchObject({
      type: "worker.progress",
      workerId: "w2",
      message: "checkpoint: assistant",
      data: { path: "/tmp/session.jsonl", line: "assistant" },
    });
    expect(mapKnownCliJsonLine('{"type":"run.finished","ok":true}', "w2")).toMatchObject({
      type: "gate.finished",
      workerId: "w2",
      ok: true,
    });
    expect(mapKnownCliJsonLine('{"type":"code.task.finished","ok":false,"code":"max_steps_reached"}', "w2")).toMatchObject({
      type: "gate.finished",
      workerId: "w2",
      ok: false,
      summary: "code task failed: max_steps_reached",
    });
    expect(mapKnownCliJsonLine('{"type":"code.task.finished","ok":false,"code":"max_steps_reached","sessionPath":"/tmp/session.jsonl","resumeCommand":"Lynn code --resume /tmp/session.jsonl"}', "w2")).toEqual([
      expect.objectContaining({
        type: "worker.progress",
        workerId: "w2",
        message: "session saved",
        data: {
          path: "/tmp/session.jsonl",
          resumeCommand: "Lynn code --resume /tmp/session.jsonl",
          code: "max_steps_reached",
        },
      }),
      expect.objectContaining({
        type: "gate.finished",
        workerId: "w2",
        ok: false,
        summary: "code task failed: max_steps_reached",
      }),
    ]);
    expect(mapKnownCliJsonLine('{"type":"code.unknown"}', "w2")).toBeNull();
  });

  it("uses translated code JSON events in the streaming line parser", () => {
    const parse = createLineParser("w3");
    const events = parse(
      '{"type":"code.tool.requested","tool":"apply_patch","args":{"patch":"*** Begin Patch"}}\n{"type":"usage","durationMs":200,"usage":{"total_tokens":42,"completion_tokens":44}}\n',
    );
    expect(events[0]).toMatchObject({ type: "tool.started", workerId: "w3", name: "apply_patch" });
    expect(events[1]).toMatchObject({ type: "worker.progress", workerId: "w3", message: "usage", data: { total_tokens: 42, completion_tokens: 44, duration_ms: 200 } });
  });

  it("keeps resumable code task failures visible to the Fleet recovery UI", () => {
    const parse = createLineParser("w-resume");
    const events = parse('{"type":"code.task.finished","ok":false,"code":"max_steps_reached","sessionPath":"/tmp/lynn-session.jsonl","resumeCommand":"Lynn code --resume /tmp/lynn-session.jsonl"}\n');
    expect(events).toEqual([
      expect.objectContaining({
        type: "worker.progress",
        workerId: "w-resume",
        message: "session saved",
        data: expect.objectContaining({ path: "/tmp/lynn-session.jsonl" }),
      }),
      expect.objectContaining({
        type: "gate.finished",
        workerId: "w-resume",
        ok: false,
      }),
    ]);
  });
});

describe("spawnWorker", () => {
  it("emits a final worker event even when stdout has no trailing newline", async () => {
    const events: Array<{ type: string; workerId?: string; ok?: boolean }> = [];
    spawnWorker({
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({type:'worker.finished', ok:true, exitCode:0, summary:'done'}))"],
      cwd: process.cwd(),
      env: process.env,
      workerId: "w-no-newline",
    }, (event) => events.push(event as { type: string; workerId?: string; ok?: boolean }));

    await waitFor(() => events.some((event) => event.type === "worker.finished"));

    expect(events).toContainEqual(expect.objectContaining({
      type: "worker.finished",
      workerId: "w-no-newline",
      ok: true,
      exitCode: 0,
      summary: "done",
    }));
  });

  it("emits a recoverable worker error when the process exits non-zero", async () => {
    const events: Array<{ type: string; code?: string; message?: string; recoverable?: boolean }> = [];
    spawnWorker({
      command: process.execPath,
      args: ["-e", "process.exit(2)"],
      cwd: process.cwd(),
      env: process.env,
      workerId: "w-exit",
    }, (event) => events.push(event as { type: string; code?: string; message?: string; recoverable?: boolean }));

    await waitFor(() => events.some((event) => event.type === "worker.error"));

    expect(events).toContainEqual(expect.objectContaining({
      type: "worker.error",
      code: "worker_exit",
      message: "worker process exited with code 2",
      recoverable: true,
    }));
  });

  it("emits worker.finished when a successful process forgets its final event", async () => {
    const events: Array<{ type: string; summary?: string; ok?: boolean; exitCode?: number }> = [];
    spawnWorker({
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({type:'worker.progress', message:'almost done'}) + '\\n')"],
      cwd: process.cwd(),
      env: process.env,
      workerId: "w-missing-final",
    }, (event) => events.push(event as { type: string; summary?: string; ok?: boolean; exitCode?: number }));

    await waitFor(() => events.some((event) => event.type === "worker.finished"));

    expect(events).toContainEqual(expect.objectContaining({
      type: "worker.finished",
      ok: true,
      exitCode: 0,
      summary: "worker process exited without final event",
    }));
  });

  it("does not duplicate worker_exit when the worker already emitted a terminal error", async () => {
    const events: Array<{ type: string; code?: string; message?: string; recoverable?: boolean }> = [];
    spawnWorker({
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({type:'worker.error', code:'tool_failed', message:'tool failed', recoverable:true})); process.exit(2)"],
      cwd: process.cwd(),
      env: process.env,
      workerId: "w-terminal-error",
    }, (event) => events.push(event as { type: string; code?: string; message?: string; recoverable?: boolean }));

    await waitFor(() => events.some((event) => event.type === "worker.progress" && event.message?.includes("exited")));

    expect(events.filter((event) => event.type === "worker.error")).toEqual([
      expect.objectContaining({
        type: "worker.error",
        code: "tool_failed",
        message: "tool failed",
        recoverable: true,
      }),
    ]);
  });

  it("does not turn a user-cancelled process into a worker_exit failure", async () => {
    const events: Array<{ type: string; code?: string; message?: string }> = [];
    const handle = spawnWorker({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: process.env,
      workerId: "w-cancel",
    }, (event) => events.push(event as { type: string; code?: string; message?: string }));

    handle.kill();
    await waitFor(() => events.some((event) => event.type === "worker.progress" && event.message?.includes("cancelled")));

    expect(handle.cancelled()).toBe(true);
    expect(events.some((event) => event.type === "worker.error" && event.code === "worker_exit")).toBe(false);
  });
});

describe("worktree porcelain parser", () => {
  it("parses git worktree list --porcelain output", () => {
    const out =
      "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/wt-1\nHEAD def\nbranch refs/heads/cli-1/x\n";
    const list = parseWorktreePorcelain(out);
    expect(list).toHaveLength(2);
    expect(list[1]).toEqual({ path: "/repo/wt-1", head: "def", branch: "cli-1/x" });
  });
});

describe("worktree commit review helper", () => {
  it("rejects unsafe worktree paths and branch names before invoking git", async () => {
    const { WorktreeManager } = await import("../worktree-manager.js");
    const manager = new WorktreeManager(process.cwd());

    await expect(manager.create("../outside", "fleet/safe")).rejects.toThrow("invalid worktree path");
    await expect(manager.create("worktrees/safe", "../bad")).rejects.toThrow("invalid branch");
  });

  it("shows untracked files in the read-only diff drawer", async () => {
    const { WorktreeManager } = await import("../worktree-manager.js");
    const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lynn-fleet-diff-"));
    try {
      await execGit(["init"], repo);
      await execGit(["config", "user.email", "fleet@example.test"], repo);
      await execGit(["config", "user.name", "Fleet Test"], repo);
      await fs.promises.writeFile(path.join(repo, "README.md"), "base\n", "utf8");
      await execGit(["add", "README.md"], repo);
      await execGit(["commit", "-m", "init"], repo);

      await fs.promises.writeFile(path.join(repo, "new-file.txt"), "alpha\nbeta\n", "utf8");
      const diff = await new WorktreeManager(repo).fileDiff(repo, "new-file.txt");

      expect(diff).toContain("new-file.txt");
      expect(diff).toContain("+alpha");
      expect(diff).toContain("+beta");
    } finally {
      await fs.promises.rm(repo, { recursive: true, force: true });
    }
  });

  it("commits pending changes in a disposable worktree", async () => {
    const { WorktreeManager } = await import("../worktree-manager.js");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-fleet-commit-"));
    try {
      await execGit(["init"], tmp);
      await execGit(["config", "user.email", "fleet@example.test"], tmp);
      await execGit(["config", "user.name", "Fleet Test"], tmp);
      fs.writeFileSync(path.join(tmp, "README.md"), "one\n", "utf8");
      await execGit(["add", "README.md"], tmp);
      await execGit(["commit", "-m", "initial"], tmp);

      fs.writeFileSync(path.join(tmp, "README.md"), "two\n", "utf8");
      const result = await new WorktreeManager(tmp).commitAll(tmp, "fleet: approve test");

      expect(result.changed).toBe(true);
      expect(result.commit).toMatch(/^[0-9a-f]+$/);
      expect(await execGit(["log", "-1", "--pretty=%s"], tmp)).toBe("fleet: approve test");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("integrates an approved commit into a staging branch without switching the main checkout", async () => {
    const { WorktreeManager } = await import("../worktree-manager.js");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-fleet-integrate-"));
    try {
      await execGit(["init"], tmp);
      await execGit(["config", "user.email", "fleet@example.test"], tmp);
      await execGit(["config", "user.name", "Fleet Test"], tmp);
      fs.writeFileSync(path.join(tmp, "README.md"), "one\n", "utf8");
      await execGit(["add", "README.md"], tmp);
      await execGit(["commit", "-m", "initial"], tmp);
      const mainBranch = await execGit(["branch", "--show-current"], tmp);

      await execGit(["checkout", "-b", "worker/change"], tmp);
      fs.writeFileSync(path.join(tmp, "README.md"), "two\n", "utf8");
      await execGit(["commit", "-am", "worker change"], tmp);
      const workerCommit = await execGit(["rev-parse", "--short", "HEAD"], tmp);
      await execGit(["checkout", mainBranch], tmp);

      const result = await new WorktreeManager(tmp).integrateCommit(workerCommit, "fleet/test-integration");

      expect(result).toMatchObject({ branch: "fleet/test-integration", sourceCommit: workerCommit });
      expect(result.commit).toMatch(/^[0-9a-f]+$/);
      expect(await execGit(["branch", "--show-current"], tmp)).toBe(mainBranch);
      expect(await execGit(["log", "-1", "--pretty=%s", "fleet/test-integration"], tmp)).toBe("worker change");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("FleetHub.dispatch", () => {
  it("exposes StepFun 3.7 Flash as an enabled Lynn worker profile", () => {
    expect(DEFAULT_FLEET_REGISTRY.find((agent) => agent.id === "stepfun-flash")).toMatchObject({
      label: "StepFun 3.7 Flash (fast coding)",
      bin: "lynn",
      supportsJsonl: true,
      enabled: true,
      requiresPreset: "stepfun",
    });
  });

  it("does not mark StepFun workers available until the CLI BYOK preset is configured", () => {
    expect(resolveFleetRegistry({ pathEnv: "", configuredPreset: null }).find((agent) => agent.id === "stepfun-flash")).toMatchObject({
      enabled: true,
      available: false,
      availability: "requires: Lynn providers set --preset stepfun --api-key <api-key>",
    });

    expect(resolveFleetRegistry({ pathEnv: "", configuredPreset: "stepfun" }).find((agent) => agent.id === "stepfun-flash")).toMatchObject({
      enabled: true,
      available: true,
      availability: "bundled Lynn CLI runtime",
    });
  });

  it("detects the configured StepFun CLI provider preset from the Lynn home profile", () => {
    expect(configuredCliProviderPreset({
      lynnHome: "/tmp/lynn",
      readFileSync: () => JSON.stringify({
        baseUrl: "https://api.stepfun.com/step_plan/v1/",
        model: "step-3.7-flash",
        apiKey: "sk-step",
      }),
    })).toBe("stepfun");

    expect(configuredCliProviderPreset({
      lynnHome: "/tmp/lynn",
      readFileSync: () => JSON.stringify({
        baseUrl: "https://api.stepfun.com/step_plan/v1",
        model: "step-3.7-flash",
      }),
    })).toBeNull();
  });

  it("detects StepFun and MiMo presets from node-only environment variables", () => {
    expect(configuredCliProviderPreset({
      env: {
        LYNN_CLI_PRESET: "stepfun",
        LYNN_CLI_API_KEY: "sk-step",
      },
      readFileSync: () => {
        throw new Error("profile should not be read when env preset is complete");
      },
    })).toBe("stepfun");

    expect(configuredCliProviderPreset({
      env: {
        LYNN_CLI_BASE_URL: "https://token-plan-cn.xiaomimimo.com/v1",
        LYNN_CLI_MODEL: "mimo-v2.5-pro",
        LYNN_CLI_API_KEY: "mimo-key",
      },
      readFileSync: () => "{}",
    })).toBe("mimo");

    expect(configuredCliProviderPreset({
      env: {
        LYNN_CLI_PRESET: "stepfun",
      },
      readFileSync: () => {
        throw new Error("missing key should fall through to profile");
      },
    })).toBeNull();
  });

  it("exposes CodeBuddy as an enabled external worker profile", () => {
    expect(DEFAULT_FLEET_REGISTRY.find((agent) => agent.id === "codebuddy")).toMatchObject({
      label: "CodeBuddy",
      bin: "codebuddy",
      supportsJsonl: true,
      enabled: true,
    });
  });

  it("exposes Qwen and Kimi as enabled stream-json worker profiles", () => {
    expect(DEFAULT_FLEET_REGISTRY.find((agent) => agent.id === "qwen-cli")).toMatchObject({
      bin: "qwen",
      supportsJsonl: true,
      enabled: true,
    });
    expect(DEFAULT_FLEET_REGISTRY.find((agent) => agent.id === "kimi-cli")).toMatchObject({
      bin: "kimi",
      supportsJsonl: true,
      enabled: true,
    });
  });

  it("marks external worker profiles unavailable when their binaries are not on PATH", () => {
    const registry = resolveFleetRegistry({
      pathEnv: "/bin",
      fileExists: (file) => file === "/bin/qwen",
    });

    expect(registry.find((agent) => agent.id === "lynn-cli")).toMatchObject({
      enabled: true,
      available: true,
    });
    expect(registry.find((agent) => agent.id === "qwen-cli")).toMatchObject({
      enabled: true,
      available: true,
      availability: "/bin/qwen",
    });
    expect(registry.find((agent) => agent.id === "kimi-cli")).toMatchObject({
      enabled: false,
      available: false,
      availability: "not found on PATH",
    });
  });

  it("registers a worker and reports a recoverable error when no CLI runtime is available", async () => {
    const sent: Array<{ type: string; event: { type: string; approval?: string; sandbox?: string; code?: string; recoverable?: boolean } }> = [];
    const hub = new FleetHub("/repo", (m) => sent.push(m as { type: string; event: { type: string; approval?: string; sandbox?: string; code?: string; recoverable?: boolean } }), () => "T", {
      available: () => false,
    });
    const brief: FleetBrief = {
      title: "split ComposerTextarea",
      agent: "claude-code",
      objective: "extract component",
      owned: ["desktop/src/react/components/input/**"],
      forbidden: ["server/**"],
      branch: "cli-2/inputarea",
      worktree: "worktrees/cli-2",
      approval: "yolo",
      sandbox: "workspace-write",
    };
    const rec = await hub.dispatch(brief);

    expect(rec.workerId).toBe("w1");
    expect(rec.spawned).toBe(false);
    expect(hub.getWorker(rec.workerId)?.status).toBe("failed");
    expect(hub.listWorkers()).toHaveLength(1);
    expect(sent.every((m) => m.type === "fleet:event")).toBe(true);
    expect(sent.map((m) => m.event.type)).toEqual(["worker.started", "worker.claims", "worker.progress", "worker.error"]);
    expect(sent[0].event).toMatchObject({ approval: "yolo", sandbox: "workspace-write" });
    expect(sent.at(-1)?.event).toMatchObject({ code: "cli_runtime_unavailable", recoverable: true });
  });
});

const sampleBrief: FleetBrief = {
  title: "t",
  agent: "codex-cli",
  objective: "o",
  owned: ["a/**"],
  forbidden: ["server/**"],
  branch: "cli-1/x",
  worktree: "worktrees/cli-1",
};

const availableSampleRegistry = () => [
  { id: "codex-cli", label: "Codex", bin: "codex", supportsJsonl: true, enabled: true, available: true, availability: "/usr/bin/codex" },
];

describe("fleet HTTP route", () => {
  it("dispatches a worker through POST /fleet/dispatch", async () => {
    const sent: Array<{ type: string; event: { type: string; code?: string; recoverable?: boolean } }> = [];
    const app = new Hono();
    const hub = new FleetHub("/repo", (m) => sent.push(m as { type: string; event: { type: string; code?: string; recoverable?: boolean } }), () => "T", {
      available: () => false,
    });
    app.route("/api", createFleetRoute(hub, { registry: availableSampleRegistry }));

    const res = await app.request("/api/fleet/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sampleBrief),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.worker).toMatchObject({ workerId: "w1", brief: sampleBrief, spawned: false });
    expect(sent.every((m) => m.type === "fleet:event")).toBe(true);
    expect(sent.map((m) => m.event.type)).toEqual(["worker.started", "worker.claims", "worker.progress", "worker.error"]);
    expect(sent.at(-1)?.event).toMatchObject({ code: "cli_runtime_unavailable", recoverable: true });
  });

  it("dispatches through HTTP and streams a real Lynn CLI worker", async () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const cliBin = path.join(repoRoot, "cli/bin/lynn.mjs");
    const cliSrc = path.join(repoRoot, "cli/src/cli.ts");
    const briefPath = path.join(repoRoot, "cli/fixtures/worker-brief.md");
    const useBuiltCli = fs.existsSync(cliBin);
    const cliEntry = useBuiltCli ? cliBin : cliSrc;
    const nodePrefix = useBuiltCli ? [] : ["--import", "tsx"];
    const sent: Array<{ type: string; event: { type: string; workerId?: string; ok?: boolean } }> = [];
    const app = new Hono();
    const hub = new FleetHub(repoRoot, (m) => sent.push(m as { type: string; event: { type: string; workerId?: string; ok?: boolean } }), () => "T", {
      available: () => true,
      createWorktree: async () => {},
      writeBrief: () => briefPath,
      resolveCommand: (args) => ({
        command: process.execPath,
        args: [...nodePrefix, cliEntry, ...args, "--mock"],
        env: { ...process.env, NO_COLOR: "1" },
        source: "dev",
      }),
    });
    app.route("/api", createFleetRoute(hub, { registry: availableSampleRegistry }));

    const res = await app.request("/api/fleet/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...sampleBrief, worktree: repoRoot }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.worker).toMatchObject({ spawned: true });

    await waitFor(() => sent.some((m) => m.event.type === "worker.finished"));
    expect(sent.every((m) => m.type === "fleet:event")).toBe(true);
    expect(sent.some((m) => m.event.type === "worker.finished" && m.event.workerId === data.worker.workerId && m.event.ok === true)).toBe(true);
  });

  it("rejects dispatch when the requested worker is not available", async () => {
    const app = new Hono();
    const hub = new FleetHub("/repo", () => {}, () => "T");
    app.route("/api", createFleetRoute(hub, {
      registry: () => [
        {
          id: "stepfun-flash",
          label: "StepFun 3.7 Flash",
          bin: "lynn",
          supportsJsonl: true,
          enabled: true,
          available: false,
          availability: "requires: Lynn providers set --preset stepfun --api-key <api-key>",
        },
      ],
    }));

    const res = await app.request("/api/fleet/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...sampleBrief, agent: "stepfun-flash" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("requires: Lynn providers set --preset stepfun") });
    expect(hub.listWorkers()).toHaveLength(0);
  });

  it("rejects incomplete dispatch briefs before reaching FleetHub", async () => {
    const app = new Hono();
    const hub = new FleetHub("/repo", () => {}, () => "T");
    app.route("/api", createFleetRoute(hub));

    const res = await app.request("/api/fleet/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...sampleBrief, title: "", owned: undefined }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("title is required") });
    expect(hub.listWorkers()).toHaveLength(0);
  });
});

describe("FleetHub.retry", () => {
  it("re-dispatches a brief as a fresh worker", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T");
    const first = await hub.dispatch(sampleBrief);
    const again = await hub.retry(first.workerId);
    expect(again).not.toBeNull();
    expect(again && again.workerId).not.toBe(first.workerId);
    expect(again?.brief.branch).toBe("cli-1/x-retry-2");
    expect(again?.brief.worktree).toBe("worktrees/cli-1-retry-2");
    expect(again?.brief.objective).toBe(first.brief.objective);
    expect(hub.listWorkers()).toHaveLength(2);
  });

  it("returns null for an unknown worker", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T");
    expect(await hub.retry("nope")).toBeNull();
  });

  it("can re-dispatch from the latest session checkpoint", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T");
    const first = await hub.dispatch(sampleBrief);
    first.events.push({
      type: "worker.progress",
      workerId: first.workerId,
      message: "checkpoint: assistant",
      data: { path: "/tmp/lynn-session.jsonl", line: "assistant" },
    });

    const resumed = await hub.retry(first.workerId, { resumeFromCheckpoint: true });

    expect(resumed).not.toBeNull();
    expect(resumed?.brief.resumePath).toBe("/tmp/lynn-session.jsonl");
    expect(resumed?.brief.branch).toBe("cli-1/x-retry-2");
    expect(resumed?.brief.worktree).toBe("worktrees/cli-1-retry-2");
  });
});

describe("FleetHub review actions", () => {
  it("approves a clean worker waiting for review", async () => {
    const committed: Array<{ path: string; message: string }> = [];
    const sent: Array<{ event: { type: string; message?: string; data?: unknown } }> = [];
    const hub = new FleetHub("/repo", (m) => sent.push(m as { event: { type: string; message?: string } }), () => "T", {
      available: () => true,
      createWorktree: async () => {},
      writeBrief: () => "/tmp/brief.md",
      resolveCommand: (args) => ({ command: "node", args, env: {}, source: "dev" }),
      commitWorktree: async (worktreePath, message) => {
        committed.push({ path: worktreePath, message });
        return { changed: true, commit: "abc1234" };
      },
      spawn: (opts, onEvent) => {
        onEvent({ type: "worker.finished", workerId: opts.workerId, ok: true, exitCode: 0, summary: "ready" });
        return { workerId: opts.workerId, pid: 123, kill: () => {}, cancelled: () => false };
      },
    });

    const rec = await hub.dispatch(sampleBrief);
    expect(hub.getWorker(rec.workerId)?.status).toBe("waiting_approval");
    expect(await hub.approve(rec.workerId)).toEqual({ ok: true, changed: true, commit: "abc1234" });
    expect(committed).toEqual([{
      path: path.join("/repo", sampleBrief.worktree),
      message: expect.stringContaining("fleet(codex-cli): t"),
    }]);
    expect(hub.getWorker(rec.workerId)?.status).toBe("completed");
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: "worker.progress",
        message: "review approved: abc1234",
        data: expect.objectContaining({ kind: "review", action: "approved", commit: "abc1234", changed: true }),
      }),
    }));
  });

  it("keeps workers in review when the approval commit fails", async () => {
    const sent: Array<{ event: { type: string; message?: string; level?: string } }> = [];
    const hub = new FleetHub("/repo", (m) => sent.push(m as { event: { type: string; message?: string; level?: string } }), () => "T", {
      commitWorktree: async () => {
        throw new Error("missing git identity");
      },
    });
    const rec = await hub.dispatch(sampleBrief);
    rec.status = "waiting_approval";

    expect(await hub.approve(rec.workerId)).toMatchObject({
      ok: false,
      error: expect.stringContaining("missing git identity"),
    });
    expect(hub.getWorker(rec.workerId)?.status).toBe("waiting_approval");
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: "worker.progress",
        message: expect.stringContaining("review commit failed"),
        level: "warning",
      }),
    }));
  });

  it("integrates an approved worker commit into a staging branch", async () => {
    const integrated: Array<{ commit: string; branch: string }> = [];
    const sent: Array<{ event: { type: string; message?: string; data?: unknown } }> = [];
    const hub = new FleetHub("/repo", (m) => sent.push(m as { event: { type: string; message?: string; data?: unknown } }), () => "T", {
      integrateCommit: async (commit, branch) => {
        integrated.push({ commit, branch });
        return { branch, commit: "def5678", sourceCommit: commit };
      },
    });
    const rec = await hub.dispatch(sampleBrief);
    rec.events.push({
      type: "worker.progress",
      workerId: rec.workerId,
      message: "review approved: abc1234",
      data: { kind: "review", action: "approved", commit: "abc1234", changed: true },
    });
    rec.status = "completed";

    expect(await hub.integrate(rec.workerId, "fleet/test")).toEqual({
      ok: true,
      branch: "fleet/test",
      commit: "def5678",
      sourceCommit: "abc1234",
      gate: { passed: true, reasons: [], testsFailed: 0, gatesFailed: 0, violations: 0, ran: false },
    });
    expect(integrated).toEqual([{ commit: "abc1234", branch: "fleet/test" }]);
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: "worker.progress",
        message: "review integrated: fleet/test@def5678",
        data: expect.objectContaining({ kind: "review", action: "integrated", commit: "def5678", sourceCommit: "abc1234", branch: "fleet/test" }),
      }),
    }));
  });

  it("blocks integrate when the gate fails, and force overrides it", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T", {
      integrateCommit: async (commit, branch) => ({ branch, commit: "def5678", sourceCommit: commit }),
    });
    const rec = await hub.dispatch(sampleBrief);
    rec.events.push({ type: "worker.progress", workerId: rec.workerId, message: "approved", data: { kind: "review", action: "approved", commit: "abc1234", changed: true } });
    rec.events.push({ type: "test.finished", workerId: rec.workerId, command: "npm test", ok: false });
    rec.status = "completed";

    const blocked = await hub.integrate(rec.workerId, "main");
    expect(blocked).toMatchObject({ ok: false, error: expect.stringContaining("gate not passed") });
    expect(blocked?.gate).toMatchObject({ passed: false, testsFailed: 1 });

    const forced = await hub.integrate(rec.workerId, "main", { force: true });
    expect(forced).toMatchObject({ ok: true, branch: "main", commit: "def5678" });
  });

  it("evaluateGate categorizes test / gate / violation failures", () => {
    expect(evaluateGate([])).toMatchObject({ passed: true, reasons: [] });
    const failed = evaluateGate([
      { type: "test.finished", command: "x", ok: false },
      { type: "worker.violation", code: "forbidden_file", message: "x" },
    ] as never);
    expect(failed.passed).toBe(false);
    expect(failed.testsFailed).toBe(1);
    expect(failed.violations).toBe(1);
    expect(failed.reasons.length).toBe(2);
  });

  it("rejects integrate before a worker is approved", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T");
    const rec = await hub.dispatch(sampleBrief);

    expect(await hub.integrate(rec.workerId, "fleet/test")).toMatchObject({
      ok: false,
      error: expect.stringContaining("no approved commit"),
    });
  });

  it("rejects approve for blocked workers", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T");
    const rec = await hub.dispatch(sampleBrief);
    rec.status = "blocked";

    expect(await hub.approve(rec.workerId)).toMatchObject({ ok: false, error: expect.stringContaining("blocked") });
  });

  it("discards reviewed work and removes the worktree when possible", async () => {
    const removed: string[] = [];
    const sent: Array<{ event: { type: string; message?: string } }> = [];
    const hub = new FleetHub("/repo", (m) => sent.push(m as { event: { type: string; message?: string } }), () => "T", {
      removeWorktree: async (p) => { removed.push(p); },
    });
    const rec = await hub.dispatch(sampleBrief);
    rec.status = "waiting_approval";

    expect(await hub.discard(rec.workerId)).toEqual({ ok: true });
    expect(removed).toEqual([sampleBrief.worktree]);
    expect(hub.getWorker(rec.workerId)?.status).toBe("cancelled");
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ type: "worker.progress", message: "review discarded" }),
    }));
  });
});

describe("fleet review HTTP route", () => {
  it("approves and discards workers through REST endpoints", async () => {
    const app = new Hono();
    const hub = new FleetHub("/repo", () => {}, () => "T", {
      removeWorktree: async () => {},
      commitWorktree: async () => ({ changed: false }),
    });
    app.route("/api", createFleetRoute(hub, { registry: availableSampleRegistry }));

    const rec = await hub.dispatch(sampleBrief);
    rec.status = "waiting_approval";
    const approved = await app.request(`/api/fleet/workers/${rec.workerId}/approve`, { method: "POST" });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ ok: true, changed: false });
    expect(hub.getWorker(rec.workerId)?.status).toBe("completed");

    const discarded = await app.request(`/api/fleet/workers/${rec.workerId}/discard`, { method: "POST" });
    expect(discarded.status).toBe(200);
    expect(hub.getWorker(rec.workerId)?.status).toBe("cancelled");
  });

  it("integrates approved workers through REST endpoints", async () => {
    const app = new Hono();
    const hub = new FleetHub("/repo", () => {}, () => "T", {
      integrateCommit: async (commit, branch) => ({ branch, commit: "def5678", sourceCommit: commit }),
    });
    app.route("/api", createFleetRoute(hub, { registry: availableSampleRegistry }));

    const rec = await hub.dispatch(sampleBrief);
    rec.events.push({
      type: "worker.progress",
      workerId: rec.workerId,
      message: "review approved: abc1234",
      data: { kind: "review", action: "approved", commit: "abc1234", changed: true },
    });
    rec.status = "completed";

    const integrated = await app.request(`/api/fleet/workers/${rec.workerId}/integrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "fleet/test" }),
    });

    expect(integrated.status).toBe(200);
    expect(await integrated.json()).toEqual({ ok: true, branch: "fleet/test", commit: "def5678", sourceCommit: "abc1234", gate: { passed: true, reasons: [], testsFailed: 0, gatesFailed: 0, violations: 0, ran: false } });
  });
});

describe("FleetHub.getWorkerFileDiff path guard", () => {
  it("rejects path traversal without touching git", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T");
    const rec = await hub.dispatch(sampleBrief);
    expect(await hub.getWorkerFileDiff(rec.workerId, "../../etc/passwd")).toEqual({
      file: "../../etc/passwd",
      diff: "",
      error: "invalid path",
    });
  });

  it("returns null for an unknown worker", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T");
    expect(await hub.getWorkerFileDiff("nope", "a.ts")).toBeNull();
  });
});

describe("worker-command resolveCliCommand", () => {
  it("uses LYNN_CLI_ENTRY from env (main-provided) + electron-as-node flag", () => {
    const cmd = resolveCliCommand(["worker", "run", "--jsonl"], {
      env: { LYNN_CLI_ENTRY: "/res/cli/lynn.mjs", LYNN_CLI_NODE: "/Lynn", LYNN_CLI_ELECTRON_AS_NODE: "1" },
      fileExists: (p) => p === "/res/cli/lynn.mjs",
    });
    expect(cmd).not.toBeNull();
    expect(cmd && cmd.command).toBe("/Lynn");
    expect(cmd && cmd.args).toEqual(["/res/cli/lynn.mjs", "worker", "run", "--jsonl"]);
    expect(cmd && cmd.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("keeps the legacy fleet runner env compatible during branch integration", () => {
    const cmd = resolveCliCommand(["worker", "run", "--jsonl"], {
      env: {
        LYNN_FLEET_RUNNER_COMMAND: "/Lynn",
        LYNN_FLEET_RUNNER_ARGS_PREFIX: JSON.stringify(["/res/cli/lynn.mjs"]),
        LYNN_FLEET_RUNNER_ELECTRON_AS_NODE: "1",
      },
      fileExists: () => false,
    });
    expect(cliRuntimeAvailable({
      env: { LYNN_FLEET_RUNNER_COMMAND: "/Lynn", LYNN_FLEET_RUNNER_ARGS_PREFIX: "[]" },
      fileExists: () => false,
    })).toBe(true);
    expect(cmd).not.toBeNull();
    expect(cmd && cmd.command).toBe("/Lynn");
    expect(cmd && cmd.args).toEqual(["/res/cli/lynn.mjs", "worker", "run", "--jsonl"]);
    expect(cmd && cmd.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("falls back to a dev cli build under the repo", () => {
    const cmd = resolveCliCommand(["worker", "run"], {
      repoRoot: "/repo",
      execPath: "/usr/bin/node",
      env: {},
      fileExists: (p) => p === "/repo/cli/bin/lynn.mjs",
    });
    expect(cmd && cmd.command).toBe("/usr/bin/node");
    expect(cmd && cmd.args[0]).toBe("/repo/cli/bin/lynn.mjs");
  });

  it("returns null when no CLI runtime is available", () => {
    expect(cliRuntimeAvailable({ repoRoot: "/repo", env: {}, fileExists: () => false })).toBe(false);
    expect(resolveCliCommand(["worker"], { repoRoot: "/repo", env: {}, fileExists: () => false })).toBeNull();
  });
});

describe("FleetHub real spawn", () => {
  it("spawns lynn worker run when a CLI runtime is available", async () => {
    const sent: Array<{ type: string; event: { type: string } }> = [];
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const hub = new FleetHub("/repo", (m) => sent.push(m as { type: string; event: { type: string } }), () => "T", {
      available: () => true,
      createWorktree: async () => {},
      writeBrief: () => "/tmp/brief.md",
      resolveCommand: (args) => ({ command: "node", args, env: {}, source: "dev" }),
      spawn: (opts, onEvent) => {
        spawnCalls.push({ command: opts.command, args: opts.args });
        onEvent({ type: "worker.progress", workerId: opts.workerId, message: "running" });
        onEvent({ type: "worker.finished", workerId: opts.workerId, ok: true, exitCode: 0, summary: "done" });
        return { workerId: opts.workerId, pid: 123, kill: () => {}, cancelled: () => false };
      },
    });
    const rec = await hub.dispatch(sampleBrief);
    expect(rec.spawned).toBe(true);
    expect(rec.status).toBe("waiting_approval");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("node");
    expect(spawnCalls[0].args).toContain("worker");
    expect(spawnCalls[0].args).toContain("--jsonl");
    expect(spawnCalls[0].args).toContain("--brief");
    expect(spawnCalls[0].args).toContain("--id");
    expect(spawnCalls[0].args).toContain("w1");
    expect(spawnCalls[0].args).toContain("--agent");
    expect(spawnCalls[0].args).toContain("codex-cli");
    expect(sent.map((m) => m.event.type)).toContain("worker.finished");
  });

  it("streams JSONL from the real Lynn CLI worker process", async () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const cliBin = path.join(repoRoot, "cli/bin/lynn.mjs");
    const cliSrc = path.join(repoRoot, "cli/src/cli.ts");
    const briefPath = path.join(repoRoot, "cli/fixtures/worker-brief.md");
    const useBuiltCli = fs.existsSync(cliBin);
    const cliEntry = useBuiltCli ? cliBin : cliSrc;
    const nodePrefix = useBuiltCli ? [] : ["--import", "tsx"];
    const sent: Array<{ type: string; event: { type: string; workerId?: string; message?: string; ok?: boolean } }> = [];
    const hub = new FleetHub(repoRoot, (m) => sent.push(m as { type: string; event: { type: string; workerId?: string; message?: string; ok?: boolean } }), () => "T", {
      available: () => true,
      createWorktree: async () => {},
      writeBrief: () => briefPath,
      resolveCommand: (args) => ({
        command: process.execPath,
        args: [...nodePrefix, cliEntry, ...args, "--mock"],
        env: { ...process.env, NO_COLOR: "1" },
        source: "dev",
      }),
    });

    const rec = await hub.dispatch({ ...sampleBrief, worktree: repoRoot });
    await waitFor(() => sent.some((m) => m.event.type === "worker.finished"));

    expect(rec.spawned).toBe(true);
    expect(sent.every((m) => m.type === "fleet:event")).toBe(true);
    expect(sent.some((m) => m.event.type === "worker.progress" && /spawned via/.test(m.event.message ?? ""))).toBe(true);
    expect(sent.some((m) => m.event.type === "worker.finished" && m.event.workerId === rec.workerId && m.event.ok === true)).toBe(true);
    expect(rec.events.some((event) => event.type === "worker.finished")).toBe(true);
    expect(hub.getWorker(rec.workerId)?.status).toBe("waiting_approval");
  });

  it("updates REST worker status after terminal worker errors", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T", {
      available: () => true,
      createWorktree: async () => {},
      writeBrief: () => "/tmp/brief.md",
      resolveCommand: (args) => ({ command: "node", args, env: {}, source: "dev" }),
      spawn: (opts, onEvent) => {
        onEvent({ type: "worker.error", workerId: opts.workerId, code: "tool_failed", message: "tool failed", recoverable: true });
        return { workerId: opts.workerId, pid: 123, kill: () => {}, cancelled: () => false };
      },
    });

    const rec = await hub.dispatch(sampleBrief);

    expect(hub.getWorker(rec.workerId)?.status).toBe("failed");
  });

  it("falls back to a stub broadcast when no CLI runtime (cli/** not integrated yet)", async () => {
    const sent: Array<{ event: { type: string } }> = [];
    const hub = new FleetHub("/repo", (m) => sent.push(m as { event: { type: string } }), () => "T", {
      available: () => false,
    });
    const rec = await hub.dispatch(sampleBrief);
    expect(rec.spawned).toBe(false);
    expect(hub.getWorker(rec.workerId)?.status).toBe("failed");
    expect(sent.map((m) => m.event.type)).toEqual(["worker.started", "worker.claims", "worker.progress", "worker.error"]);
    expect(sent.at(-1)?.event).toMatchObject({
      type: "worker.error",
      code: "cli_runtime_unavailable",
      recoverable: true,
    });
  });

  it("aborts real spawn when worktree creation fails", async () => {
    const sent: Array<{ event: { type: string; code?: string } }> = [];
    let spawned = false;
    const hub = new FleetHub("/repo", (m) => sent.push(m as { event: { type: string; code?: string } }), () => "T", {
      available: () => true,
      createWorktree: async () => { throw new Error("branch exists"); },
      resolveCommand: (args) => ({ command: "node", args, env: {}, source: "dev" }),
      spawn: () => {
        spawned = true;
        return { workerId: "w", pid: 123, kill: () => {}, cancelled: () => false };
      },
    });

    const rec = await hub.dispatch(sampleBrief);

    expect(spawned).toBe(false);
    expect(hub.getWorker(rec.workerId)?.status).toBe("failed");
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ type: "worker.error", code: "worktree_create_failed" }),
    }));
  });

  it("writes visual task metadata in the brief format parsed by Lynn CLI", async () => {
    let briefText = "";
    let spawnedArgs: string[] = [];
    const hub = new FleetHub("/repo", () => {}, () => "T", {
      available: () => true,
      createWorktree: async () => {},
      resolveCommand: (args) => ({ command: "node", args, env: {}, source: "dev" }),
      spawn: (opts) => {
        spawnedArgs = opts.args;
        const briefIndex = opts.args.indexOf("--brief");
        if (briefIndex >= 0) {
          briefText = fs.readFileSync(opts.args[briefIndex + 1], "utf8");
        }
        return { workerId: opts.workerId, pid: 123, kill: () => {}, cancelled: () => false };
      },
    });
    await hub.dispatch({
      ...sampleBrief,
      agent: "mimo-vl",
      taskType: "ground",
      image: "screenshots/login.png",
      objective: "Find the login button.",
      approval: "yolo",
      sandbox: "workspace-write",
    });

    expect(briefText).toContain("## Task Type\nground");
    expect(briefText).toContain("## Image\nscreenshots/login.png");
    expect(briefText).toContain("## Permissions\n- approval: yolo\n- sandbox: workspace-write");
    expect(spawnedArgs).toEqual(expect.arrayContaining(["--approval", "yolo", "--sandbox", "workspace-write"]));
  });

  it("writes resume metadata in the brief format parsed by Lynn CLI", async () => {
    let briefText = "";
    const hub = new FleetHub("/repo", () => {}, () => "T", {
      available: () => true,
      createWorktree: async () => {},
      resolveCommand: (args) => ({ command: "node", args, env: {}, source: "dev" }),
      spawn: (opts) => {
        const briefIndex = opts.args.indexOf("--brief");
        if (briefIndex >= 0) {
          briefText = fs.readFileSync(opts.args[briefIndex + 1], "utf8");
        }
        return { workerId: opts.workerId, pid: 123, kill: () => {}, cancelled: () => false };
      },
    });
    await hub.dispatch({
      ...sampleBrief,
      resumePath: "/tmp/lynn-session.jsonl",
    });

    expect(briefText).toContain("## Resume\n/tmp/lynn-session.jsonl");
  });
});
