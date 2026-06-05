import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { maxSteps, runCode, runCodeTaskWithEvents, type CodeAgentEvent } from "../src/commands/code.js";
import { compactRuntimeMessages } from "../src/code-agent-loop.js";
import { appendSessionTurn, readSessionLines, sessionIndexPath } from "../src/session/store.js";

let tmp = "";
const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const pythonIt = hasPython3() ? it : it.skip;
const ptyIt = process.platform === "win32" ? it.skip : pythonIt;
const interactivePtyIt = process.env.CI === "true" ? it.skip : ptyIt;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-agent-"));
  await fs.writeFile(path.join(tmp, "hello.txt"), "hello\n", "utf8");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function sse(content: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

function rawSsePayloads(payloads: string[]): string {
  return [
    ...payloads.flatMap((payload) => [`data: ${payload}`, ""]),
    "data: [DONE]",
    "",
  ].join("\n");
}

function hasPython3(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function withBrainServer(handler: (body: unknown, count: number) => string, run: (url: string) => Promise<void>): Promise<void> {
  let count = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += String(chunk); });
      req.on("end", () => {
        count += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse(handler(JSON.parse(raw), count)));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server failed to bind");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withRawBrainServer(handler: (body: unknown, count: number) => string, run: (url: string) => Promise<void>): Promise<void> {
  let count = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += String(chunk); });
      req.on("end", () => {
        count += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(handler(JSON.parse(raw), count));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server failed to bind");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("code agent loop · multimodal & BYOK subprocess", () => {
  it("sends attached images through code mode for multimodal tasks", async () => {
    const image = path.join(tmp, "shot.png");
    await fs.writeFile(image, Buffer.from("89504e470d0a1a0a", "hex"));
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((body) => {
        const parsed = body as { messages?: Array<{ content?: unknown }> };
        const firstUser = parsed.messages?.find((message) => Array.isArray(message.content));
        expect(firstUser).toBeTruthy();
        expect(JSON.stringify(firstUser?.content)).toContain("data:image/png;base64");
        return "Reviewed the screenshot.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "review this UI",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--image",
          image,
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("Reviewed the screenshot");
  });

  it("sends pasted media paths through headless code mode", async () => {
    const image = path.join(tmp, "pasted-shot.png");
    await fs.writeFile(image, Buffer.from("89504e470d0a1a0a", "hex"));
    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await withBrainServer((body) => {
        const parsed = body as { messages?: Array<{ content?: unknown }> };
        const firstUser = parsed.messages?.find((message) => Array.isArray(message.content));
        const content = Array.isArray(firstUser?.content) ? firstUser.content : [];
        expect(JSON.stringify(content)).toContain("data:image/png;base64");
        expect(JSON.stringify(content)).toContain("Attached images:");
        expect(JSON.stringify(content)).not.toContain("review this UI ./pasted-shot.png");
        return "Reviewed pasted screenshot.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "-p",
          "review this UI ./pasted-shot.png",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }
  });

  it("sends multiple attached images through code mode", async () => {
    const first = path.join(tmp, "first.png");
    const second = path.join(tmp, "second.png");
    await fs.writeFile(first, Buffer.from("89504e470d0a1a0a", "hex"));
    await fs.writeFile(second, Buffer.from("89504e470d0a1a0a", "hex"));
    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await withBrainServer((body) => {
        const parsed = body as { messages?: Array<{ content?: unknown }> };
        const firstUser = parsed.messages?.find((message) => Array.isArray(message.content));
        const content = Array.isArray(firstUser?.content) ? firstUser.content : [];
        expect(content.filter((part) => (part as { type?: string }).type === "image_url")).toHaveLength(2);
        expect(JSON.stringify(content)).toContain("Attached images:");
        return "Compared both screenshots.";
      }, async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "compare these UIs",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--images",
          `${first},${second}`,
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }
  });

  it("passes code --image through CLI BYOK in a real subprocess", async () => {
    const image = path.join(tmp, "subprocess-shot.png");
    await fs.writeFile(image, Buffer.from("89504e470d0a1a0a", "hex"));
    let requestBody = "";
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-code-image");
      request.on("data", (chunk) => { requestBody += String(chunk); });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse("Reviewed BYOK screenshot."));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        "src/cli.ts",
        "code",
        "review this screenshot",
        "--cwd",
        tmp,
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-code-image",
        "--model",
        "code-image-model",
        "--image",
        image,
        "--max-steps",
        "1",
        "--json",
      ], {
        cwd: cliRoot,
        env: { ...process.env, NO_COLOR: "1", LYNN_LANG: "en" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("code image subprocess did not exit"));
      }, 8000);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    await new Promise<void>((resolve) => provider.close(() => resolve()));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"activeProvider":"cli-byok:openai-compatible"');
    expect(result.stdout).toContain("Reviewed BYOK screenshot.");
    const parsed = JSON.parse(requestBody) as { model?: string; messages?: Array<{ role?: string; content?: unknown }> };
    expect(parsed.model).toBe("code-image-model");
    const multimodalUser = parsed.messages?.find((message) => Array.isArray(message.content));
    expect(multimodalUser).toBeTruthy();
    const serialized = JSON.stringify(multimodalUser?.content);
    expect(serialized).toContain("Attached images:");
    expect(serialized).toContain("data:image/png;base64");
  });

  it("runs code mode through CLI BYOK when local Brain is offline", async () => {
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-code-test");
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { model?: string; stream?: boolean; messages?: Array<{ role?: string; content?: unknown }> };
        expect(parsed.model).toBe("code-model");
        expect(parsed.stream).toBe(true);
        expect(JSON.stringify(parsed.messages)).toContain("summarize hello");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse("BYOK code route answered."));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runCode(parseArgs([
        "code",
        "summarize hello",
        "--cwd",
        tmp,
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-code-test",
        "--model",
        "code-model",
        "--max-steps",
        "1",
        "--json",
      ]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }

    expect(output).toContain("BYOK code route answered");
  });

  it("runs a real CLI BYOK code subprocess through apply_patch and bash", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-hello",
      "+lynn",
      "*** End Patch",
      "",
    ].join("\n");
    const command = "python3 -c \"import pathlib; assert pathlib.Path('hello.txt').read_text().strip() == 'lynn'\"";
    const requestBodies: unknown[] = [];
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-subprocess-code");
      let raw = "";
      request.on("data", (chunk) => { raw += String(chunk); });
      request.on("end", () => {
        const count = requestBodies.push(JSON.parse(raw));
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (count === 1) {
          response.end(rawSsePayloads([
            JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_patch",
                    type: "function",
                    function: { name: "apply_patch", arguments: JSON.stringify({ text: patch }) },
                  }],
                },
              }],
            }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ]));
          return;
        }
        if (count === 2) {
          response.end(rawSsePayloads([
            JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_test",
                    type: "function",
                    function: { name: "bash", arguments: JSON.stringify({ command }) },
                  }],
                },
              }],
            }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ]));
          return;
        }
        response.end(sse("Patched hello.txt and verified the result."));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        "src/cli.ts",
        "code",
        "change hello.txt to lynn and verify it",
        "--cwd",
        tmp,
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-subprocess-code",
        "--model",
        "code-subprocess-model",
        "--approval",
        "yolo",
        "--sandbox",
        "workspace-write",
        "--max-steps",
        "5",
        "--json",
      ], {
        cwd: cliRoot,
        env: { ...process.env, NO_COLOR: "1", LYNN_LANG: "en" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("code subprocess did not exit"));
      }, 8000);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    await new Promise<void>((resolve) => provider.close(() => resolve()));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"activeProvider":"cli-byok:openai-compatible"');
    expect(result.stdout).toContain('"fallbackFrom":[{"id":"brain","reason":"offline"}]');
    expect(result.stdout).toContain('"tool":"apply_patch"');
    expect(result.stdout).toContain('"tool":"bash"');
    expect(result.stdout).toContain("Patched hello.txt and verified the result.");
    expect(result.stdout).toContain('"type":"code.task.finished"');
    expect(result.stdout).toContain('"ok":true');
    await expect(fs.readFile(path.join(tmp, "hello.txt"), "utf8")).resolves.toBe("lynn\n");
    expect(JSON.stringify(requestBodies[1])).toContain('"role":"tool"');
    expect(JSON.stringify(requestBodies[2])).toContain('"role":"tool"');
  });

  ptyIt("runs multiple dangerous tools after interactive allow-all approval", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-hello",
      "+approved",
      "*** End Patch",
      "",
    ].join("\n");
    const command = "python3 -c \"import pathlib; assert pathlib.Path('hello.txt').read_text().strip() == 'approved'\"";
    const requestBodies: unknown[] = [];
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-approval-test");
      let raw = "";
      request.on("data", (chunk) => { raw += String(chunk); });
      request.on("end", () => {
        const count = requestBodies.push(JSON.parse(raw));
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (count === 1) {
          response.end(rawSsePayloads([
            JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_patch",
                    type: "function",
                    function: { name: "apply_patch", arguments: JSON.stringify({ text: patch }) },
                  }],
                },
              }],
            }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ]));
          return;
        }
        if (count === 2) {
          response.end(rawSsePayloads([
            JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_test",
                    type: "function",
                    function: { name: "bash", arguments: JSON.stringify({ command }) },
                  }],
                },
              }],
            }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ]));
          return;
        }
        response.end(sse("Interactive allow-all approval applied and verified the patch."));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const script = `
import os
import pty
import select
import subprocess
import sys
import time

node_bin, cwd, workspace, provider_url = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
master, slave = pty.openpty()
env = os.environ.copy()
env["NO_COLOR"] = "1"
env["LYNN_LANG"] = "en"
proc = subprocess.Popen(
    [
        node_bin,
        "--import",
        "tsx",
        "src/cli.ts",
        "code",
        "change hello.txt to approved",
        "--cwd",
        workspace,
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        provider_url,
        "--api-key",
        "sk-approval-test",
        "--model",
        "approval-model",
        "--approval",
        "ask",
        "--sandbox",
        "workspace-write",
        "--max-steps",
        "3",
    ],
    cwd=cwd,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env=env,
    close_fds=True,
)
os.close(slave)
buf = b""
approved = False
deadline = time.time() + 10
while time.time() < deadline:
    readable, _, _ = select.select([master], [], [], 0.1)
    if readable:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        text = buf.decode("utf-8", errors="replace")
        if (not approved) and ("Choose [y/a/n]" in text or "Approval required: apply_patch" in text):
            os.write(master, b"a\\r")
            approved = True
    if proc.poll() is not None:
        break
if proc.poll() is None:
    proc.terminate()
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
text = buf.decode("utf-8", errors="replace")
if not approved:
    sys.stderr.write("approval prompt was not observed\\n")
sys.stdout.write(text)
sys.exit(proc.returncode if proc.returncode is not None else 124)
`;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("python3", [
        "-c",
        script,
        process.execPath,
        cliRoot,
        tmp,
        `http://127.0.0.1:${address.port}/v1`,
      ], {
        cwd: cliRoot,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    await new Promise<void>((resolve) => provider.close(() => resolve()));

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Approval required: apply_patch");
    expect(result.stdout).toContain("Choose [y/a/n]");
    expect(result.stdout).toContain("Interactive allow-all approval applied and verified the patch.");
    expect((result.stdout.match(/Choose \[y\/a\/n\]/g) || [])).toHaveLength(1);
    await expect(fs.readFile(path.join(tmp, "hello.txt"), "utf8")).resolves.toBe("approved\n");
    expect(JSON.stringify(requestBodies[1])).toContain('"role":"tool"');
    expect(JSON.stringify(requestBodies[2])).toContain('"role":"tool"');
  });

});
