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

describe("worker-run · run, diff & gate", () => {
  it("collects git diff summaries from a worktree", async () => {
    const repo = await makeTempGitRepo();
    await fs.writeFile(path.join(repo, "added.txt"), "hello\nworld\n");
    await execFileAsync("git", ["add", "added.txt"], { cwd: repo });

    const diff = await collectGitDiff(repo);

    expect(diff.files).toBe(1);
    expect(diff.insertions).toBe(2);
    expect(diff.deletions).toBe(0);
    expect(diff.changedFiles).toEqual([
      { path: "added.txt", action: "add", insertions: 2, deletions: 0 },
    ]);
  });

  it("wraps external worker output as fleet progress", async () => {
    const repo = await makeTempGitRepo();
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: external output",
      "",
      "## Objective",
      "Emit output.",
      "",
      "## Owned files",
      "- worker-output.txt",
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
        "custom",
        "--agent-command",
        "node -e \"console.log('external hello')\"",
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; message?: string });
    expect(lines.some((line) => line.type === "shell.started")).toBe(true);
    expect(lines.some((line) => line.type === "worker.progress" && line.message === "external hello")).toBe(true);
    expect(lines.at(-1)?.type).toBe("worker.finished");
  });

  it("wraps external worker stream-json as assistant deltas", async () => {
    const repo = await makeTempGitRepo();
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: external json",
      "",
      "## Objective",
      "Emit JSON.",
      "",
      "## Owned files",
      "- worker-output.txt",
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
        "custom",
        "--agent-command",
        "node -e \"console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'external answer'}]}}))\"",
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; text?: string });
    expect(lines.some((line) => line.type === "assistant.delta" && line.text === "external answer")).toBe(true);
  });

  it("emits real git diff after an external worker changes files", async () => {
    const repo = await makeTempGitRepo();
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: write file",
      "",
      "## Objective",
      "Write a file.",
      "",
      "## Owned files",
      "- worker-output.txt",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      `- ${PASS_TEST_COMMAND}`,
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
        "custom",
        "--agent-command",
        "node -e \"require('fs').writeFileSync('worker-output.txt','hello')\"",
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; changedFiles?: Array<{ path: string; action: string; insertions?: number; deletions?: number }> });
    const diff = lines.find((line) => line.type === "git.diff");
    expect(diff?.changedFiles).toEqual([
      { path: "worker-output.txt", action: "add", insertions: 1, deletions: 0 },
    ]);
  });

  it("blocks real workers that change forbidden files", async () => {
    const repo = await makeTempGitRepo();
    await fs.mkdir(path.join(repo, "server"), { recursive: true });
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: stay in scope",
      "",
      "## Objective",
      "Do not touch server files.",
      "",
      "## Owned files",
      "- worker-output.txt",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      `- ${PASS_TEST_COMMAND}`,
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
        "custom",
        "--agent-command",
        "node -e \"require('fs').writeFileSync('server/secret.txt','bad')\"",
      ]));
      expect(code).toBe(1);
    } finally {
      process.stdout.write = original;
    }

    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      type: string;
      code?: string;
      path?: string;
      ok?: boolean;
      changedFiles?: Array<{ path: string; forbidden?: boolean }>;
    });
    expect(lines).toContainEqual(expect.objectContaining({ type: "worker.violation", code: "forbidden_file", path: "server/" }));
    expect(lines.find((line) => line.type === "git.diff")?.changedFiles).toContainEqual(expect.objectContaining({ path: "server/", forbidden: true }));
    expect(lines.at(-1)).toMatchObject({ type: "worker.finished", ok: false });
  });

  it("runs real worker test commands and fails the gate on test failure", async () => {
    const repo = await makeTempGitRepo();
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: failing test",
      "",
      "## Objective",
      "Run the failing test.",
      "",
      "## Owned files",
      "- worker-output.txt",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      "- node -e \"console.log('token=supersecretvalue123456'); console.log('line-a'); process.exit(3)\"",
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
        "custom",
        "--agent-command",
        "node -e \"require('fs').writeFileSync('worker-output.txt','hello')\"",
      ]));
      expect(code).toBe(1);
    } finally {
      process.stdout.write = original;
    }

    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      type: string;
      ok?: boolean;
      command?: string;
      summary?: string;
      data?: { output?: string; truncated?: boolean };
    });
    expect(lines).toContainEqual(expect.objectContaining({ type: "test.started", command: "node -e \"console.log('token=supersecretvalue123456'); console.log('line-a'); process.exit(3)\"" }));
    expect(lines).toContainEqual(expect.objectContaining({ type: "test.finished", ok: false }));
    const finished = lines.find((line) => line.type === "test.finished");
    expect(finished?.data?.output).toContain("token=[REDACTED]");
    expect(finished?.data?.output).toContain("line-a");
    expect(finished?.data?.output).not.toContain("supersecretvalue123456");
    expect(lines).toContainEqual(expect.objectContaining({ type: "gate.finished", ok: false }));
    expect(lines.at(-1)).toMatchObject({ type: "worker.finished", ok: false });
  });

  it("runs the built-in lynn-cli worker through the Brain-backed code loop", async () => {
    const repo = await makeTempGitRepo();
    await fs.writeFile(path.join(repo, "hello.txt"), "hello\n", "utf8");
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: patch file",
      "",
      "## Objective",
      "Change hello to lynn.",
      "",
      "## Owned files",
      "- hello.txt",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      `- ${PASS_TEST_COMMAND}`,
    ].join("\n"));
    const patch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-hello",
      "+lynn",
      "",
    ].join("\n");
    let calls = 0;
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        req.resume();
        calls += 1;
        const content = calls === 1
          ? JSON.stringify({ tool: "apply_patch", args: { patch } })
          : "Patched hello.txt.";
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
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
        `http://127.0.0.1:${address.port}`,
        "--approval",
        "yolo",
        "--max-steps",
        "3",
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const text = await fs.readFile(path.join(repo, "hello.txt"), "utf8");
    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; tool?: string; summary?: string; path?: string });
    expect(text).toContain("lynn");
    expect(lines.some((line) => line.type === "shell.started")).toBe(true);
    expect(lines.some((line) => line.type === "session.checkpoint")).toBe(true);
    expect(lines.some((line) => line.type === "session.saved" && line.path)).toBe(true);
    expect(lines.some((line) => line.type === "worker.finished" && line.summary === "lynn-cli worker completed")).toBe(true);
  });

  it("runs answer-only built-in workers without exposing local tools", async () => {
    const repo = await makeTempGitRepo();
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: worker smoke",
      "",
      "## Objective",
      "Reply exactly `worker ok` and finish. Do not inspect files and do not run tools.",
      "",
      "## Owned files",
      "- cli/**",
      "",
      "## Forbidden files",
      "- server/**",
    ].join("\n"));
    let requestBody = "";
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        req.on("data", (chunk) => { requestBody += String(chunk); });
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "worker ok" } }] })}\n\ndata: [DONE]\n\n`);
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
        `http://127.0.0.1:${address.port}`,
        "--approval",
        "yolo",
        "--max-steps",
        "3",
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const parsedBody = JSON.parse(requestBody) as { tools?: unknown; messages?: Array<{ content?: unknown }> };
    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; command?: string; text?: string; summary?: string });
    expect(parsedBody.tools).toBeUndefined();
    expect(JSON.stringify(parsedBody.messages)).toContain("Do not inspect files. Do not call tools. Do not run commands.");
    expect(lines.some((line) => line.type === "shell.started" && line.command === "Lynn answer")).toBe(true);
    expect(lines.some((line) => line.type === "assistant.delta" && line.text === "worker ok")).toBe(true);
    expect(lines.some((line) => line.type === "worker.finished" && line.summary === "lynn-cli worker completed")).toBe(true);
  });

  it("routes ui2code briefs through the code loop with attached images", async () => {
    const repo = await makeTempGitRepo();
    await fs.writeFile(path.join(repo, "hello.txt"), "hello\n", "utf8");
    await fs.writeFile(path.join(repo, "shot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    await execFileAsync("git", ["add", "hello.txt", "shot.png"], { cwd: repo });
    await execFileAsync("git", ["-c", "user.name=Lynn Test", "-c", "user.email=lynn@example.test", "commit", "-m", "seed"], { cwd: repo });
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: implement screenshot",
      "",
      "## Task Type",
      "ui2code",
      "",
      "## Image",
      "shot.png",
      "",
      "## Objective",
      "Use the screenshot to update hello.txt.",
      "",
      "## Owned files",
      "- hello.txt",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      `- ${PASS_TEST_COMMAND}`,
    ].join("\n"));
    const patch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-hello",
      "+ui2code",
      "",
    ].join("\n");
    let calls = 0;
    let firstBody = "";
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => { body += String(chunk); });
        req.on("end", () => {
          calls += 1;
          if (calls === 1) firstBody = body;
          const content = calls === 1
            ? JSON.stringify({ tool: "apply_patch", args: { patch } })
            : "Implemented the screenshot change.";
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
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
        `http://127.0.0.1:${address.port}`,
        "--approval",
        "yolo",
        "--max-steps",
        "3",
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const text = await fs.readFile(path.join(repo, "hello.txt"), "utf8");
    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      type: string;
      summary?: string;
      changedFiles?: Array<{ path: string; action?: string; insertions?: number }>;
    });
    expect(firstBody).toContain("data:image/png;base64");
    expect(firstBody).toContain("Use the screenshot to update hello.txt.");
    expect(text).toContain("ui2code");
    expect(lines.some((line) => (
      line.type === "git.diff"
      && line.changedFiles?.some((file) => file.path === "hello.txt" && file.action === "edit")
    ))).toBe(true);
    expect(lines.some((line) => line.type === "worker.finished" && line.summary === "lynn-cli worker completed")).toBe(true);
  });

  it("runs vision workers through the Brain multimodal path", async () => {
    const repo = await makeTempGitRepo();
    await fs.writeFile(path.join(repo, "shot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: ground screenshot",
      "",
      "## Task Type",
      "ground",
      "",
      "## Image",
      "shot.png",
      "",
      "## Objective",
      "Find the submit button.",
      "",
      "## Owned files",
      "- desktop/src/react/**",
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
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "{\"x\":0.5,\"y\":0.5,\"confidence\":0.9}" } }] })}\n\ndata: [DONE]\n\n`);
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
        `http://127.0.0.1:${address.port}`,
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(body).toContain("data:image/png;base64");
    expect(body).toContain("Find the submit button");
    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      type: string;
      agent?: string;
      text?: string;
      summary?: string;
      taskType?: string;
      image?: string;
      boxes?: Array<{ x: number; y: number; confidence?: number }>;
    });
    expect(lines.some((line) => line.type === "worker.started" && line.agent === "lynn-cli")).toBe(true);
    expect(lines.some((line) => line.type === "assistant.delta" && line.text?.includes("\"x\""))).toBe(true);
    expect(lines.some((line) => (
      line.type === "worker.visual_result"
      && line.taskType === "ground"
      && line.image === "shot.png"
      && line.summary?.includes("\"confidence\"")
      && line.boxes?.[0]?.x === 0.5
      && line.boxes?.[0]?.confidence === 0.9
    ))).toBe(true);
    expect(lines.some((line) => line.type === "worker.finished" && line.summary === "lynn-cli worker completed")).toBe(true);
  });

  it("emits mock visual results for visual briefs", async () => {
    const repo = await makeTempGitRepo();
    const briefPath = path.join(repo, "brief.md");
    await fs.writeFile(briefPath, [
      "# Task: describe screenshot",
      "",
      "## Task Type",
      "see",
      "",
      "## Image",
      "shot.png",
      "",
      "## Objective",
      "Describe the screen.",
      "",
      "## Owned files",
      "- desktop/src/react/**",
      "",
      "## Forbidden files",
      "- server/**",
      "",
      "## Test commands",
      "- npm test",
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
        "lynn-cli",
        "--mock",
      ]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; taskType?: string; image?: string; summary?: string });
    expect(lines.some((line) => (
      line.type === "worker.visual_result"
      && line.taskType === "see"
      && line.image === "shot.png"
      && line.summary === "mock see result for shot.png"
    ))).toBe(true);
  });
});
