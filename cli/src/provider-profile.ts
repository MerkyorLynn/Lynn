import fs from "node:fs/promises";
import path from "node:path";
import { getStringFlag, type ParsedArgs } from "./args.js";
import { resolveProviderPreset } from "./provider-presets.js";
import { resolveDataDir } from "./session/store.js";

export interface CliProviderProfile {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface ResolvedCliProviderProfile {
  profile: CliProviderProfile;
  source: "flags" | "env" | "file";
}

export function providerProfilePath(dataDir: string): string {
  return path.join(dataDir, "providers", "cli.json");
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function redactApiKey(apiKey?: string): string {
  if (!apiKey) return "(none)";
  if (apiKey.length <= 8) return "********";
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

export async function readCliProviderProfile(dataDir: string): Promise<CliProviderProfile | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(providerProfilePath(dataDir), "utf8")) as Partial<CliProviderProfile>;
    const provider = stringValue(parsed.provider) || "openai-compatible";
    const baseUrl = stringValue(parsed.baseUrl);
    const model = stringValue(parsed.model);
    if (!baseUrl || !model) return null;
    const apiKey = stringValue(parsed.apiKey);
    return {
      provider,
      baseUrl: normalizeBaseUrl(baseUrl),
      model,
      apiKey,
    };
  } catch {
    return null;
  }
}

export async function writeCliProviderProfile(dataDir: string, profile: CliProviderProfile): Promise<void> {
  const normalized = validateCliProviderProfile(profile);
  const target = providerProfilePath(dataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

export async function deleteCliProviderProfile(dataDir: string): Promise<{ path: string; deleted: boolean }> {
  const target = providerProfilePath(dataDir);
  try {
    await fs.stat(target);
    await fs.rm(target, { force: true });
    return { path: target, deleted: true };
  } catch {
    return { path: target, deleted: false };
  }
}

export function validateCliProviderProfile(profile: CliProviderProfile): CliProviderProfile {
  const provider = profile.provider.trim() || "openai-compatible";
  const baseUrl = normalizeBaseUrl(profile.baseUrl);
  const model = profile.model.trim();
  const apiKey = profile.apiKey?.trim();
  if (!baseUrl) throw new Error("CLI provider --base-url is required");
  if (!model) throw new Error("CLI provider --model is required");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("CLI provider --base-url must start with http:// or https://");
  return { provider, baseUrl, model, apiKey: apiKey || undefined };
}

export async function resolveCliProviderProfile(args: ParsedArgs): Promise<ResolvedCliProviderProfile | null> {
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  const fileProfile = await readCliProviderProfile(dataDir);
  const envProfile = readEnvProviderProfile();
  const flagProfile = readFlagProviderProfile(args);
  if (flagProfile) {
    const presetName = getStringFlag(args.flags, "preset");
    const fallbackApiKey =
      matchingStoredApiKey(flagProfile, fileProfile)
      || matchingEnvApiKey(flagProfile, envProfile)
      || presetApiKey(presetName, process.env)
      || genericEnvApiKey(presetName, process.env);
    return { profile: validateCliProviderProfile({ ...flagProfile, apiKey: flagProfile.apiKey || fallbackApiKey }), source: "flags" };
  }
  if (envProfile) return { profile: validateCliProviderProfile(envProfile), source: "env" };
  return fileProfile ? { profile: fileProfile, source: "file" } : null;
}

export function readFlagProviderProfile(args: ParsedArgs): CliProviderProfile | null {
  const preset = resolveProviderPreset(getStringFlag(args.flags, "preset"));
  const baseUrl = getStringFlag(args.flags, "base-url", "api-base") || preset?.baseUrl || null;
  const model = getStringFlag(args.flags, "model") || preset?.model || null;
  const apiKey = getStringFlag(args.flags, "api-key");
  const provider = getStringFlag(args.flags, "provider") || preset?.provider || "openai-compatible";
  if (!baseUrl && !model && !apiKey && !preset) return null;
  return {
    provider,
    baseUrl: baseUrl || "",
    model: model || "",
    apiKey: apiKey || undefined,
  };
}

export function readEnvProviderProfile(env: NodeJS.ProcessEnv = process.env): CliProviderProfile | null {
  const presetName = env.LYNN_CLI_PRESET || env.OPENAI_COMPATIBLE_PRESET || null;
  const preset = resolveProviderPreset(presetName);
  const baseUrl = env.LYNN_CLI_BASE_URL || env.OPENAI_BASE_URL || preset?.baseUrl || "";
  const model = env.LYNN_CLI_MODEL || preset?.model || "";
  const apiKey = env.LYNN_CLI_API_KEY || presetApiKey(presetName, env) || genericEnvApiKey(presetName, env) || "";
  const provider = env.LYNN_CLI_PROVIDER || preset?.provider || "openai-compatible";
  if (!baseUrl || !model) return null;
  return {
    provider,
    baseUrl,
    model,
    apiKey: apiKey || undefined,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function matchingStoredApiKey(flagProfile: CliProviderProfile, fileProfile: CliProviderProfile | null): string | undefined {
  if (!fileProfile?.apiKey) return undefined;
  if (fileProfile.provider !== flagProfile.provider) return undefined;
  if (normalizeBaseUrl(fileProfile.baseUrl) !== normalizeBaseUrl(flagProfile.baseUrl)) return undefined;
  if (fileProfile.model !== flagProfile.model) return undefined;
  return fileProfile.apiKey;
}

function matchingEnvApiKey(flagProfile: CliProviderProfile, envProfile: CliProviderProfile | null): string | undefined {
  if (!envProfile?.apiKey) return undefined;
  if (envProfile.provider !== flagProfile.provider) return undefined;
  if (normalizeBaseUrl(envProfile.baseUrl) !== normalizeBaseUrl(flagProfile.baseUrl)) return undefined;
  if (envProfile.model !== flagProfile.model) return undefined;
  return envProfile.apiKey;
}

function presetApiKey(presetName: string | null, env: NodeJS.ProcessEnv): string | undefined {
  switch ((presetName || "").trim().toLowerCase()) {
    case "stepfun":
      return env.STEPFUN_API_KEY || env.STEP_API_KEY || undefined;
    case "spark":
      return env.SPARK_API_KEY || env.APEX_SPARK_API_KEY || undefined;
    case "deepseek":
      return env.DEEPSEEK_API_KEY || undefined;
    case "openai":
      return env.OPENAI_API_KEY || undefined;
    default:
      return undefined;
  }
}

function genericEnvApiKey(presetName: string | null, env: NodeJS.ProcessEnv): string | undefined {
  const normalizedPreset = (presetName || "").trim().toLowerCase();
  if (normalizedPreset && normalizedPreset !== "openai") return undefined;
  return env.OPENAI_API_KEY || undefined;
}
