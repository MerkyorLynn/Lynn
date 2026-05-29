/**
 * worker-command.ts - resolve the OS command the server uses to spawn
 * `lynn worker run`. The CLI runtime is resolved by the desktop main process
 * (desktop/cli-env-manager.cjs) and handed to the server via env:
 *   LYNN_CLI_ENTRY            absolute path to the bundled cli/lynn.mjs
 *   LYNN_CLI_NODE             node binary to run it (defaults to the server's own)
 *   LYNN_CLI_ELECTRON_AS_NODE "1" when LYNN_CLI_NODE is the Electron binary
 * Dev fallback: a cli build under the repo (cli/dist/lynn.mjs or cli/bin/lynn.mjs)
 * run with the server's own node.
 *
 * Returns null when no CLI runtime is available - the FleetHub then stays in
 * stub-broadcast mode until the CLI lane (cli/**) is integrated into the tree.
 */
import fs from "node:fs";
import path from "node:path";

export interface ResolveOpts {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  fileExists?: (p: string) => boolean;
}

function defaultExists(p: string): boolean {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

function resolveEntry(
  opts: ResolveOpts,
): { node: string; entry: string; electronAsNode: boolean; source: "bundled" | "electron" | "dev" } | null {
  const env = opts.env ?? process.env;
  const execPath = opts.execPath ?? process.execPath;
  const fileExists = opts.fileExists ?? defaultExists;

  // 1) main-process-provided (packaged): LYNN_CLI_ENTRY (+ node)
  const envEntry = env.LYNN_CLI_ENTRY;
  if (envEntry && fileExists(envEntry)) {
    const electronAsNode = env.LYNN_CLI_ELECTRON_AS_NODE === "1";
    return {
      node: env.LYNN_CLI_NODE || execPath,
      entry: envEntry,
      electronAsNode,
      source: electronAsNode ? "electron" : "bundled",
    };
  }
  // 2) dev fallback: a cli build under the repo, run with the server's own node
  const repoRoot = opts.repoRoot ?? process.cwd();
  for (const rel of ["cli/dist/lynn.mjs", "cli/bin/lynn.mjs"]) {
    const p = path.join(repoRoot, rel);
    if (fileExists(p)) return { node: execPath, entry: p, electronAsNode: false, source: "dev" };
  }
  return null;
}

function resolveLegacyRunner(
  workerArgs: string[],
  opts: ResolveOpts,
): ResolvedCommand | null {
  const env = opts.env ?? process.env;
  const command = env.LYNN_FLEET_RUNNER_COMMAND;
  if (!command) return null;
  let prefix: string[] = [];
  try {
    const parsed = JSON.parse(env.LYNN_FLEET_RUNNER_ARGS_PREFIX || "[]");
    if (Array.isArray(parsed) && parsed.every((arg) => typeof arg === "string")) {
      prefix = parsed;
    }
  } catch {
    prefix = [];
  }
  const resolvedEnv = { ...env };
  if (env.LYNN_FLEET_RUNNER_ELECTRON_AS_NODE === "1") {
    resolvedEnv.ELECTRON_RUN_AS_NODE = "1";
  }
  return {
    command,
    args: [...prefix, ...workerArgs],
    env: resolvedEnv,
    source: env.LYNN_FLEET_RUNNER_ELECTRON_AS_NODE === "1" ? "electron" : "bundled",
  };
}

export function cliRuntimeAvailable(opts: ResolveOpts = {}): boolean {
  return resolveEntry(opts) !== null || resolveLegacyRunner([], opts) !== null;
}

export interface ResolvedCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Where the runtime came from, for the GUI runner line (B3). */
  source: "bundled" | "electron" | "dev";
}

export function resolveCliCommand(workerArgs: string[], opts: ResolveOpts = {}): ResolvedCommand | null {
  const r = resolveEntry(opts);
  if (!r) return resolveLegacyRunner(workerArgs, opts);
  const env = { ...(opts.env ?? process.env) };
  if (r.electronAsNode) env.ELECTRON_RUN_AS_NODE = "1";
  return { command: r.node, args: [r.entry, ...workerArgs], env, source: r.source };
}
