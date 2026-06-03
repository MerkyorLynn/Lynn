import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClientToolResult, ToolRunContext } from "./types.js";
import { isSafeReadOnlyShellCommand } from "../local-command.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_STREAM_BYTES = 1_000_000;
const WORKSPACE_BASH_ALLOWED = /^(npm|pnpm|yarn|bun|node|python3?|pytest|deno|cargo|rustc|go|git|rg|grep|find|ls|pwd|cat|sed|awk|wc|head|tail|sort|uniq|diff)\b/;
const WORKSPACE_BASH_FORBIDDEN = [
  /[;&|`]/,
  /\$\(/,
  /\bsudo\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bscp\b/,
  /\brsync\b/,
  /\bssh\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\brm\s+-[^;&|]*r[^;&|]*\s+\//,
  /(^|[\s"'`=])\.\.(\/|$)/,
  /(^|[\s"'`=])~(\/|$)/,
  /(^|[\s"'`=])\/(Users|private|tmp|var|etc|opt|System|Library)\b/,
  />\s*\//,
  // Allowlisted binaries (find / git) that can still destroy the tree.
  /\bfind\b[^;&|]*\s-delete\b/,
  /\bfind\b[^;&|]*-exec\b[^;&|]*\brm\b/,
  /\bgit\s+clean\b/,
];

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= MAX_STREAM_BYTES) return combined;
  return combined.slice(-MAX_STREAM_BYTES);
}

/** Best-effort append to ~/.lynn/bash-audit.log so executed shell is auditable. */
export function auditBash(command: string, cwd: string): void {
  try {
    const file = path.join(os.homedir(), ".lynn", "bash-audit.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()}\t${cwd}\t${command}\n`);
  } catch {
    /* auditing is non-critical */
  }
}

export function assertWorkspaceBashAllowed(command: string, sandbox: ToolRunContext["sandbox"]): void {
  if (sandbox === "danger-full-access") return;
  const trimmed = command.trim();
  if (!WORKSPACE_BASH_ALLOWED.test(trimmed)) {
    throw new Error("bash command is not allowed in workspace-write sandbox; use /yolo for danger-full-access shell access, or run headless/Fleet with --approval yolo --sandbox danger-full-access");
  }
  const hit = WORKSPACE_BASH_FORBIDDEN.find((pattern) => pattern.test(trimmed));
  if (hit) {
    throw new Error("bash command may escape the workspace; use /yolo if you trust this command, or run headless/Fleet with --approval yolo --sandbox danger-full-access");
  }
}

export async function bashTool(ctx: ToolRunContext, command: string): Promise<ClientToolResult> {
  if (!command) throw new Error("--command is required for bash");
  assertWorkspaceBashAllowed(command, ctx.sandbox || "workspace-write");
  if (ctx.approval !== "yolo" && !isSafeReadOnlyShellCommand(command)) {
    throw new Error("bash requires approval except for safe read-only pwd/ls shortcuts. In interactive ask mode, approve the prompt; for headless/Fleet runs pass --approval yolo.");
  }
  auditBash(command, ctx.cwd);
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: ctx.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, ctx.timeoutMs || DEFAULT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => { stdout = appendLimited(stdout, String(chunk)); });
    child.stderr?.on("data", (chunk) => { stderr = appendLimited(stderr, String(chunk)); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        ok: code === 0 && !timedOut,
        tool: "bash",
        output: { command, exitCode: code ?? null, timedOut, stdout, stderr },
      });
    });
  });
}
