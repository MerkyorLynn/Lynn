import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/args.js";
import { activeRouteLabel, renderProviderPresets, renderProvidersInfo, runProviders } from "../src/commands/providers.js";
import { providerProfilePath, readCliProviderProfile, readEnvProviderProfile, resolveCliProviderProfile, writeCliProviderProfile } from "../src/provider-profile.js";
import { setLang } from "../src/i18n.js";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const pythonIt = hasPython3() ? it : it.skip;
const ptyIt = process.platform === "win32" ? it.skip : pythonIt;

beforeEach(() => setLang("en"));
afterEach(() => setLang(null));

describe("providers command", () => {
  it("renders BYOK guidance without exposing keys", () => {
    const output = renderProvidersInfo({
      defaultRoute: "StepFun 3.7 Flash → Spark Qwen 3.6 35B A3B via local Brain router (auto)",
      byokEntry: "Open Lynn GUI > Settings > Providers",
      keyPolicy: "Provider keys stay private.",
      brainUrl: "http://127.0.0.1:8790",
      server: { status: "ok", url: "http://127.0.0.1:3000" },
      activeProvider: "openai",
      activeModel: "gpt-5.5",
      providers: [
        { id: "openai", displayName: "OpenAI", type: "api-key", configured: true, modelCount: 2 },
        { id: "deepseek", displayName: "DeepSeek", type: "api-key", configured: false, modelCount: 1 },
      ],
    });

    expect(output).toContain("Lynn Providers / BYOK");
    expect(output).toContain("StepFun");
    expect(output).toContain("OpenAI");
    expect(output).not.toContain("secret");
    expect(output).toContain("Settings > Providers");
    expect(output).toContain("CLI BYOK");
    expect(output).not.toContain("sk-");
  });

  it("prints JSON when requested", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs(["providers", "--json", "--data-dir", "/tmp/lynn-cli-missing-test"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("\"type\":\"providers.info\"");
    expect(output).toContain("StepFun");
    expect(output).toContain("\"name\":\"stepfun\"");
    expect(output).toContain("\"model\":\"step-3.7-flash\"");
    expect(output).not.toContain("apiKey");
  });

  it("makes model a providers alias", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs(["model", "--data-dir", "/tmp/lynn-cli-missing-test"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("Default route");
    expect(output).toContain("BYOK");
  });

  it("renders localized provider guidance in Chinese", () => {
    setLang("zh");
    const output = renderProvidersInfo({
      defaultRoute: "StepFun 3.7 Flash → Spark Qwen 3.6 35B A3B via local Brain router (auto)",
      byokEntry: "Lynn 客户端 > 设置 > Providers",
      keyPolicy: "Provider keys stay private.",
      brainUrl: "http://127.0.0.1:8790",
      server: { status: "missing" },
      providers: [],
    });

    expect(output).toContain("当前路由");
    expect(output).toContain("默认模型");
    expect(output).toContain("三步配置 BYOK");
  });

  it("lists CLI BYOK presets so users can discover cloud backends", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs(["providers", "presets"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("stepfun");
    expect(output).toContain("step-3.7-flash");
    expect(output).toContain("Lynn providers set --preset stepfun --api-key <api-key>");
    expect(output).not.toContain("mimo");
  });

  it("prints provider presets as JSON when requested", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs(["providers", "presets", "--json"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("\"type\":\"providers.presets\"");
    expect(output).toContain("\"name\":\"stepfun\"");
    expect(output).not.toContain("\"name\":\"mimo\"");
    expect(output).not.toContain("apiKey");
  });

  it("renders provider presets without embedding keys", () => {
    const rendered = renderProviderPresets();

    expect(rendered).toContain("StepFun");
    expect(rendered).toContain("step-3.7-flash");
    expect(rendered).not.toContain("MiMo");
    expect(rendered).toContain("<api-key>");
    expect(rendered).not.toContain("sk-");
  });

  it("formats the active route for the startup banner", () => {
    expect(activeRouteLabel({
      defaultRoute: "StepFun 3.7 Flash → Spark Qwen 3.6 35B A3B via local Brain router (auto)",
      activeProvider: "stepfun",
      activeModel: "step-3.7-flash",
    })).toBe("StepFun 3.7 Flash (step-3.7-flash)");
    expect(activeRouteLabel({
      defaultRoute: "StepFun 3.7 Flash → Spark Qwen 3.6 35B A3B via local Brain router (auto)",
    })).toBe("StepFun 3.7 Flash → Spark Qwen 3.6 35B A3B via local Brain router (auto)");
  });

  it("saves a CLI BYOK provider profile without printing the raw key", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-providers-"));
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs([
        "providers",
        "set",
        "--data-dir",
        dataDir,
        "--base-url",
        "https://api.example.com/v1",
        "--api-key",
        "sk-secret-1234",
        "--model",
        "example-model",
      ]), false)).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }
    await expect(readCliProviderProfile(dataDir)).resolves.toMatchObject({
      baseUrl: "https://api.example.com/v1",
      model: "example-model",
      apiKey: "sk-secret-1234",
    });
    expect(output).toContain(providerProfilePath(dataDir));
    expect(output).toContain("sk-s…1234");
    expect(output).not.toContain("sk-secret-1234");
  });

  it("unsets the CLI BYOK provider so the CLI returns to the default Brain route", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-provider-unset-"));
    await writeCliProviderProfile(dataDir, {
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      model: "example-model",
      apiKey: "sk-secret-1234",
    });

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs([
        "providers",
        "unset",
        "--data-dir",
        dataDir,
      ]), false)).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    await expect(readCliProviderProfile(dataDir)).resolves.toBeNull();
    expect(output).toContain("Cleared CLI-only BYOK provider");
    expect(output).toContain(providerProfilePath(dataDir));
    expect(output).not.toContain("sk-secret-1234");
  });

  it("prints JSON when unsetting a missing CLI BYOK provider", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-provider-unset-json-"));
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs([
        "providers",
        "unset",
        "--data-dir",
        dataDir,
        "--json",
      ]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    const event = JSON.parse(output) as { type: string; deleted: boolean; path: string };
    expect(event.type).toBe("providers.unset");
    expect(event.deleted).toBe(false);
    expect(event.path).toBe(providerProfilePath(dataDir));
  });

  it("supports StepFun as a CLI BYOK preset without bundling a key", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-stepfun-"));
    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs([
        "providers",
        "set",
        "--data-dir",
        dataDir,
        "--preset",
        "stepfun",
        "--api-key",
        "step-secret",
      ]), false)).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    await expect(readCliProviderProfile(dataDir)).resolves.toMatchObject({
      provider: "openai-compatible",
      baseUrl: "https://api.stepfun.com/step_plan/v1",
      model: "step-3.7-flash",
      apiKey: "step-secret",
    });
    await expect(resolveCliProviderProfile(parseArgs([
      "code",
      "review this",
      "--data-dir",
      dataDir,
      "--preset",
      "stepfun",
    ]))).resolves.toMatchObject({
      source: "flags",
      profile: {
        provider: "openai-compatible",
        baseUrl: "https://api.stepfun.com/step_plan/v1",
        model: "step-3.7-flash",
        apiKey: "step-secret",
      },
    });
  });

  ptyIt("runs the interactive BYOK three-step wizard in a real TTY", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-provider-wizard-"));
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
proc = subprocess.Popen(
    [node_bin, "--import", "tsx", "src/cli.ts", "providers", "set", "--data-dir", data_dir],
    cwd=cwd,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env=env,
    close_fds=True,
)
os.close(slave)
buf = b""
stage = 0
deadline = time.time() + 8
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
        if stage == 0 and "API URL [" in text:
            os.write(master, b"https://api.example.com/v1\\r")
            stage = 1
        elif stage == 1 and text.endswith("API Key "):
            os.write(master, b"sk-wizard-secret\\r")
            stage = 2
        elif stage == 2 and "Model name" in text:
            os.write(master, b"wizard-model\\r")
            stage = 3
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
if stage != 3:
    sys.stderr.write(f"wizard did not complete, stage={stage}\\n")
sys.stdout.write(text)
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

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Step 1/3: API URL");
    expect(result.stdout).toContain("Step 2/3: API Key");
    expect(result.stdout).toContain("Step 3/3: Model name");
    expect(result.stdout).toContain("Saved CLI BYOK provider");
    expect(result.stdout).toContain("sk-w…cret");
    expect(result.stdout).not.toContain("sk-wizard-secret");
    await expect(readCliProviderProfile(dataDir)).resolves.toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      model: "wizard-model",
      apiKey: "sk-wizard-secret",
    });
  });

  it("does not reuse a stored key for a different provider preset", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-provider-key-"));
    await fs.mkdir(path.dirname(providerProfilePath(dataDir)), { recursive: true });
    await fs.writeFile(providerProfilePath(dataDir), JSON.stringify({
      provider: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKey: "deepseek-secret",
    }), "utf8");

    await expect(resolveCliProviderProfile(parseArgs([
      "code",
      "review this",
      "--data-dir",
      dataDir,
      "--preset",
      "stepfun",
    ]))).resolves.toMatchObject({
      source: "flags",
      profile: {
        baseUrl: "https://api.stepfun.com/step_plan/v1",
        model: "step-3.7-flash",
        apiKey: undefined,
      },
    });
  });

  it("does not reuse generic OpenAI env keys for non-OpenAI presets", async () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = "sk-openai-only";

      await expect(resolveCliProviderProfile(parseArgs([
        "code",
        "review this",
        "--preset",
        "stepfun",
        "--data-dir",
        await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-stepfun-key-")),
      ]))).resolves.toMatchObject({
        source: "flags",
        profile: {
          baseUrl: "https://api.stepfun.com/step_plan/v1",
          model: "step-3.7-flash",
          apiKey: undefined,
        },
      });

      await expect(resolveCliProviderProfile(parseArgs([
        "code",
        "review this",
        "--base-url",
        "https://api.example.com/v1",
        "--model",
        "example-model",
        "--data-dir",
        await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-generic-key-")),
      ]))).resolves.toMatchObject({
        source: "flags",
        profile: {
          baseUrl: "https://api.example.com/v1",
          model: "example-model",
          apiKey: "sk-openai-only",
        },
      });
    } finally {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  });

  it("accepts preset-specific environment keys for CLI BYOK", async () => {
    expect(readEnvProviderProfile({
      LYNN_CLI_PRESET: "stepfun",
      STEPFUN_API_KEY: "step-env-key",
    })).toMatchObject({
      baseUrl: "https://api.stepfun.com/step_plan/v1",
      model: "step-3.7-flash",
      apiKey: "step-env-key",
    });

    expect(readEnvProviderProfile({
      LYNN_CLI_PRESET: "stepfun",
      OPENAI_API_KEY: "sk-openai-only",
    })).toMatchObject({
      baseUrl: "https://api.stepfun.com/step_plan/v1",
      model: "step-3.7-flash",
      apiKey: undefined,
    });
  });

  it("tests a configured CLI BYOK provider without printing the raw key", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-provider-test-"));
    const server = http.createServer(async (request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-provider-test-secret");
      const body = await readRequestBody(request);
      expect(body).toContain("\"model\":\"test-model\"");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("provider test server did not listen");
    await writeCliProviderProfile(dataDir, {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      apiKey: "sk-provider-test-secret",
    });

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs(["providers", "test", "--data-dir", dataDir]), false)).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }

    expect(output).toContain("Provider test OK");
    expect(output).toContain("test-model");
    expect(output).toContain("preview: ok");
    expect(output).not.toContain("sk-provider-test-secret");
  });

  it("returns a nonzero provider test result when no CLI BYOK profile exists", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-provider-missing-"));
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs(["providers", "test", "--data-dir", dataDir]), false)).resolves.toBe(2);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("No CLI BYOK provider is configured yet");
    expect(output).toContain("providers set");
  });
});

function hasPython3(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}
