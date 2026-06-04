#!/usr/bin/env node

import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(root, "cli", "bin", "lynn.mjs");
const timeoutMs = Number.parseInt(process.env.LYNN_CLI_PTY_TIMEOUT_MS || "20000", 10);

if (!Number.isFinite(timeoutMs) || timeoutMs < 5_000) {
  throw new Error("LYNN_CLI_PTY_TIMEOUT_MS must be at least 5000");
}

const python = String.raw`
import os, pty, select, signal, sys, time, traceback

root, node_path, cli_entry, timeout_ms = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
env = os.environ.copy()
env.update({
  "TERM": "xterm-256color",
  "TERM_PROGRAM": "Apple_Terminal",
  "LYNN_CLI_UPDATE_CHECK": "0",
  "LYNN_LANG": "zh",
})
if os.environ.get("LYNN_CLI_PTY_FULL_TUI") == "1":
  env["LYNN_CLI_APPLE_TERMINAL_FULL_TUI"] = "1"

pid, fd = pty.fork()
if pid == 0:
  os.chdir(root)
  os.execve(node_path, [node_path, cli_entry, "--mock-brain"], env)

output = b""
stage = 0
stage_started = time.time()
deadline = time.time() + (timeout_ms / 1000.0)
exit_code = None
long_paste = "第一段: Lynn PTY paste gate\n第二段: 确认长粘贴会收敛成粘贴块\n第三段: 提交后仍完整进入模型"

def plain():
  text = output.decode("utf-8", "ignore")
  import re
  text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)
  text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\\\)", "", text)
  return text

try:
  while time.time() < deadline:
    done, status = os.waitpid(pid, os.WNOHANG)
    if done == pid:
      if os.WIFEXITED(status):
        exit_code = os.WEXITSTATUS(status)
      elif os.WIFSIGNALED(status):
        exit_code = 128 + os.WTERMSIG(status)
      break

    readable, _, _ = select.select([fd], [], [], 0.1)
    if fd in readable:
      try:
        chunk = os.read(fd, 4096)
      except OSError:
        chunk = b""
      if chunk:
        output += chunk
    text = plain()
    if stage == 0 and "›" in text:
      # Empty enter must not submit the placeholder or repeat the previous turn.
      os.write(fd, b"\r")
      stage = 1
      stage_started = time.time()
    elif stage == 1:
      if "模拟回复:" in text or "模拟回复：" in text:
        raise RuntimeError("empty enter submitted a prompt")
      if time.time() - stage_started > 0.4:
        payload = "\x1b[200~" + long_paste + "\x1b[201~"
        os.write(fd, payload.encode("utf-8"))
        stage = 2
        stage_started = time.time()
    elif stage == 2 and "粘贴块" in text:
      os.write(fd, b"\r")
      stage = 3
      stage_started = time.time()
    elif stage == 3 and ("模拟回复:" in text or "模拟回复：" in text) and "第三段" in text:
      os.write(fd, "你好世界\r".encode("utf-8"))
      stage = 4
      stage_started = time.time()
    elif stage == 4 and ("模拟回复:你好世界" in text or "模拟回复：你好世界" in text):
      os.write(fd, b"/exit\r")
      stage = 5

  if exit_code is None:
    try:
      os.kill(pid, signal.SIGTERM)
    except OSError:
      pass
    raise RuntimeError("timed out waiting for Lynn to exit")

  text = plain()
  if exit_code != 0:
    raise RuntimeError(f"Lynn exited {exit_code}")
  if stage < 5:
    raise RuntimeError(f"Lynn exited before completing the PTY smoke, stage={stage}")
  if any(marker in text for marker in ["Uncaught", "TypeError", "ReferenceError", "setRawMode", "Cannot find module"]):
    raise RuntimeError("detected crash-like output")
  print("[cli-pty-smoke] passed Apple Terminal compatible PTY smoke")
except Exception as exc:
  text = plain()
  tail = "\n".join(text.splitlines()[-80:])
  print(f"[cli-pty-smoke] {exc}\n--- output tail ---\n{tail}", file=sys.stderr)
  sys.exit(1)
`;

const pythonBin = process.env.PYTHON || "python3";
await execFileAsync(pythonBin, ["-c", python, root, process.execPath, cliEntry, String(timeoutMs)], { timeout: timeoutMs + 5_000 });

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (error) {
        error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
