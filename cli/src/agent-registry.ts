import fs from "node:fs";
import path from "node:path";

export interface CliAgentEntry {
  id: string;
  label: string;
  bin: string;
  enabled: boolean;
  available: boolean;
  availability: string;
  kind: "built-in" | "external";
  requiresPreset?: string;
}

const AGENTS: Array<Omit<CliAgentEntry, "available" | "availability"> & { profileHint?: string }> = [
  { id: "lynn-cli", label: "Lynn CLI", bin: "Lynn", enabled: true, kind: "built-in", profileHint: "current binary" },
  { id: "stepfun-flash", label: "StepFun 3.7 Flash", bin: "Lynn", enabled: true, kind: "built-in", profileHint: "built-in profile - BYOK preset stepfun", requiresPreset: "stepfun" },
  { id: "codex-cli", label: "Codex", bin: "codex", enabled: true, kind: "external" },
  { id: "claude-code", label: "Claude Code", bin: "claude", enabled: true, kind: "external" },
  { id: "claude-internal", label: "Claude (internal)", bin: "claude-internal", enabled: true, kind: "external" },
  { id: "qwen-cli", label: "Qwen", bin: "qwen", enabled: true, kind: "external" },
  { id: "kimi-cli", label: "Kimi", bin: "kimi", enabled: true, kind: "external" },
  { id: "opencode", label: "OpenCode", bin: "opencode", enabled: true, kind: "external" },
  { id: "codebuddy", label: "CodeBuddy", bin: "codebuddy", enabled: true, kind: "external" },
];

export interface DetectCliAgentsOptions {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  fileExists?: (file: string) => boolean;
  configuredPreset?: string | null;
}

export function detectCliAgents(opts: DetectCliAgentsOptions = {}): CliAgentEntry[] {
  const platform = opts.platform || process.platform;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const fileExists = opts.fileExists ?? defaultFileExists;
  return AGENTS.map((agent) => {
    if (agent.kind === "built-in") {
      const { profileHint: _profileHint, ...entry } = agent;
      if (agent.requiresPreset && agent.requiresPreset !== opts.configuredPreset) {
        return {
          ...entry,
          available: false,
          availability: `requires: Lynn providers set --preset ${agent.requiresPreset} --api-key <api-key>`,
        };
      }
      return { ...entry, available: true, availability: agent.profileHint || "current binary" };
    }
    const found = findCommand(agent.bin, { pathEnv, platform, fileExists });
    return {
      ...agent,
      available: !!found,
      availability: found || "not found on PATH",
    };
  });
}

function findCommand(
  bin: string,
  opts: Required<Pick<DetectCliAgentsOptions, "pathEnv" | "platform" | "fileExists">>,
): string | null {
  const pathApi = opts.platform === "win32" ? path.win32 : path.posix;
  const delimiter = opts.platform === "win32" ? ";" : ":";
  const candidates = pathApi.isAbsolute(bin) || bin.includes(pathApi.sep)
    ? [bin]
    : opts.pathEnv.split(delimiter).filter(Boolean).map((dir) => pathApi.join(dir, bin));
  const suffixes = opts.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const candidate of candidates) {
    for (const suffix of suffixes) {
      const file = candidate.endsWith(suffix) ? candidate : `${candidate}${suffix}`;
      if (opts.fileExists(file)) return file;
    }
  }
  return null;
}

function defaultFileExists(file: string): boolean {
  try {
    return !!file && fs.existsSync(file);
  } catch {
    return false;
  }
}
