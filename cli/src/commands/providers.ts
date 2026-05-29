import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { type ParsedArgs, getStringFlag, hasFlag } from "../args.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { t } from "../i18n.js";
import { fetchLocalServerJson, readLocalServerInfo, type LocalServerLookup } from "../local-server.js";
import {
  providerProfilePath,
  readCliProviderProfile,
  redactApiKey,
  resolveCliProviderProfile,
  validateCliProviderProfile,
  writeCliProviderProfile,
  type CliProviderProfile,
} from "../provider-profile.js";
import { resolveDataDir } from "../session/store.js";

export interface ProvidersInfo {
  defaultRoute: string;
  byokEntry: string;
  keyPolicy: string;
  brainUrl: string;
  server: {
    status: LocalServerLookup["status"] | "disabled";
    url?: string;
    version?: string;
    message?: string;
  };
  activeProvider?: string;
  activeModel?: string;
  cliProvider?: {
    configured: boolean;
    source?: string;
    profile?: CliProviderProfile;
    path?: string;
  };
  providers: ProviderLine[];
}

export interface ProviderLine {
  id: string;
  displayName: string;
  type: string;
  configured: boolean;
  modelCount: number;
  oauth?: boolean;
  codingPlan?: boolean;
}

export function providersInfo(partial: Partial<ProvidersInfo> = {}): ProvidersInfo {
  return {
    defaultRoute: t("providers.route.default"),
    byokEntry: t("providers.byok.gui"),
    keyPolicy: t("providers.keyPolicy"),
    brainUrl: process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790",
    server: { status: "missing", message: "Lynn client GUI server-info.json not found" },
    providers: [],
    ...partial,
  };
}

export function renderProvidersInfo(info: ProvidersInfo): string {
  const active = activeRouteLabel(info);
  const serverLine = info.server.url
    ? `${info.server.status} · ${info.server.url}${info.server.version ? ` · v${info.server.version}` : ""}`
    : `${info.server.status}${info.server.message ? ` · ${info.server.message}` : ""}`;
  const configured = info.providers.filter((p) => p.configured);
  const cliProviderLine = info.cliProvider?.configured && info.cliProvider.profile
    ? `${info.cliProvider.profile.provider} / ${info.cliProvider.profile.model} @ ${info.cliProvider.profile.baseUrl} (${info.cliProvider.source || "file"}, key ${redactApiKey(info.cliProvider.profile.apiKey)})`
    : `not set${info.cliProvider?.path ? ` · ${info.cliProvider.path}` : ""}`;
  return [
    t("providers.title"),
    "",
    `Current route: ${active}`,
    `Default route: ${info.defaultRoute}`,
    `Brain URL:      ${info.brainUrl}`,
    `Local server:   ${serverLine}`,
    `BYOK entry:     ${info.byokEntry}`,
    `CLI BYOK:       ${cliProviderLine}`,
    configured.length > 0
      ? `Configured:    ${configured.slice(0, 6).map((p) => `${p.displayName}${p.modelCount ? ` (${p.modelCount})` : ""}`).join(", ")}${configured.length > 6 ? ` +${configured.length - 6}` : ""}`
      : "Configured:    none detected yet",
    "",
    info.keyPolicy,
    "",
    t("providers.guide"),
  ].join("\n");
}

export function activeRouteLabel(info: Pick<ProvidersInfo, "activeProvider" | "activeModel" | "defaultRoute">): string {
  return [info.activeProvider, info.activeModel].filter(Boolean).join(" / ") || info.defaultRoute;
}

