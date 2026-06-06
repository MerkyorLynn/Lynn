import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import {
  applyModeCommand,
  applyReasoningCommand,
  applyThinkCommand,
  buildChatProviderArgs,
  chatRouteLabel,
  completeChatInput,
  formatChatError,
  isModeToggleKeypress,
  renderMode,
  renderOfflineChatHint,
  resolveChatMode,
  shouldRefreshProviderRoute,
  shouldShowProviderSetUsage,
  splitChatCommandLine,
  toggleMode,
} from "../src/commands/chat.js";
import { BrainConnectionError } from "../src/brain-client.js";
import { writeCliProviderProfile } from "../src/provider-profile.js";
import { setLang } from "../src/i18n.js";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const pythonIt = hasPython3() ? it : it.skip;
const ptyIt = process.platform === "win32" ? it.skip : pythonIt;
const interactivePtyIt = process.env.CI === "true" ? it.skip : ptyIt;

async function runInteractiveChatInput(
  inputText: string,
  options: { args?: string[]; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "src/cli.ts",
      ...(options.args || []),
      "--mock-brain",
    ], {
      cwd: cliRoot,
      env: { ...process.env, NO_COLOR: "1", LYNN_LANG: "en" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("interactive chat fixture did not exit"));
    }, options.timeoutMs || 5000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.write(inputText);
    child.stdin.end();
  });
}

beforeEach(() => setLang("en"));
afterEach(() => setLang(null));

