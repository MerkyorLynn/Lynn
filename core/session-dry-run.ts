import { spawnSync } from "child_process";
import fsp from "fs/promises";
import os from "os";
import path from "path";

const DRY_RUN_COPY_IGNORES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
]);

export async function prepareDryRunWorkspace(sourceDir: string) {
  const src = path.resolve(sourceDir || process.cwd());
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lynn-shadow-"));
  await fsp.cp(src, tempDir, {
    recursive: true,
    dereference: false,
    filter: async (itemPath) => {
      if ((await fsp.lstat(itemPath)).isSymbolicLink()) return false;
      const base = path.basename(itemPath);
      if (itemPath === src) return true;
      return !DRY_RUN_COPY_IGNORES.has(base);
    },
  });
  return tempDir;
}

export function runDryRunValidation(cwd: string, validateCommand: unknown[] | undefined) {
  if (!Array.isArray(validateCommand) || validateCommand.length === 0) return null;
  const [command, ...args] = validateCommand.map((item) => String(item));
  if (!command) return null;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    timeout: 60_000,
  });
  return {
    command,
    args,
    exitCode: result.status ?? 1,
    signal: result.signal || null,
    stdout: (result.stdout || "").trim().slice(0, 4000),
    stderr: (result.stderr || "").trim().slice(0, 4000),
  };
}
