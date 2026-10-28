import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
const execute = promisify(execFile);
const isPositiveFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

type HiddenExecOptions = {
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
  encoding: "utf8";
  stdio: ["ignore", "pipe", "pipe"];
};

type ProcessListInvocation = {
  file: string;
  args: string[];
  options: HiddenExecOptions;
};

function hiddenExecOptions(timeout: number, maxBuffer: number): HiddenExecOptions {
  return {
    timeout,
    maxBuffer,
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
}

function commandOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function windowsSystemBinary(...segments: string[]): string {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.win32.join(path.win32.isAbsolute(root) ? root : "C:\\Windows", "System32", ...segments);
}

function addressPort(address: string): string | null {
  const match = /:(\d+)$/.exec(address);
  return match ? match[1] : null;
}

function isWildcardRemote(address: string): boolean {
  return address === "0.0.0.0:0"
    || address === "[::]:0"
    || address === "*:*"
    || address === "[::]:*"
    || address === "0.0.0.0:*";
}

// netstat's state column is localized ("LISTENING" / "侦听"), so match the wildcard
// remote address that Windows prints for listeners instead of the state word.
export function parseWindowsListenerPids(stdout: string, port: string): number[] {
  const wanted = String(port);
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || parts[0].toUpperCase() !== "TCP") continue;
    if (addressPort(parts[1]) !== wanted) continue;
    if (!isWildcardRemote(parts[2])) continue;
    const pid = Number(parts[parts.length - 1]);
    if (Number.isFinite(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

export function parseProcessCommandLines(stdout: string): Array<{ pid: number; command: string }> {
  const processes: Array<{ pid: number; command: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    processes.push({ pid, command: match[2] || "" });
  }
  return processes;
}

export function selectQwen35ProcessPids(
  processes: Array<{ pid: number; command: string }>,
  port: string,
  modelPaths: readonly string[],
): number[] {
  return processes
    .map(({ pid, command }): number | null => {
      if (!Number.isFinite(pid) || pid <= 0) return null;
      if (!/llama-server(?:\s|$)/.test(command) && !/llama-server\b/.test(command)) return null;
      const numericPort = /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535 ? String(Number(port)) : null;
      const mentionsPort = numericPort !== null && new RegExp(`(?:^|\\s)--port(?:=|\\s+)["']?${numericPort}(?:["']?(?:\\s|$))`).test(command);
      const mentionsModel = modelPaths.some((candidate) => candidate && command.includes(candidate))
        || /Q4-imatrix-MTP-00001-of-00004/i.test(command)
        || /qwen36-27b-dsv4pro-coding-q4-mtp/i.test(command)
        || /Qwen3\.6-27B-DSV4Pro-Distill-MTP-Q5_K_M/i.test(command)
        || /qwen36-27b-dsv4pro-distill-q5km/i.test(command);
      return mentionsPort || mentionsModel ? pid : null;
    })
    .filter(isPositiveFiniteNumber);
}

const WINDOWS_LLAMA_PROCESS_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "Get-CimInstance -ClassName Win32_Process -Filter \"Name LIKE '%llama-server%'\" | ForEach-Object {",
  "  if ($null -ne $_.ProcessId) {",
  "    $cmd = $_.CommandLine",
  "    if ([string]::IsNullOrEmpty($cmd)) { $cmd = $_.Name }",
  "    Write-Output ($_.ProcessId.ToString() + \"`t\" + $cmd)",
  "  }",
  "}",
].join("\n");

export function localQwenListenerInvocation(port: string, platform: NodeJS.Platform = process.platform): ProcessListInvocation {
  if (platform === "win32") {
    return {
      file: windowsSystemBinary("netstat.exe"),
      args: ["-ano", "-p", "TCP"],
      options: hiddenExecOptions(2_000, 1024 * 1024),
    };
  }
  return {
    file: "lsof",
    args: ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    options: hiddenExecOptions(2_000, 32 * 1024),
  };
}

export function localQwenProcessListInvocation(platform: NodeJS.Platform = process.platform): ProcessListInvocation {
  if (platform === "win32") {
    const encoded = Buffer.from(WINDOWS_LLAMA_PROCESS_SCRIPT, "utf16le").toString("base64");
    return {
      file: windowsSystemBinary("WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      // Cold Windows CIM initialization can exceed five seconds; keep a bounded
      // wait instead of incorrectly reporting a running model as absent.
      options: hiddenExecOptions(15_000, 512 * 1024),
    };
  }
  return {
    file: "ps",
    args: ["-axo", "pid=,command="],
    options: hiddenExecOptions(2_000, 512 * 1024),
  };
}

function parseWhitespacePids(stdout: string): number[] {
  return stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter(isPositiveFiniteNumber);
}

export async function localListenerPids(port: string, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return [];
  const invocation = localQwenListenerInvocation(String(Number(port)), platform);
  try {
    const { stdout } = await execute(invocation.file, invocation.args, invocation.options);
    return platform === "win32" ? parseWindowsListenerPids(commandOutput(stdout), String(Number(port))) : parseWhitespacePids(commandOutput(stdout));
  } catch { return []; }
}

export async function localLlamaProcesses(platform: NodeJS.Platform = process.platform): Promise<Array<{ pid: number; command: string }>> {
  const invocation = localQwenProcessListInvocation(platform);
  try {
    const { stdout } = await execute(invocation.file, invocation.args, invocation.options);
    return parseProcessCommandLines(commandOutput(stdout)).filter(row => /llama-server\b/.test(row.command));
  } catch { return []; }
}