describe("chat mode controls", () => {
  it("toggles between guarded and yolo modes", () => {
    const mode = { approval: "ask" as const, sandbox: "workspace-write" as const };

    expect(renderMode(mode)).toBe("ask / workspace-write");
    expect(applyModeCommand(mode, "yolo")).toBe("YOLO silent factory mode enabled.");
    expect(renderMode(mode)).toBe("yolo / full-access");
    expect(applyModeCommand(mode, "ask")).toBe("Guarded mode enabled.");
    expect(renderMode(mode)).toBe("ask / workspace-write");
  });

  it("supports the Shift+Tab hotkey shape used by terminals", () => {
    expect(isModeToggleKeypress({ sequence: "\u001b[Z" })).toBe(true);
    expect(isModeToggleKeypress({ name: "tab", shift: true })).toBe(true);
    expect(isModeToggleKeypress({ name: "tab" })).toBe(false);
  });

  it("toggles yolo mode with the hotkey action", () => {
    const mode = { approval: "ask" as const, sandbox: "workspace-write" as const };

    expect(toggleMode(mode)).toBe("YOLO silent factory mode enabled.");
    expect(renderMode(mode)).toBe("yolo / full-access");
    expect(toggleMode(mode)).toBe("Guarded mode enabled.");
    expect(renderMode(mode)).toBe("ask / workspace-write");
  });

  it("uses the shared CLI/client permission profile for chat startup mode", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-chat-perms-"));
    try {
      await fs.mkdir(path.join(dataDir, "permissions"), { recursive: true });
      await fs.writeFile(
        path.join(dataDir, "permissions", "cli.json"),
        JSON.stringify({ approval: "yolo", sandbox: "danger-full-access" }),
        "utf8",
      );

      const mode = await resolveChatMode(parseArgs(["chat", "--data-dir", dataDir]));

      expect(renderMode(mode)).toBe("yolo / full-access");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("localizes mode command receipts and danger warning", () => {
    setLang("zh");
    const mode = { approval: "ask" as const, sandbox: "workspace-write" as const };

    expect(applyModeCommand(mode, "yolo")).toContain("静默黑灯");
    expect(applyModeCommand(mode, "wat")).toContain("未知权限模式");
  });

  it("renders a short Brain recovery message for interactive chat", () => {
    const message = formatChatError(new BrainConnectionError("http://127.0.0.1:8790", new Error("fetch failed")));

    expect(message).toContain("local Brain is offline");
    expect(message).toContain("CLI-only BYOK");
    expect(message).not.toContain("For CLI-only smoke tests");
  });

  it("renders a one-shot offline hint for bare startup", () => {
    const hint = renderOfflineChatHint({ approval: "ask", sandbox: "workspace-write" }, "http://127.0.0.1:8790");

    expect(hint).toContain("local Brain offline");
    expect(hint).toContain("CLI-only BYOK");
    expect(hint).toContain("Lynn providers");
    expect(hint).toContain("--mock-brain");
  });

  it("renders CLI BYOK as usable when Brain is offline", () => {
    const hint = renderOfflineChatHint(
      { approval: "ask", sandbox: "workspace-write" },
      "http://127.0.0.1:8790",
      { provider: "openai-compatible", model: "deepseek-chat" },
    );

    expect(hint).toContain("using CLI BYOK provider directly");
    expect(hint).toContain("deepseek-chat");
  });

  it("surfaces CLI BYOK fallback in the chat startup route label", () => {
    expect(chatRouteLabel({ provider: "openai-compatible", model: "step-3.7-flash" })).toBe("CLI BYOK: StepFun 3.7 Flash (step-3.7-flash)");
    expect(chatRouteLabel(null)).toBe("StepFun 3.7 Flash → MiMo V2.5 Pro → Spark Qwen 3.6 35B A3B via Brain router (auto)");
  });

  it("renders CLI BYOK fallback in startup copy", () => {
    setLang("zh");
    const provider = { provider: "openai-compatible", model: "step-3.7-flash" };
    const hint = renderOfflineChatHint({ approval: "ask", sandbox: "workspace-write" }, "http://127.0.0.1:8790", provider);

    expect(chatRouteLabel(provider)).toContain("step-3.7-flash");
    expect(hint).toContain("step-3.7-flash");
  });

  it("updates reasoning mode for fast and deep MiMo turns", () => {
    const current = { effort: "auto" as const, display: "auto" as const };

    expect(applyReasoningCommand(current, "off").reasoning).toMatchObject({ effort: "off" });
    expect(applyReasoningCommand(current, "high").reasoning).toMatchObject({ effort: "high" });
    expect(applyReasoningCommand(current, "show").reasoning).toMatchObject({ display: "always" });
    expect(applyThinkCommand(current, "medium", "chat").reasoning).toMatchObject({ effort: "medium" });
  });

  it("localizes reasoning command receipts", () => {
    setLang("zh");
    const current = { effort: "auto" as const, display: "auto" as const };

    expect(applyReasoningCommand(current, "high").message).toContain("推理强度");
    expect(applyReasoningCommand(current, "show").message).toContain("始终");
  });

  it("offers slash completion in chat mode", () => {
    expect(completeChatInput("/prov")).toEqual([
      ["/providers", "/providers set", "/providers unset", "/providers test", "/providers presets"],
      "/prov",
    ]);
    expect(completeChatInput("/providers s")).toEqual([["/providers set"], "/providers s"]);
    expect(completeChatInput("/")).toMatchObject([
      expect.arrayContaining(["/help", "/mode", "/yolo", "/ask", "/providers", "/byok", "/setup"]),
      "/",
    ]);
    expect(completeChatInput("/yo")).toEqual([["/yolo"], "/yo"]);
    expect(completeChatInput("/as")).toEqual([["/ask"], "/as"]);
    expect(completeChatInput("/model s")).toEqual([["/model stepfun", "/model spark"], "/model s"]);
    expect(completeChatInput("hello")).toEqual([[], "hello"]);
  });

  it("keeps /tools for local tool inventory and /tool for recent tool details", async () => {
    const result = await runInteractiveChatInput("/tools\n/tool\n/exit\n");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("read_file:");
    expect(result.stdout).toContain("bash");
    expect(result.stdout).toContain("No tool details yet.");
  });

  it("splits chat provider commands with quoted values", () => {
    expect(splitChatCommandLine('/providers set --base-url "https://api.example.com/v1" --model "step-3.7-flash"')).toEqual([
      "/providers",
      "set",
      "--base-url",
      "https://api.example.com/v1",
      "--model",
      "step-3.7-flash",
    ]);
    expect(splitChatCommandLine("/providers set --api-key sk\\ test")).toEqual([
      "/providers",
      "set",
      "--api-key",
      "sk test",
    ]);
  });

  it("builds provider subcommands from chat without losing data-dir", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-chat-provider-"));
    try {
      const base = parseArgs(["chat", "--data-dir", dataDir]);
      const command = buildChatProviderArgs("/providers set --preset stepfun --api-key step-key", base);

      expect(command?.command).toBe("providers");
      expect(command?.positionals).toEqual(["set"]);
      expect(command?.flags["preset"]).toBe("stepfun");
      expect(command?.flags["api-key"]).toBe("step-key");
      expect(command?.flags["data-dir"]).toBe(dataDir);
      expect(shouldRefreshProviderRoute(command!)).toBe(true);
      expect(shouldShowProviderSetUsage(command!)).toBe(false);
      expect(shouldShowProviderSetUsage(buildChatProviderArgs("/providers set", base)!)).toBe(true);
      expect(shouldShowProviderSetUsage(buildChatProviderArgs("/providers set", base)!, true)).toBe(false);
      expect(shouldShowProviderSetUsage(buildChatProviderArgs("/byok set", base)!)).toBe(true);
      expect(shouldShowProviderSetUsage(buildChatProviderArgs("/byok set", base)!, true)).toBe(false);
      const setupCommand = buildChatProviderArgs("/setup --preset stepfun --api-key step-key", base);
      expect(setupCommand?.command).toBe("providers");
      expect(setupCommand?.positionals).toEqual(["set"]);
      expect(setupCommand?.flags["preset"]).toBe("stepfun");
      expect(setupCommand?.flags["api-key"]).toBe("step-key");
      expect(setupCommand?.flags["data-dir"]).toBe(dataDir);
      expect(shouldShowProviderSetUsage(buildChatProviderArgs("/setup", base)!)).toBe(true);
      expect(shouldShowProviderSetUsage(buildChatProviderArgs("/setup", base)!, true)).toBe(false);
      const modelPreset = buildChatProviderArgs("/model stepfun --api-key step-key", base);
      expect(modelPreset?.command).toBe("providers");
      expect(modelPreset?.positionals).toEqual(["set"]);
      expect(modelPreset?.flags["preset"]).toBe("stepfun");
      expect(modelPreset?.flags["api-key"]).toBe("step-key");
      const modelRaw = buildChatProviderArgs("/model step-3.7-flash --base-url https://api.stepfun.com/step_plan/v1 --api-key step-key", base);
      expect(modelRaw?.positionals).toEqual(["set"]);
      expect(modelRaw?.flags["model"]).toBe("step-3.7-flash");
      expect(modelRaw?.flags["base-url"]).toBe("https://api.stepfun.com/step_plan/v1");
      expect(buildChatProviderArgs("/model", base)).toBeNull();
      expect(buildChatProviderArgs("/providers wat", base)).toBeNull();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("treats --cwd as an implicit chat flag and uses it for /cwd", async () => {
    const targetCwd = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-chat-cwd-"));
    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [
          "--import",
          "tsx",
          "src/cli.ts",
          "--cwd",
          targetCwd,
          "--mock-brain",
        ], {
          cwd: cliRoot,
          env: { ...process.env, NO_COLOR: "1", LYNN_LANG: "en" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("implicit chat did not exit"));
        }, 5000);
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
        child.stdin.write("/cwd\n/exit\n");
        child.stdin.end();
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(targetCwd);
      expect(result.stdout).not.toContain("Usage:");
    } finally {
      await fs.rm(targetCwd, { recursive: true, force: true });
    }
  });

  it("handles exact local exit phrases without sending them to the model", async () => {
    const english = await runInteractiveChatInput("exit\n");
    const chinese = await runInteractiveChatInput("再见\n");

    expect(english.code).toBe(0);
    expect(chinese.code).toBe(0);
    expect(english.stdout).not.toContain("Mock Lynn response");
    expect(chinese.stdout).not.toContain("Mock Lynn response");
    expect(english.stdout).not.toContain("模拟回复");
    expect(chinese.stdout).not.toContain("模拟回复");
  });

  it("runs local pwd and ls shortcuts without yolo or model fallback", async () => {
    const targetCwd = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-chat-local-ls-"));
    try {
      await fs.writeFile(path.join(targetCwd, "alpha.txt"), "alpha", "utf8");
      await fs.mkdir(path.join(targetCwd, "subdir"));

      const result = await runInteractiveChatInput("pwd\nls\n/exit\n", {
        args: ["--cwd", targetCwd],
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("local pwd");
      expect(result.stdout).toContain(targetCwd);
      expect(result.stdout).toContain("local ls");
      expect(result.stdout).toContain("alpha.txt");
      expect(result.stdout).toContain("subdir/");
      expect(result.stdout).not.toContain("Mock Lynn response:pwd");
      expect(result.stdout).not.toContain("Mock Lynn response:ls");
      expect(result.stdout).not.toContain("模拟回复:pwd");
      expect(result.stdout).not.toContain("模拟回复:ls");
    } finally {
      await fs.rm(targetCwd, { recursive: true, force: true });
    }
  });

  it("runs interactive chat through CLI BYOK when Brain is offline", async () => {
    let requestBody = "";
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-chat-test");
      request.on("data", (chunk) => {
        requestBody += String(chunk);
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"chat byok ok\"}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":3,\"total_tokens\":6}}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
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
        "chat",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-chat-test",
        "--model",
        "chat-model",
      ], {
        cwd: cliRoot,
        env: { ...process.env, NO_COLOR: "1", LYNN_LANG: "en" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("interactive chat did not exit"));
      }, 5000);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.write("hi\n/exit\n");
      child.stdin.end();
    });
    await new Promise<void>((resolve) => provider.close(() => resolve()));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("chat byok ok");
    expect(result.stderr).toContain("│ • route: cli-byok:openai-compatible");
    expect(result.stderr).toContain("│   fallback: brain(offline) ->");
    expect(result.stderr).toContain("6 tokens");
    expect(JSON.parse(requestBody)).toMatchObject({
      model: "chat-model",
      stream: true,
    });
    const parsed = JSON.parse(requestBody) as { messages?: Array<{ role?: string; content?: unknown }> };
    expect(parsed.messages?.[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Current model route shown to the user: CLI BYOK: chat-model"),
    });
    expect(parsed.messages?.at(-1)).toMatchObject({ role: "user", content: "hi" });
  });

  it("lets ordinary chat execute safe local tools and feed exact results back to the model", async () => {
    const targetCwd = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-chat-tool-loop-"));
    const requestBodies: unknown[] = [];
    let requests = 0;
    await fs.writeFile(path.join(targetCwd, "alpha.txt"), "alpha", "utf8");

    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-chat-tool");
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        requests += 1;
        requestBodies.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (requests === 1) {
          response.end([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_ls","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}',
            "",
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"));
          return;
        }

        response.end([
          'data: {"choices":[{"delta":{"content":"I saw alpha.txt from the local tool result."}}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [
          "--import",
          "tsx",
          "src/cli.ts",
          "chat",
          "--cwd",
          targetCwd,
          "--brain-url",
          "http://127.0.0.1:1",
          "--base-url",
          `http://127.0.0.1:${address.port}/v1`,
          "--api-key",
          "sk-chat-tool",
          "--model",
          "chat-tool-model",
        ], {
          cwd: cliRoot,
          env: { ...process.env, NO_COLOR: "1", LYNN_LANG: "en" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("interactive chat tool loop did not exit"));
        }, 8000);
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
        child.stdin.write("list the files with a local tool\n/exit\n");
        child.stdin.end();
      });

      expect(result.code).toBe(0);
      expect(requests).toBe(2);
      expect(result.stdout).toContain("I saw alpha.txt");
      expect(result.stderr).toContain("bash");
      expect(result.stderr).toContain("done");

      const first = requestBodies[0] as { tools?: unknown[]; tool_choice?: string; messages?: Array<{ role?: string; content?: unknown }> };
      expect(first.tool_choice).toBe("auto");
      expect(first.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "bash" }) }),
      ]));
      expect(first.messages?.at(-1)).toMatchObject({ role: "user", content: "list the files with a local tool" });

      const second = requestBodies[1] as { messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string; tool_calls?: unknown[] }> };
      const toolMessage = second.messages?.find((message) => message.role === "tool");
      expect(toolMessage).toMatchObject({ tool_call_id: "call_ls" });
      expect(String(toolMessage?.content)).toContain("alpha.txt");
      expect(second.messages?.some((message) => message.role === "assistant" && Array.isArray(message.tool_calls))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await fs.rm(targetCwd, { recursive: true, force: true });
    }
  });

  it("retries an interactive chat turn once when Brain returns an empty visible answer", async () => {
    let requests = 0;
    const provider = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (requests === 1) {
          response.end(["data: {\"choices\":[{\"delta\":{}}]}", "", "data: [DONE]", ""].join("\n"));
          return;
        }
        response.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"retried ok\"}}]}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
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
        "chat",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-chat-test",
        "--model",
        "chat-model",
      ], {
        cwd: cliRoot,
        env: { ...process.env, NO_COLOR: "1", LYNN_LANG: "en" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("interactive chat retry did not exit"));
      }, 5000);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.write("hi\n/exit\n");
      child.stdin.end();
    });
    await new Promise<void>((resolve) => provider.close(() => resolve()));

    expect(result.code).toBe(0);
    expect(requests).toBe(2);
    expect(result.stdout).toContain("retrying once automatically");
    expect(result.stdout).toContain("retried ok");
  });

  ptyIt("lets bare Lynn use CLI BYOK in a TTY when Brain is offline", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-bare-chat-byok-"));
    let requestBody = "";
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-bare-chat");
      request.on("data", (chunk) => {
        requestBody += String(chunk);
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"bare byok ok\"}}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    await writeCliProviderProfile(dataDir, {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "sk-bare-chat",
      model: "bare-model",
    });

    const script = `
import os
import pty
import select
import subprocess
import sys
import time

node_bin, cwd, data_dir = sys.argv[1], sys.argv[2], sys.argv[3]
master, slave = pty.openpty()
env = os.environ.copy()
env["NO_COLOR"] = "1"
env["LYNN_LANG"] = "en"
env["LYNN_DATA_DIR"] = data_dir
env["LYNN_BRAIN_URL"] = "http://127.0.0.1:1"
env["LYNN_CLI_LEGACY_TUI"] = "1"
proc = subprocess.Popen(
    [node_bin, "--import", "tsx", "src/cli.ts"],
    cwd=cwd,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env=env,
    close_fds=True,
)
os.close(slave)
buf = b""
sent_prompt = False
sent_exit = False
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
        if (not sent_prompt) and ("using CLI BYOK provider directly" in text) and (">" in text or "\\u203a" in text):
            os.write(master, b"hi\\r")
            sent_prompt = True
        elif sent_prompt and (not sent_exit) and "bare byok ok" in text and (">" in text or "\\u203a" in text):
            os.write(master, b"/exit\\r")
            sent_exit = True
    if sent_exit and proc.poll() is not None:
        break
if proc.poll() is None:
    proc.terminate()
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
sys.stdout.write(buf.decode("utf-8", errors="replace"))
sys.exit(proc.returncode if proc.returncode is not None else 124)
`;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("python3", ["-c", script, process.execPath, cliRoot, dataDir], {
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
    expect(result.stdout).toContain("CLI BYOK fallback");
    expect(result.stdout).toContain("using CLI BYOK provider directly");
    expect(result.stdout).toContain("bare byok ok");
    expect(result.stdout).not.toContain("sk-bare-chat");
    expect(JSON.parse(requestBody)).toMatchObject({
      model: "bare-model",
      stream: true,
    });
    const parsed = JSON.parse(requestBody) as { messages?: Array<{ role?: string; content?: unknown }> };
    expect(parsed.messages?.[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Current model route shown to the user: CLI BYOK: bare-model"),
    });
    expect(parsed.messages?.at(-1)).toMatchObject({ role: "user", content: "hi" });
  });

  ptyIt("keeps bare Lynn in a TTY REPL when Brain is offline", async () => {
    const script = `
import os
import pty
import select
import subprocess
import sys
import time

node_bin, cwd = sys.argv[1], sys.argv[2]
master, slave = pty.openpty()
env = os.environ.copy()
env["NO_COLOR"] = "1"
env["LYNN_LANG"] = "en"
env["LYNN_BRAIN_URL"] = "http://127.0.0.1:1"
env["LYNN_CLI_LEGACY_TUI"] = "1"
proc = subprocess.Popen(
    [node_bin, "--import", "tsx", "src/cli.ts"],
    cwd=cwd,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env=env,
    close_fds=True,
)
os.close(slave)
buf = b""
sent_exit = False
deadline = time.time() + 30
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
        if (not sent_exit) and (">" in text or "\\u203a" in text) and "local Brain offline" in text:
            os.write(master, b"/exit\\r")
            sent_exit = True
    if sent_exit and proc.poll() is not None:
        break
if proc.poll() is None:
    proc.terminate()
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
sys.stdout.write(buf.decode("utf-8", errors="replace"))
sys.exit(proc.returncode if proc.returncode is not None else 124)
`;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("python3", ["-c", script, process.execPath, cliRoot], {
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

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Lynn CLI");
    expect(result.stdout).toContain("local Brain offline");
    expect(result.stdout).toContain("›");
    expect(result.stdout).not.toContain("Aborted with Ctrl+D");
    expect(result.stderr).toBe("");
  }, 45_000);

  interactivePtyIt("uses the Ink TUI for bare Lynn in a TTY", async () => {
    const script = `
import os
import pty
import select
import subprocess
import sys
import time

node_bin, cwd = sys.argv[1], sys.argv[2]
master, slave = pty.openpty()
env = os.environ.copy()
env["NO_COLOR"] = "1"
env["LYNN_LANG"] = "en"
env["LYNN_BRAIN_URL"] = "http://127.0.0.1:1"
proc = subprocess.Popen(
    [node_bin, "--import", "tsx", "src/cli.ts"],
    cwd=cwd,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env=env,
    close_fds=True,
)
os.close(slave)
buf = b""
sent_exit = False
deadline = time.time() + 45
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
        if (not sent_exit) and "Lynn CLI" in text:
            os.write(master, b"/exit\\r")
            sent_exit = True
    if sent_exit and proc.poll() is not None:
        break
if proc.poll() is None:
    proc.terminate()
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
sys.stdout.write(buf.decode("utf-8", errors="replace"))
sys.exit(proc.returncode if proc.returncode is not None else 124)
`;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("python3", ["-c", script, process.execPath, cliRoot], {
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

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Lynn CLI");
    expect(result.stdout).toContain("StepFun 3.7 Flash");
    expect(result.stderr).toBe("");
  }, 75_000);
});

function hasPython3(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
