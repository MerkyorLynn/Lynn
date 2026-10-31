"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);

async function readProcessCommandLine(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "";
  try {
    if (platform === "linux") return (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ");
    if (platform === "win32") {
      const powershell = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      return (await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { timeout: 15_000, windowsHide: true })).stdout.trim();
    }
    return (await run("/bin/ps", ["-p", String(pid), "-o", "command="], { timeout: 3000 })).stdout.trim();
  } catch { return ""; }
}

function isOwnedServerCommand(command, launch) {
  if (!command || !launch) return false;
  const normalize = value => String(value).replace(/\\/g, "/");
  const text = normalize(command);
  const bin = normalize(launch.serverBin);
  const executable = text.startsWith(bin) ? text.slice(bin.length) : text.startsWith(`"${bin}"`) ? text.slice(bin.length + 2) : null;
  if (executable === null || (executable && !/^\s/.test(executable))) return false;
  const hasArgument = entry => {
    const escaped = normalize(entry).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[\\s"'])${escaped}(?=$|[\\s"'])`).test(text);
  };
  const entryPaths = (launch.serverArgs || []).filter(arg => path.isAbsolute(arg) || path.win32.isAbsolute(arg));
  if (entryPaths.length) return entryPaths.every(hasArgument);
  return /\/lynn-server(?:\.exe)?$/.test(bin);
}
module.exports = { readProcessCommandLine, isOwnedServerCommand };
