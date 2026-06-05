/**
 * registry.ts — default worker-adapter registry (B-line server view).
 *
 * The GUI dispatches through one normalized entry; Lynn's adapter layer maps it to
 * the concrete CLI argv. v0.80 ships a small enabled set; others are present but
 * disabled until their JSONL/permission/cwd behaviour is verified on the machine.
 */
import type { FleetAgentKind } from "../../shared/fleet-events.js";
import fs from "node:fs";
import path from "node:path";
import { resolveFleetDataDir } from "./data-dir.js";

export interface FleetAgentEntry {
  // Keep `| string` so local custom worker ids can be registered without changing
  // the shared protocol for every experiment.
  id: FleetAgentKind | string;
  label: string;
  bin: string;
  supportsJsonl: boolean;
  enabled: boolean;
  available?: boolean;
  availability?: string;
  requiresPreset?: string;
}

export const DEFAULT_FLEET_REGISTRY: FleetAgentEntry[] = [
  { id: "lynn-cli", label: "Lynn CLI", bin: "lynn", supportsJsonl: true, enabled: true },
  { id: "stepfun-flash", label: "StepFun 3.7 Flash (fast coding)", bin: "lynn", supportsJsonl: true, enabled: true, requiresPreset: "stepfun" },
  { id: "codex-cli", label: "Codex", bin: "codex", supportsJsonl: true, enabled: true },
  { id: "claude-internal", label: "Claude (internal)", bin: "claude-internal", supportsJsonl: false, enabled: true },
  { id: "claude-code", label: "Claude Code", bin: "claude", supportsJsonl: true, enabled: true },
  { id: "qwen-cli", label: "Qwen", bin: "qwen", supportsJsonl: true, enabled: true },
  { id: "kimi-cli", label: "Kimi", bin: "kimi", supportsJsonl: true, enabled: true },
  { id: "codebuddy", label: "CodeBuddy", bin: "codebuddy", supportsJsonl: true, enabled: true },
  { id: "opencode", label: "OpenCode", bin: "opencode", supportsJsonl: false, enabled: false },
  { id: "custom", label: "Custom", bin: "", supportsJsonl: false, enabled: false },
];

export interface ResolveFleetRegistryOptions {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  fileExists?: (file: string) => boolean;
  configuredPreset?: string | null;
}

export function resolveFleetRegistry(opts: ResolveFleetRegistryOptions = {}): FleetAgentEntry[] {
  const platform = opts.platform || process.platform;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const fileExists = opts.fileExists ?? defaultFileExists;
  return DEFAULT_FLEET_REGISTRY.map((entry) => {
    if (!entry.enabled) return { ...entry, available: false, availability: "disabled" };
    if (entry.requiresPreset && entry.requiresPreset !== opts.configuredPreset) {
      return {
        ...entry,
        available: false,
        availability: `requires: Lynn providers set --preset ${entry.requiresPreset} --api-key <api-key>`,
      };
    }
    if (entry.bin === "lynn") {
      return { ...entry, available: true, availability: "bundled Lynn CLI runtime" };
    }
    if (!entry.bin) {
      return { ...entry, available: false, availability: "no command configured" };
    }
    const found = findCommand(entry.bin, { pathEnv, platform, fileExists });
    return {
      ...entry,
      enabled: !!found,
      available: !!found,
      availability: found || "not found on PATH",
    };
  });
}

export function configuredCliProviderPreset(opts: { lynnHome?: string; readFileSync?: (file: string, encoding: BufferEncoding) => string; env?: NodeJS.ProcessEnv } = {}): string | null {
  const envPreset = configuredPresetFromEnv(opts.env ?? process.env);
  if (envPreset) return envPreset;
  const lynnHome = resolveFleetDataDir(opts.lynnHome);
  const readFileSync = opts.readFileSync || fs.readFileSync;
  try {
    const parsed = JSON.parse(readFileSync(path.join(lynnHome, "providers", "cli.json"), "utf8")) as {
      baseUrl?: unknown;
      model?: unknown;
      apiKey?: unknown;
    };
    const baseUrl = typeof parsed.baseUrl === "string" ? parsed.baseUrl.replace(/\/+$/, "") : "";
    const model = typeof parsed.model === "string" ? parsed.model : "";
    const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
    if (!apiKey) return null;
    if (baseUrl === "https://api.stepfun.com/step_plan/v1" && model === "step-3.7-flash") return "stepfun";
    return null;
  } catch {
    return null;
  }
}

function configuredPresetFromEnv(env: NodeJS.ProcessEnv): string | null {
  const preset = env.LYNN_CLI_PRESET || env.OPENAI_COMPATIBLE_PRESET || "";
  const apiKey = env.LYNN_CLI_API_KEY || env.OPENAI_API_KEY || "";
  if (preset && apiKey.trim()) return preset.trim().toLowerCase();
  const baseUrl = (env.LYNN_CLI_BASE_URL || env.OPENAI_BASE_URL || "").replace(/\/+$/, "");
  const model = env.LYNN_CLI_MODEL || "";
  if (!apiKey.trim()) return null;
  if (baseUrl === "https://api.stepfun.com/step_plan/v1" && model === "step-3.7-flash") return "stepfun";
  return null;
}

function findCommand(
  bin: string,
  opts: Required<Pick<ResolveFleetRegistryOptions, "pathEnv" | "platform" | "fileExists">>,
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
