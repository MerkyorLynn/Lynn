import { describe, expect, it } from "vitest";
import { matchAnyGlob, evaluateScope, annotateChangedFiles } from "../forbidden-guard.js";
import { createLineParser } from "../worker-manager.js";
import { parseWorktreePorcelain } from "../worktree-manager.js";
import { FleetHub, type FleetBrief } from "../fleet-hub.js";
import { resolveCliCommand, cliRuntimeAvailable } from "../worker-command.js";

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

describe("FleetHub.dispatch", () => {
  it("registers a worker and broadcasts started -> claims -> progress as fleet:event", async () => {
    const sent: Array<{ type: string; event: { type: string } }> = [];
    const hub = new FleetHub("/repo", (m) => sent.push(m as { type: string; event: { type: string } }), () => "T");
    const brief: FleetBrief = {
      title: "split ComposerTextarea",
      agent: "claude-code",
      objective: "extract component",
      owned: ["desktop/src/react/components/input/**"],
      forbidden: ["server/**"],
      branch: "cli-2/inputarea",
      worktree: "worktrees/cli-2",
    };
    const rec = await hub.dispatch(brief);

    expect(rec.workerId).toBe("w1");
    expect(hub.listWorkers()).toHaveLength(1);
    expect(sent.every((m) => m.type === "fleet:event")).toBe(true);
    expect(sent.map((m) => m.event.type)).toEqual(["worker.started", "worker.claims", "worker.progress"]);
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

describe("FleetHub.retry", () => {
  it("re-dispatches a brief as a fresh worker", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T");
    const first = await hub.dispatch(sampleBrief);
    const again = await hub.retry(first.workerId);
    expect(again).not.toBeNull();
    expect(again && again.workerId).not.toBe(first.workerId);
    expect(hub.listWorkers()).toHaveLength(2);
  });

  it("returns null for an unknown worker", async () => {
    const hub = new FleetHub("/repo", () => {}, () => "T");
    expect(await hub.retry("nope")).toBeNull();
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
      resolveCommand: (args) => ({ command: "node", args, env: {} }),
      spawn: (opts, onEvent) => {
        spawnCalls.push({ command: opts.command, args: opts.args });
        onEvent({ type: "worker.progress", workerId: opts.workerId, message: "running" });
        onEvent({ type: "worker.finished", workerId: opts.workerId, ok: true, exitCode: 0, summary: "done" });
        return { workerId: opts.workerId, pid: 123, kill: () => {} };
      },
    });
    const rec = await hub.dispatch(sampleBrief);
    expect(rec.spawned).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("node");
    expect(spawnCalls[0].args).toContain("worker");
    expect(spawnCalls[0].args).toContain("--jsonl");
    expect(spawnCalls[0].args).toContain("--brief");
    expect(sent.map((m) => m.event.type)).toContain("worker.finished");
  });

  it("falls back to a stub broadcast when no CLI runtime (cli/** not integrated yet)", async () => {
    const sent: Array<{ event: { type: string } }> = [];
    const hub = new FleetHub("/repo", (m) => sent.push(m as { event: { type: string } }), () => "T", {
      available: () => false,
    });
    const rec = await hub.dispatch(sampleBrief);
    expect(rec.spawned).toBe(false);
    expect(sent.map((m) => m.event.type)).toEqual(["worker.started", "worker.claims", "worker.progress"]);
  });
});
