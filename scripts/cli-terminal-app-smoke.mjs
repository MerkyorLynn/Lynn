#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(root, "cli", "bin", "lynn.mjs");
const turns = Number.parseInt(process.env.LYNN_CLI_TERMINAL_APP_TURNS || "6", 10);

if (process.platform !== "darwin") {
  console.log("[cli-terminal-app-smoke] skipped: Terminal.app is macOS-only");
  process.exit(0);
}
if (!Number.isFinite(turns) || turns < 1) {
  throw new Error("LYNN_CLI_TERMINAL_APP_TURNS must be a positive number");
}
await fs.access(cliEntry);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-terminal-app-smoke-"));
const statusPath = path.join(tmp, "status.txt");
const transcriptPath = path.join(tmp, "transcript.txt");
const appleScriptPath = path.join(tmp, "run.applescript");

const commands = [
  ...Array.from({ length: turns }, (_, index) => `你好,Terminal 应用窗口中文 smoke ${index + 1}`),
  "/think",
  "/reasoning off",
  "/version",
  "/yolo",
  "/exit",
];

const appleScript = `
on run argv
  set repoDir to item 1 of argv
  set statusPath to item 2 of argv
  set transcriptPath to item 3 of argv
  set commandCount to item 4 of argv as integer
  set runCommand to "cd " & quoted form of repoDir & " && printf 'terminal-app-smoke-start\\\\n' > " & quoted form of transcriptPath & " && LYNN_CLI_UPDATE_CHECK=0 LYNN_LANG=zh node cli/bin/lynn.mjs --mock-brain; echo $? > " & quoted form of statusPath
  tell application "Terminal"
    activate
    set smokeWindow to do script runCommand
    delay 3
${commands.map((command, index) => `    do script ${quoteApple(command)} in smokeWindow
    delay ${index < turns ? "1" : "0.5"}`).join("\n")}
  end tell
end run
`;

await fs.writeFile(appleScriptPath, appleScript, "utf8");
await execFileAsync("osascript", [appleScriptPath, root, statusPath, transcriptPath, String(commands.length)], { timeout: 45_000 });

const deadline = Date.now() + Math.max(45_000, turns * 4_000 + 20_000);
while (Date.now() < deadline) {
  if (await exists(statusPath)) break;
  await sleep(500);
}
if (!(await exists(statusPath))) {
  throw new Error(`[cli-terminal-app-smoke] timed out waiting for Terminal.app smoke status; temp=${tmp}`);
}

const status = (await fs.readFile(statusPath, "utf8")).trim();
if (status !== "0") {
  throw new Error(`[cli-terminal-app-smoke] Lynn exited ${status}; temp=${tmp}`);
}

console.log(`[cli-terminal-app-smoke] passed Terminal.app smoke (${turns} Chinese turns); temp=${tmp}`);

function quoteApple(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
