import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildDefaultAgentCommand,
  buildWorkerPrompt,
  collectGitDiff,
  externalJsonEvents,
  extractGroundingBoxes,
  isAnswerOnlyWorkerBrief,
  parseWorkerBrief,
  parseWorkerEventLine,
  runWorker,
  workerProfileDefaults,
  workerProviderPreset,
} from "../src/commands/worker-run.js";
import { parseArgs } from "../src/args.js";

const execFileAsync = promisify(execFile);
const PASS_TEST_COMMAND = "node -e \"process.exit(0)\"";

async function makeTempGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-worker-run-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  return dir;
}

describe("worker-run · brief parsing & external adapters", () => {
  it("parses task brief ownership and tests", () => {
    const brief = parseWorkerBrief([
      "# Task: Split input",
      "",
      "## Task Type",
      "code",
      "",
      "## Objective",
      "Make InputArea smaller.",
      "",
      "## Owned files",
      "- desktop/src/react/components/InputArea.tsx",
      "- desktop/src/react/components/input/**",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      "- npm run typecheck",
    ].join("\n"));

    expect(brief.title).toBe("Task: Split input");
    expect(brief.taskType).toBe("code");
    expect(brief.objective).toBe("Make InputArea smaller.");
    expect(brief.owned).toEqual([
      "desktop/src/react/components/InputArea.tsx",
      "desktop/src/react/components/input/**",
    ]);
    expect(brief.forbidden).toEqual(["server/**"]);
    expect(brief.tests).toEqual(["npm run typecheck"]);
  });

  it("parses MiMo vision task metadata from GUI Fleet briefs", () => {
    const brief = parseWorkerBrief([
      "# Task: Ground UI",
      "",
      "## Task Type",
      "- ground",
      "",
      "## Image",
      "- screenshots/login.png",
      "",
      "## Resume",
      "- /tmp/lynn-session.jsonl",
      "",
      "## Objective",
      "Find the login button.",
      "",
      "## Owned files",
      "- desktop/src/react/**",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      "- npm run typecheck",
    ].join("\n"));

    expect(brief.taskType).toBe("ground");
    expect(brief.image).toBe("screenshots/login.png");
    expect(brief.resumePath).toBe("/tmp/lynn-session.jsonl");
  });

  it("extracts normalized grounding boxes from MiMo JSON text", () => {
    expect(extractGroundingBoxes('```json\n{"x":0.25,"y":0.5,"w":0.2,"h":0.1,"confidence":0.88,"label":"submit"}\n```')).toEqual([{
      label: "submit",
      x: 0.25,
      y: 0.5,
      width: 0.2,
      height: 0.1,
      confidence: 0.88,
    }]);
  });

  it("parses fleet JSONL event lines", () => {
    const parsed = parseWorkerEventLine(JSON.stringify({
      type: "worker.progress",
      message: "hello",
    }));

    expect(parsed.ok).toBe(true);
    expect(parsed.event?.type).toBe("worker.progress");
  });

  it("normalizes external CLI stream-json assistant and tool events", () => {
    expect(externalJsonEvents(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    }), "w1", "codebuddy")).toEqual([
      { type: "assistant.delta", workerId: "w1", agent: "codebuddy", text: "hello" },
    ]);
    expect(externalJsonEvents(JSON.stringify({
      type: "reasoning",
      text: "thinking",
    }), "w1", "codebuddy")).toEqual([
      { type: "reasoning.delta", workerId: "w1", agent: "codebuddy", text: "thinking", hidden: true },
    ]);
    expect(externalJsonEvents(JSON.stringify({
      type: "tool_use",
      name: "Read",
      input: { file: "README.md" },
    }), "w1", "codebuddy")).toEqual([
      { type: "tool.started", workerId: "w1", agent: "codebuddy", name: "Read", argsPreview: "{\"file\":\"README.md\"}" },
    ]);
    expect(externalJsonEvents(JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Edit", input: { file: "a.ts" } },
          { type: "tool_result", name: "Edit", is_error: false },
        ],
      },
    }), "w1", "codebuddy")).toEqual([
      { type: "tool.started", workerId: "w1", agent: "codebuddy", name: "Edit", argsPreview: "{\"file\":\"a.ts\"}" },
      { type: "tool.finished", workerId: "w1", agent: "codebuddy", name: "Edit", ok: true },
    ]);
  });

  it("normalizes Codex-style item command events into shell events", () => {
    expect(externalJsonEvents(JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "npm test" },
    }), "w1", "codex-cli")).toEqual([
      { type: "shell.started", workerId: "w1", agent: "codex-cli", command: "npm test", approval: "auto" },
    ]);
    expect(externalJsonEvents(JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "npm test", exit_code: 0 },
    }), "w1", "codex-cli")).toEqual([
      { type: "shell.finished", workerId: "w1", agent: "codex-cli", command: "npm test", exitCode: 0, ok: true },
    ]);
  });

  it("normalizes nested item assistant and reasoning text", () => {
    expect(externalJsonEvents(JSON.stringify({
      type: "item.completed",
      item: { type: "assistant_message", text: "done" },
    }), "w1", "codex-cli")).toEqual([
      { type: "assistant.delta", workerId: "w1", agent: "codex-cli", text: "done" },
    ]);
    expect(externalJsonEvents(JSON.stringify({
      type: "item.completed",
      data: { item: { type: "reasoning", content: "thinking" } },
    }), "w1", "codex-cli")).toEqual([
      { type: "reasoning.delta", workerId: "w1", agent: "codex-cli", text: "thinking", hidden: true },
    ]);
  });

  it("normalizes object-valued tool fields from external CLIs", () => {
    expect(externalJsonEvents(JSON.stringify({
      type: "tool_call",
      tool: { name: "apply_patch" },
      arguments: { file: "a.ts" },
    }), "w1", "qwen-cli")).toEqual([
      { type: "tool.started", workerId: "w1", agent: "qwen-cli", name: "apply_patch", argsPreview: "{\"file\":\"a.ts\"}" },
    ]);
  });

  it("injects Lynn worker guardrails into external prompts", () => {
    const prompt = buildWorkerPrompt("## Objective\nDo the work.");

    expect(prompt).toContain("Lynn Fleet worker");
    expect(prompt).toContain("Do not download model weights");
    expect(prompt).toContain("## Objective\nDo the work.");
  });

  it("builds Codex worker commands without relying on invalid --file flags", () => {
    const command = buildDefaultAgentCommand("codex-cli", "/tmp/task brief.md", "/tmp/work tree", "hello 'world'");

    expect(command).toContain("codex exec");
    expect(command).toContain("--cd '/tmp/work tree'");
    expect(command).toContain("--json");
    expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(command).not.toContain("--file");
    expect(command).toContain("hello '\\''world'\\'''");
  });

  it("builds non-interactive Claude, Qwen, and Kimi worker commands", () => {
    const claude = buildDefaultAgentCommand("claude-code", "/tmp/task.md", "/tmp/wt", "task");
    const qwen = buildDefaultAgentCommand("qwen-cli", "/tmp/task.md", "/tmp/wt", "task");
    const kimi = buildDefaultAgentCommand("kimi-cli", "/tmp/task.md", "/tmp/wt", "task");
    const codebuddy = buildDefaultAgentCommand("codebuddy", "/tmp/task.md", "/tmp/wt", "task");

    expect(claude).toContain("claude -p");
    expect(claude).toContain("--add-dir '/tmp/wt'");
    expect(claude).toContain("--output-format stream-json");
    expect(claude).toContain("--dangerously-skip-permissions");
    expect(claude?.endsWith("\ntask'")).toBe(true);

    expect(qwen).toContain("qwen -p");
    expect(qwen).toContain("--add-dir '/tmp/wt'");
    expect(qwen).toContain("--approval-mode yolo");
    expect(qwen).toContain("--yolo");

    expect(kimi).toContain("kimi --work-dir '/tmp/wt'");
    expect(kimi).toContain("--print");
    expect(kimi).toContain("--output-format stream-json");
    expect(kimi).toContain("--afk");

    expect(codebuddy).toContain("codebuddy -p");
    expect(codebuddy).toContain("--output-format stream-json");
    expect(codebuddy).toContain("--include-partial-messages");
    expect(codebuddy).toContain("--add-dir '/tmp/wt'");
    expect(codebuddy).toContain("--permission-mode bypassPermissions");
    expect(codebuddy).toContain("-y");
  });

  it("returns null for unknown default worker agents", () => {
    expect(buildDefaultAgentCommand("custom", "/tmp/task.md", "/tmp/wt", "task")).toBeNull();
  });

  it("blocks default external worker adapters unless YOLO/full-access is explicit", async () => {
    const repo = await makeTempGitRepo();
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: external guarded",
      "",
      "## Objective",
      "Try to run an external worker.",
      "",
      "## Owned files",
      "- **",
      "",
      "## Forbidden files",
      "- server/**",
    ].join("\n"));
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runWorker(parseArgs([
        "worker",
        "run",
        "--brief",
        briefPath,
        "--worktree",
        repo,
        "--agent",
        "codex-cli",
      ]));
      expect(code).toBe(2);
    } finally {
      process.stdout.write = original;
    }

    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      type: string;
      code?: string;
      ok?: boolean;
      summary?: string;
    });
    expect(lines).toContainEqual(expect.objectContaining({
      type: "worker.error",
      code: "external_worker_requires_yolo",
    }));
    expect(lines).toContainEqual(expect.objectContaining({
      type: "gate.finished",
      ok: false,
      summary: expect.stringContaining("explicit YOLO"),
    }));
  });

  it("maps StepFun Fleet workers to the StepFun BYOK preset", () => {
    expect(workerProviderPreset("stepfun-flash")).toBe("stepfun");
    expect(workerProviderPreset("lynn-cli")).toBeNull();
  });

  it("emits the effective permission profile on worker start instead of hiding YOLO defaults", async () => {
    const repo = await makeTempGitRepo();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-worker-perms-"));
    await fs.mkdir(path.join(dataDir, "permissions"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "permissions", "cli.json"), JSON.stringify({ approval: "never", sandbox: "read-only" }), "utf8");
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: inspect only",
      "",
      "## Objective",
      "Read the repo.",
      "",
      "## Owned files",
      "- **",
      "",
      "## Forbidden files",
      "- /",
    ].join("\n"));

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runWorker(parseArgs([
        "worker",
        "run",
        "--brief",
        briefPath,
        "--worktree",
        repo,
        "--mock",
        "--data-dir",
        dataDir,
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    const started = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      type: string;
      approval?: string;
      sandbox?: string;
    }).find((line) => line.type === "worker.started");
    expect(started).toMatchObject({ approval: "never", sandbox: "read-only" });
  });

  it("applies concrete defaults for MiMo Fleet worker profiles", () => {
    expect(workerProfileDefaults("mimo-fast")).toEqual({ reasoning: "off", maxSteps: "6" });
    expect(workerProfileDefaults("mimo-pro")).toEqual({ reasoning: "high", maxSteps: "100", long: true });
    expect(workerProfileDefaults("mimo-vl")).toEqual({ reasoning: "high" });
    expect(workerProfileDefaults("stepfun-flash")).toEqual({ reasoning: "high", maxSteps: "300", long: true });
    expect(workerProfileDefaults("lynn-cli")).toEqual({});
  });

  it("detects answer-only Fleet briefs that should not enter the tool loop", () => {
    expect(isAnswerOnlyWorkerBrief(parseWorkerBrief([
      "# Task: smoke",
      "",
      "## Objective",
      "Reply exactly `worker ok` and finish. Do not inspect files and do not run tools.",
    ].join("\n")))).toBe(true);
    expect(isAnswerOnlyWorkerBrief(parseWorkerBrief([
      "# Task: smoke",
      "",
      "Reply exactly: worker ok",
      "Do not inspect files.",
      "Do not run tools.",
    ].join("\n")))).toBe(true);
    expect(isAnswerOnlyWorkerBrief(parseWorkerBrief([
      "# Task: patch file",
      "",
      "## Objective",
      "Change hello to lynn.",
      "",
      "## Test commands",
      "- npm test",
    ].join("\n")))).toBe(false);
  });

  it("runs mimo-fast workers with thinking disabled unless overridden", async () => {
    const repo = await makeTempGitRepo();
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: quick answer",
      "",
      "## Objective",
      "Answer quickly.",
      "",
      "## Owned files",
      "- cli/**",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      `- ${PASS_TEST_COMMAND}`,
    ].join("\n"));
    let body = "";
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Fast worker done." } }] })}\n\ndata: [DONE]\n\n`);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await runWorker(parseArgs([
        "worker",
        "run",
        "--brief",
        briefPath,
        "--worktree",
        repo,
        "--agent",
        "mimo-fast",
        "--brain-url",
        `http://127.0.0.1:${address.port}`,
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const parsed = JSON.parse(body) as { reasoning_effort?: string; extra_body?: { enable_thinking?: boolean } };
    expect(parsed.reasoning_effort).toBe("off");
    expect(parsed.extra_body?.enable_thinking).toBe(false);
  });

  it("runs mimo-pro workers with endurance defaults enabled", async () => {
    const repo = await makeTempGitRepo();
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: long analysis",
      "",
      "## Objective",
      "Run a longer coding worker.",
      "",
      "## Owned files",
      "- cli/**",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      `- ${PASS_TEST_COMMAND}`,
    ].join("\n"));
    let body = "";
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Long worker done." } }] })}\n\ndata: [DONE]\n\n`);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await runWorker(parseArgs([
        "worker",
        "run",
        "--brief",
        briefPath,
        "--worktree",
        repo,
        "--agent",
        "mimo-pro",
        "--brain-url",
        `http://127.0.0.1:${address.port}`,
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const parsed = JSON.parse(body) as { reasoning_effort?: string };
    expect(parsed.reasoning_effort).toBe("high");
  });

  it("lets built-in workers use CLI-only BYOK when Brain is offline", async () => {
    const repo = await makeTempGitRepo();
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: byok worker",
      "",
      "## Objective",
      "Answer through the configured CLI provider.",
      "",
      "## Owned files",
      "- cli/**",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      `- ${PASS_TEST_COMMAND}`,
    ].join("\n"));
    let body = "";
    let auth = "";
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        auth = String(req.headers.authorization || "");
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "BYOK worker done." } }] })}\n\ndata: [DONE]\n\n`);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runWorker(parseArgs([
        "worker",
        "run",
        "--brief",
        briefPath,
        "--worktree",
        repo,
        "--agent",
        "lynn-cli",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-worker-test",
        "--model",
        "worker-model",
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const parsed = JSON.parse(body) as { model?: string; messages?: Array<{ role: string; content?: unknown }> };
    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; summary?: string });
    expect(auth).toBe("Bearer sk-worker-test");
    expect(parsed.model).toBe("worker-model");
    expect(parsed.messages?.some((message) => message.role === "user" && String(message.content).includes("byok worker"))).toBe(true);
    expect(lines.some((line) => line.type === "worker.finished" && line.summary === "lynn-cli worker completed")).toBe(true);
  });

});