export async function resolveProvidersInfo(args: ParsedArgs, timeoutMs = 1500): Promise<ProvidersInfo> {
  const brainUrl = getStringFlag(args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const dataDir = getStringFlag(args.flags, "data-dir");
  const serverUrl = getStringFlag(args.flags, "server-url") || process.env.LYNN_SERVER_URL || "";
  let lookup: LocalServerLookup = serverUrl
    ? { status: "ok", url: serverUrl }
    : await readLocalServerInfo(dataDir);
  if (lookup.url && !/^https?:\/\//i.test(lookup.url)) {
    lookup = { ...lookup, url: `http://${lookup.url}` };
  }
  const resolvedCliProvider = await resolveCliProviderProfile(args);
  const base = providersInfo({
    brainUrl,
    byokEntry: resolvedCliProvider
      ? t("providers.byok.configured")
      : t("providers.byok.unconfigured"),
    server: {
      status: lookup.status,
      url: lookup.url,
      version: lookup.version,
      message: lookup.message,
    },
    cliProvider: {
      configured: !!resolvedCliProvider,
      source: resolvedCliProvider?.source,
      profile: resolvedCliProvider?.profile,
      path: providerProfilePath(resolveDataDir(dataDir)),
    },
  });

  if (lookup.status !== "ok") return base;

  try {
    const [summary, config] = await Promise.all([
      fetchLocalServerJson<ProviderSummaryResponse>(lookup, "/api/providers/summary", timeoutMs),
      fetchLocalServerJson<Record<string, unknown>>(lookup, "/api/config", timeoutMs).catch(() => null),
    ]);
    return {
      ...base,
      activeProvider: readActiveProvider(config),
      activeModel: readActiveModel(config),
      providers: sanitizeProviderSummary(summary),
    };
  } catch (error) {
    return {
      ...base,
      server: {
        ...base.server,
        status: "unreachable",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function runProviders(args: ParsedArgs, json = hasFlag(args.flags, "json", "jsonl")): Promise<number> {
  if ((args.positionals[0] || "").toLowerCase() === "set") {
    const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
    const existing = await readCliProviderProfile(dataDir);
    const interactiveProfile = await maybePromptProviderProfile(args, existing, json);
    const profile = validateCliProviderProfile({
      provider: getStringFlag(args.flags, "provider") || interactiveProfile?.provider || existing?.provider || "openai-compatible",
      baseUrl: getStringFlag(args.flags, "base-url", "api-base") || interactiveProfile?.baseUrl || existing?.baseUrl || "",
      apiKey: getStringFlag(args.flags, "api-key") || interactiveProfile?.apiKey || existing?.apiKey,
      model: getStringFlag(args.flags, "model") || interactiveProfile?.model || existing?.model || "",
    });
    await writeCliProviderProfile(dataDir, profile);
    const payload = {
      type: "providers.saved",
      ts: nowIso(),
      path: providerProfilePath(dataDir),
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: redactApiKey(profile.apiKey),
    };
    if (json) writeJsonLine(payload);
    else {
      process.stdout.write([
        "Saved CLI BYOK provider.",
        `provider: ${profile.provider}`,
        `model:    ${profile.model}`,
        `baseUrl:  ${profile.baseUrl}`,
        `apiKey:   ${redactApiKey(profile.apiKey)}`,
        `path:     ${providerProfilePath(dataDir)}`,
        "",
        "When Lynn client GUI/Brain is offline, Lynn CLI will use this provider as a direct fallback.",
      ].join("\n") + "\n");
    }
    return 0;
  }
  const info = await resolveProvidersInfo(args);
  if (json) {
    writeJsonLine({ type: "providers.info", ts: nowIso(), ...info });
  } else {
    process.stdout.write(`${renderProvidersInfo(info)}\n`);
  }
  return 0;
}

interface ProviderSummaryResponse {
  providers?: Record<string, {
    display_name?: string;
    type?: string;
    has_credentials?: boolean;
    logged_in?: boolean;
    supports_oauth?: boolean;
    is_coding_plan?: boolean;
    models?: unknown[];
    custom_models?: unknown[];
  }>;
}

function sanitizeProviderSummary(response: ProviderSummaryResponse): ProviderLine[] {
  return Object.entries(response.providers || {})
    .map(([id, provider]) => {
      const modelCount = (Array.isArray(provider.models) ? provider.models.length : 0)
        + (Array.isArray(provider.custom_models) ? provider.custom_models.length : 0);
      return {
        id,
        displayName: String(provider.display_name || id),
        type: String(provider.type || "api-key"),
        configured: !!(provider.has_credentials || provider.logged_in),
        modelCount,
        oauth: !!provider.supports_oauth,
        codingPlan: !!provider.is_coding_plan,
      };
    })
    .sort((a, b) => Number(b.configured) - Number(a.configured) || a.displayName.localeCompare(b.displayName));
}

async function maybePromptProviderProfile(args: ParsedArgs, existing: CliProviderProfile | null, json: boolean): Promise<CliProviderProfile | null> {
  if (json || !input.isTTY || !output.isTTY || hasProviderSetFlags(args)) return null;
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    output.write("Lynn CLI BYOK setup (OpenAI-compatible)\n");
    output.write("\nStep 1/3: API URL\n");
    output.write("Paste the OpenAI-compatible base URL from your provider docs. It usually ends with /v1.\n");
    output.write("Examples: https://api.openai.com/v1, https://api.deepseek.com/v1, https://dashscope.aliyuncs.com/compatible-mode/v1\n");
    const baseUrl = await askWithDefault(rl, "API URL", existing?.baseUrl || "https://api.openai.com/v1");
    output.write("\nStep 2/3: API Key\n");
    output.write("Create or copy an API key from your provider console. Lynn stores it locally and redacts it in terminal output.\n");
    const apiKeyPrompt = existing?.apiKey ? `API Key [keep ${redactApiKey(existing.apiKey)}] ` : "API Key ";
    const apiKeyAnswer = (await rl.question(apiKeyPrompt)).trim();
    output.write("\nStep 3/3: Model name\n");
    output.write("Copy the exact model id from your provider's model list, for example gpt-4o, deepseek-chat, qwen-plus, or your custom model id.\n");
    const model = await askWithDefault(rl, "Model name", existing?.model || "");
    return {
      provider: existing?.provider || "openai-compatible",
      baseUrl,
      apiKey: apiKeyAnswer || existing?.apiKey,
      model,
    };
  } finally {
    rl.close();
  }
}

function hasProviderSetFlags(args: ParsedArgs): boolean {
  return !!(
    getStringFlag(args.flags, "provider")
    || getStringFlag(args.flags, "base-url", "api-base")
    || getStringFlag(args.flags, "api-key")
    || getStringFlag(args.flags, "model")
  );
}

async function askWithDefault(rl: readline.Interface, label: string, defaultValue: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}] ` : " ";
  const answer = (await rl.question(`${label}${suffix}`)).trim();
  return answer || defaultValue;
}

function readActiveProvider(config: Record<string, unknown> | null): string | undefined {
  const raw = readRecord(readRecord(config, "_raw"), "api");
  const rawProvider = stringValue(raw?.provider);
  if (rawProvider) return rawProvider;
  return stringValue(readRecord(config, "api")?.provider);
}

function readActiveModel(config: Record<string, unknown> | null): string | undefined {
  const chat = readRecord(config, "models")?.chat;
  if (typeof chat === "string") return chat;
  if (chat && typeof chat === "object" && !Array.isArray(chat)) {
    return stringValue((chat as Record<string, unknown>).id);
  }
  return undefined;
}

function readRecord(record: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
