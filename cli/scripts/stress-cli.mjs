#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "lynn.mjs");

if (!existsSync(bin)) {
  console.error(`[stress-cli] missing ${bin}; run npm --prefix cli run build first`);
  process.exit(1);
}

const serial = Number.parseInt(process.env.LYNN_CLI_STRESS_SERIAL || "40", 10);
const parallel = Number.parseInt(process.env.LYNN_CLI_STRESS_PARALLEL || "8", 10);

for (let i = 0; i < serial; i += 1) {
  await runPromptVersion(i);
}
await Promise.all(Array.from({ length: parallel }, (_, i) => runPromptVersion(i + serial)));
for (let i = 0; i < Math.max(4, Math.floor(serial / 4)); i += 1) {
  await runCodePromptVersion(i);
}
await runPromptNonVersionSmoke();

if (process.platform !== "win32") {
  await runAppleTerminalStablePty();
  await runAppleTerminalMockConversationPty();
}

console.log(`[stress-cli] ok: ${serial} serial + ${parallel} parallel -p runs + code -p local checks + non-version smoke${process.platform === "win32" ? "" : " + Apple Terminal stable PTY + Apple Terminal mock conversation"}`);

async function runPromptVersion(index) {
  const result = await run(process.execPath, [bin, "-p", index % 2 ? "what version are you?" : "你的版本号", "--json", "--brain-url", "http://127.0.0.1:1"], {
    env: {
      ...process.env,
      LYNN_LANG: index % 2 ? "en" : "zh",
      NO_COLOR: "1",
    },
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(`-p stress ${index} exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (!result.stdout.includes('"local":true') || !/Lynn CLI (版本|version)/.test(result.stdout)) {
    throw new Error(`-p stress ${index} did not use local runtime answer:\n${result.stdout}`);
  }
  if (/fetch failed|Brain offline|all providers failed/i.test(result.stdout + result.stderr)) {
    throw new Error(`-p stress ${index} unexpectedly contacted Brain:\n${result.stdout}\n${result.stderr}`);
  }
}

async function runCodePromptVersion(index) {
  const result = await run(process.execPath, [bin, "code", "-p", index % 2 ? "what version are you?" : "你的版本号", "--json", "--brain-url", "http://127.0.0.1:1"], {
    env: {
      ...process.env,
      LYNN_LANG: index % 2 ? "en" : "zh",
      NO_COLOR: "1",
    },
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(`code -p stress ${index} exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (!result.stdout.includes('"local":true') || !/Lynn CLI (版本|version)/.test(result.stdout)) {
    throw new Error(`code -p stress ${index} did not use local runtime answer:\n${result.stdout}`);
  }
  if (/fetch failed|Brain offline|all providers failed/i.test(result.stdout + result.stderr)) {
    throw new Error(`code -p stress ${index} unexpectedly contacted Brain:\n${result.stdout}\n${result.stderr}`);
  }
}

async function runPromptNonVersionSmoke() {
  const result = await run(process.execPath, [bin, "-p", "write a semantic version comparator", "--mock-brain", "--json", "--brain-url", "http://127.0.0.1:1"], {
    env: {
      ...process.env,
      LYNN_LANG: "en",
      NO_COLOR: "1",
    },
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(`non-version smoke exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (result.stdout.includes('"local":true') || /Lynn CLI (版本|version)/.test(result.stdout)) {
    throw new Error(`non-version smoke was incorrectly intercepted as runtime question:\n${result.stdout}`);
  }
  if (!/Mock (Lynn response|reply)/.test(result.stdout)) {
    throw new Error(`non-version smoke did not reach mock brain path:\n${result.stdout}`);
  }
}

async function runAppleTerminalStablePty() {
  const python = await findPython();
  if (!python) {
    console.log("[stress-cli] skip Apple Terminal PTY: python3 not found");
    return;
  }
  const script = String.raw`
import os
import pty
import select
import subprocess
import sys
import time

node_bin, cli_bin = sys.argv[1], sys.argv[2]
master, slave = pty.openpty()
env = os.environ.copy()
env["TERM_PROGRAM"] = "Apple_Terminal"
env["NO_COLOR"] = "1"
env["LYNN_LANG"] = "zh"
env["LYNN_BRAIN_URL"] = "http://127.0.0.1:1"
proc = subprocess.Popen([node_bin, cli_bin], stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
os.close(slave)
buf = b""
sent_version = False
sent_yolo = False
sent_exit = False
deadline = time.time() + 20
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
        if (not sent_version) and ("Lynn CLI" in text) and ("›" in text or ">" in text):
            os.write(master, "/version\r".encode("utf-8"))
            sent_version = True
        elif sent_version and (not sent_yolo) and ("Lynn CLI 版本" in text or "Lynn CLI version" in text) and ("›" in text or ">" in text):
            os.write(master, "/yolo\r".encode("utf-8"))
            sent_yolo = True
        elif sent_yolo and (not sent_exit) and ("YOLO 静默" in text or "danger-full-access" in text or "zero-prompt" in text) and ("›" in text or ">" in text):
            os.write(master, "/exit\r".encode("utf-8"))
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
text = buf.decode("utf-8", errors="replace")
sys.stdout.write(text)
if proc.returncode not in (0, None):
    sys.exit(proc.returncode)
if "Lynn CLI 版本" not in text and "Lynn CLI version" not in text:
    sys.exit(13)
if "fetch failed" in text or "all providers failed" in text:
    sys.exit(14)
if "yolo" not in text.lower():
    sys.exit(15)
sys.exit(0)
`;
  const result = await run(python, ["-c", script, process.execPath, bin], {
    env: process.env,
    timeoutMs: 25_000,
  });
  if (result.code !== 0) {
    throw new Error(`Apple Terminal stable PTY stress exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

async function runAppleTerminalMockConversationPty() {
  const python = await findPython();
  if (!python) {
    console.log("[stress-cli] skip Apple Terminal mock conversation: python3 not found");
    return;
  }
  const script = String.raw`
import os
import pty
import select
import subprocess
import sys
import time

node_bin, cli_bin = sys.argv[1], sys.argv[2]
master, slave = pty.openpty()
env = os.environ.copy()
env["TERM_PROGRAM"] = "Apple_Terminal"
env["NO_COLOR"] = "1"
env["LYNN_LANG"] = "zh"
env["LYNN_BRAIN_URL"] = "http://127.0.0.1:1"
proc = subprocess.Popen([node_bin, cli_bin, "--mock-brain"], stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
os.close(slave)
buf = b""
steps = [
    ("你好,测试中文输入", "模拟回复"),
    ("/think", "思考模式"),
    ("/reasoning off", "推理强度已设为 off"),
    ("/yolo", "YOLO 静默"),
    ("/help", "/exit"),
    ("/exit", None),
]
sent = 0
deadline = time.time() + 35
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
        if sent < len(steps) and ("›" in text or ">" in text) and (sent == 0 or steps[sent - 1][1] is None or steps[sent - 1][1] in text):
            command, _ = steps[sent]
            os.write(master, (command + "\r").encode("utf-8"))
            sent += 1
    if sent >= len(steps) and proc.poll() is not None:
        break
if proc.poll() is None:
    proc.terminate()
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
text = buf.decode("utf-8", errors="replace")
sys.stdout.write(text)
if proc.returncode not in (0, None):
    sys.exit(proc.returncode)
required = ["模拟回复", "思考模式", "推理强度已设为 off", "yolo", "/exit"]
missing = [item for item in required if item.lower() not in text.lower()]
if missing:
    sys.stderr.write("missing expected Apple Terminal mock markers: " + ", ".join(missing) + "\n")
    sys.exit(16)
if "fetch failed" in text or "all providers failed" in text:
    sys.exit(17)
sys.exit(0)
`;
  const result = await run(python, ["-c", script, process.execPath, bin], {
    env: process.env,
    timeoutMs: 40_000,
  });
  if (result.code !== 0) {
    throw new Error(`Apple Terminal mock conversation stress exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

async function findPython() {
  for (const candidate of ["python3", "python"]) {
    const result = await run(candidate, ["--version"], { timeoutMs: 3000, allowFailure: true });
    if (result.code === 0) return candidate;
  }
  return null;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs || 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (options.allowFailure) resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
      else reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
