// Brain v2 · local env loader
// Runtime configuration belongs to the local Brain process, not the CLI.
// Load ~/.lynn/brain.env by default so desktop and CLI share the same provider route.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type BrainEnvLoadResult = {
  files: string[];
  aliases: string[];
};

export type BrainEnvLoadOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  paths?: string[];
};

const LEGACY_ALIASES: Record<string, string[]> = {
  STEP37_BASE: ['STEP_BASE'],
  STEP37_KEY: ['STEP_KEY'],
  STEP37_MODEL: ['STEP_TEXT_MODEL'],
  // MiMo platform web_search (paid search — separate from the removed MiMo LLM).
  MIMO_SEARCH_BASE: ['MIMO_BASE'],
  MIMO_SEARCH_KEY: ['MIMO_KEY', 'MIMO_API_KEY'],
  MIMO_SEARCH_MODEL: ['MIMO_MODEL'],
};

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = normalized.indexOf('=');
    if (eq <= 0) continue;
    const key = normalized.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = stripQuotes(normalized.slice(eq + 1));
  }
  return out;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean).map((file) => path.resolve(file)))];
}

function defaultEnvPaths(options: Required<Pick<BrainEnvLoadOptions, 'cwd' | 'env' | 'homeDir'>>): string[] {
  const explicit = options.env.BRAIN_V2_ENV_FILE ? [options.env.BRAIN_V2_ENV_FILE] : [];
  return [
    ...explicit,
    path.join(options.homeDir, '.lynn', 'brain.env'),
    path.join(options.cwd, '.env'),
  ];
}

export function loadBrainEnvFiles(options: BrainEnvLoadOptions = {}): BrainEnvLoadResult {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const paths = uniquePaths(options.paths ?? defaultEnvPaths({ cwd, env, homeDir }));
  const loadedFiles: string[] = [];

  for (const file of paths) {
    if (!fs.existsSync(file)) continue;
    const parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) env[key] = value;
    }
    loadedFiles.push(file);
  }

  const aliases: string[] = [];
  for (const [target, sources] of Object.entries(LEGACY_ALIASES)) {
    if (env[target]) continue;
    const source = sources.find((candidate) => Boolean(env[candidate]));
    if (!source) continue;
    env[target] = env[source];
    aliases.push(`${source}->${target}`);
  }

  return { files: loadedFiles, aliases };
}

loadBrainEnvFiles();
