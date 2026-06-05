import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { type ParsedArgs, getStringFlag, hasFlag } from "../args.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { currentLang, t } from "../i18n.js";
import { fetchLocalServerJson, readLocalServerInfo, type LocalServerLookup } from "../local-server.js";
import {
  deleteCliProviderProfile,
  providerProfilePath,
  readCliProviderProfile,
  redactApiKey,
  resolveCliProviderProfile,
  validateCliProviderProfile,
  writeCliProviderProfile,
  type CliProviderProfile,
} from "../provider-profile.js";
import { resolveDataDir } from "../session/store.js";
import { listProviderPresets, modelDisplayName, modelLabelWithId, resolveProviderPreset } from "../provider-presets.js";
import { chatCompletionsUrl } from "../brain-client.js";
import { fetchBrainProviderStatus, summarizeBrainProviderStatus, type BrainProviderStatus } from "../brain-status.js";
import type { ProviderPreset } from "../provider-presets.js";
import { defaultBrainUrl, resolveDefaultBrainUrl } from "../brain-url.js";

export interface ProvidersInfo {
  defaultRoute: string;
  byokEntry: string;
  keyPolicy: string;
  brainUrl: string;
  brainProviders?: BrainProviderStatus | null;
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
  presets?: Array<{ name: string } & ProviderPreset>;
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

export interface ProviderTestResult {
  ok: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  ms: number;
  status?: number;
  error?: string;
  contentPreview?: string;
}

export interface BrainModelChoice {
  id: "stepfun" | "spark";
  name: string;
  routeRole: { zh: string; en: string };
  capability: { zh: string; en: string };
}

export const BRAIN_MODEL_CHOICES: BrainModelChoice[] = [
  {
    id: "stepfun",
    name: "StepFun 3.7 Flash",
    routeRole: { zh: "1 / 默认首位", en: "1 / default head" },
    capability: { zh: "256K 上下文 + high 推理 + 高 TPS 文本/编码", en: "256K context + high reasoning + high TPS text/coding" },
  },
  {
    id: "spark",
    name: "Spark Qwen 3.6 35B A3B",
    routeRole: { zh: "2 / 本地兜底", en: "2 / local fallback" },
    capability: { zh: "本地隐私 + 零 API 成本", en: "local privacy + zero API cost" },
  },
];

export function providersInfo(partial: Partial<ProvidersInfo> = {}): ProvidersInfo {
  return {
    defaultRoute: t("providers.route.default"),
    byokEntry: t("providers.byok.gui"),
    keyPolicy: t("providers.keyPolicy"),
    brainUrl: process.env.LYNN_BRAIN_URL || defaultBrainUrl(),
    server: { status: "missing", message: "Lynn client GUI server-info.json not found" },
    providers: [],
    presets: listProviderPresets(),
    ...partial,
  };
}

export function renderBrainModelChoices(info: ProvidersInfo): string {
  const current = activeRouteLabel(info);
  const lang = currentLang();
  return [
    t("models.title"),
    "",
    t("models.defaultOrder"),
    ...BRAIN_MODEL_CHOICES.map((choice) => `  ${choice.id.padEnd(7)} ${choice.name.padEnd(26)} ${choice.routeRole[lang]} · ${choice.capability[lang]}`),
    "",
    `${t("models.currentRoute")}: ${current}`,
    `${t("models.brainRoute")}:   ${summarizeBrainProviderStatus(info.brainProviders || null)}`,
    "",
    t("models.note.fixed"),
    t("models.note.byok"),
    "  /model stepfun  StepFun 3.7 Flash",
    "  /model spark    Spark Qwen 3.6 35B A3B",
  ].join("\n");
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
    `${t("providers.currentRoute")}: ${active}`,
    `${t("providers.defaultRoute")}: ${info.defaultRoute}`,
    `${t("providers.brainUrl")}:      ${info.brainUrl}`,
    `${t("providers.brainRoute")}:    ${summarizeBrainProviderStatus(info.brainProviders || null)}`,
    `${t("providers.localServer")}:   ${serverLine}`,
    `${t("providers.byokEntry")}:     ${info.byokEntry}`,
    `${t("providers.cliByok")}:       ${cliProviderLine}`,
    configured.length > 0
      ? `${t("providers.configured")}:    ${configured.slice(0, 6).map((p) => `${p.displayName}${p.modelCount ? ` (${p.modelCount})` : ""}`).join(", ")}${configured.length > 6 ? ` +${configured.length - 6}` : ""}`
      : `${t("providers.configured")}:    ${t("providers.none")}`,
    "",
    info.keyPolicy,
    "",
    t("providers.defaultNote"),
    t("providers.clientNote"),
    t("providers.cliNote"),
    "  Lynn providers set --base-url https://api.example.com/v1 --api-key <api-key> --model model-id",
    "  Lynn providers set --preset stepfun --api-key <api-key>",
    "  LYNN_CLI_PRESET=stepfun LYNN_CLI_API_KEY=<api-key> Lynn -p \"hello\"",
    "  Lynn providers test",
    "  Lynn providers presets",
    t("providers.routeHint"),
  ].join("\n");
}

export function activeRouteLabel(info: Pick<ProvidersInfo, "activeProvider" | "activeModel" | "defaultRoute">): string {
  if (info.activeModel === "lynn-brain-router") return t("providers.route.default");
  if (info.activeModel) return modelLabelWithId(info.activeModel);
  if (info.activeProvider === "brain" || info.activeProvider === "lynn-brain-router") return t("providers.route.default");
  if (info.activeProvider) return modelDisplayName(info.activeProvider);
  return info.defaultRoute;
}

export async function resolveProvidersInfo(args: ParsedArgs, timeoutMs = 1500): Promise<ProvidersInfo> {
  const brainUrl = await resolveDefaultBrainUrl(args);
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
    brainProviders: await fetchBrainProviderStatus(brainUrl, timeoutMs),
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
  const subcommand = (args.positionals[0] || "").toLowerCase();
  if (subcommand === "presets") {
    const presets = listProviderPresets();
    if (json) {
      writeJsonLine({ type: "providers.presets", ts: nowIso(), presets });
    } else {
      process.stdout.write(`${renderProviderPresets(presets)}\n`);
    }
    return 0;
  }

  if (subcommand === "test") {
    const resolved = await resolveCliProviderProfile(args);
    if (!resolved) {
      const payload = {
        type: "providers.test",
        ts: nowIso(),
        ok: false,
        error: t("providers.test.noProfile"),
      };
      if (json) writeJsonLine(payload);
      else process.stdout.write(`${payload.error}\n\n${t("providers.test.hint")}\n`);
      return 2;
    }
    const result = await testCliProviderProfile(
      resolved.profile,
      Number(getStringFlag(args.flags, "timeout-ms") || 10_000),
    );
    if (json) writeJsonLine({ type: "providers.test", ts: nowIso(), source: resolved.source, ...result });
    else process.stdout.write(`${renderProviderTestResult(result)}\n`);
    return result.ok ? 0 : 1;
  }

  if (subcommand === "unset" || subcommand === "clear" || subcommand === "reset") {
    const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
    const result = await deleteCliProviderProfile(dataDir);
    const payload = {
      type: "providers.unset",
      ts: nowIso(),
      ok: true,
      deleted: result.deleted,
      path: result.path,
    };
    if (json) writeJsonLine(payload);
    else {
      process.stdout.write([
        result.deleted ? t("providers.unset.deleted") : t("providers.unset.missing"),
        `${t("providers.unset.path")}: ${result.path}`,
        "",
        t("providers.unset.hint"),
      ].join("\n") + "\n");
    }
    return 0;
  }

  if (subcommand === "set") {
    const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
    const existing = await readCliProviderProfile(dataDir);
    const interactiveProfile = await maybePromptProviderProfile(args, existing, json);
    const preset = resolveProviderPreset(getStringFlag(args.flags, "preset"));
    const profile = validateCliProviderProfile({
      provider: getStringFlag(args.flags, "provider") || interactiveProfile?.provider || preset?.provider || existing?.provider || "openai-compatible",
      baseUrl: getStringFlag(args.flags, "base-url", "api-base") || interactiveProfile?.baseUrl || preset?.baseUrl || existing?.baseUrl || "",
      apiKey: getStringFlag(args.flags, "api-key") || interactiveProfile?.apiKey || existing?.apiKey,
      model: getStringFlag(args.flags, "model") || interactiveProfile?.model || preset?.model || existing?.model || "",
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
        t("providers.saved"),
        `provider: ${profile.provider}`,
        `model:    ${profile.model}`,
        `baseUrl:  ${profile.baseUrl}`,
        `apiKey:   ${redactApiKey(profile.apiKey)}`,
        `path:     ${providerProfilePath(dataDir)}`,
        "",
        t("providers.savedHint"),
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

export async function testCliProviderProfile(profile: CliProviderProfile, timeoutMs = 10_000): Promise<ProviderTestResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, Math.min(timeoutMs, 60_000)));
  try {
    const response = await fetch(chatCompletionsUrl(profile.baseUrl), {
      method: "POST",
      headers: providerTestHeaders(profile),
      body: JSON.stringify({
        model: profile.model,
        stream: false,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    const ms = Date.now() - started;
    if (!response.ok) {
      return {
        ok: false,
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        model: profile.model,
        ms,
        status: response.status,
        error: `${response.status} ${response.statusText}${text ? ` · ${text.slice(0, 240)}` : ""}`.trim(),
      };
    }
    return {
      ok: true,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      ms,
      status: response.status,
      contentPreview: providerTestContentPreview(text),
    };
  } catch (error) {
    return {
      ok: false,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function renderProviderTestResult(result: ProviderTestResult): string {
  const route = `${result.provider} / ${result.model} @ ${result.baseUrl}`;
  if (result.ok) {
    return [
      `${t("providers.test.ok")}: ${route}`,
      `${t("providers.test.latency")}: ${result.ms}ms${result.status ? ` · HTTP ${result.status}` : ""}`,
      result.contentPreview ? `${t("providers.test.preview")}: ${result.contentPreview}` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    `${t("providers.test.fail")}: ${route}`,
    `${t("providers.test.latency")}: ${result.ms}ms${result.status ? ` · HTTP ${result.status}` : ""}`,
    `${t("providers.test.error")}: ${result.error || "unknown error"}`,
    t("providers.test.hint"),
  ].join("\n");
}

export function renderProviderPresets(presets = listProviderPresets()): string {
  return [
    t("providers.presets.title"),
    "",
    ...presets.flatMap((preset) => [
      `${preset.name} — ${preset.displayName}`,
      `  ${t("providers.presets.model")}: ${modelLabelWithId(preset.model)}`,
      `  ${t("providers.presets.url")}:   ${preset.baseUrl}`,
      `  ${t("providers.presets.about")}: ${preset.description}`,
      `  ${t("providers.presets.use")}:   Lynn providers set --preset ${preset.name} --api-key <api-key>`,
      "",
    ]),
    t("providers.presets.note"),
  ].join("\n").trimEnd();
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

function providerTestHeaders(profile: CliProviderProfile): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (profile.apiKey) headers.authorization = `Bearer ${profile.apiKey}`;
  return headers;
}

function providerTestContentPreview(text: string): string | undefined {
  if (!text.trim()) return undefined;
  try {
    const parsed = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
    };
    const content = parsed.choices?.find(Boolean)?.message?.content ?? parsed.choices?.find(Boolean)?.text;
    return typeof content === "string" && content.trim() ? content.trim().slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
}

async function maybePromptProviderProfile(args: ParsedArgs, existing: CliProviderProfile | null, json: boolean): Promise<CliProviderProfile | null> {
  if (json || !input.isTTY || !output.isTTY || hasProviderSetFlags(args)) return null;
  let rl = readline.createInterface({ input, output, terminal: true });
  try {
    output.write(`${t("providers.wizard.title")}\n`);
    output.write(`\n${t("providers.wizard.step1")}\n`);
    output.write(`${t("providers.wizard.step1.help")}\n`);
    output.write(`${t("providers.wizard.step1.examples")}\n`);
    const baseUrl = await askWithDefault(rl, t("providers.wizard.baseUrl"), existing?.baseUrl || "https://api.openai.com/v1");
    rl.close();
    output.write(`\n${t("providers.wizard.step2")}\n`);
    output.write(`${t("providers.wizard.step2.help")}\n`);
    const apiKeyPrompt = existing?.apiKey
      ? t("providers.wizard.apiKey.keep", { key: redactApiKey(existing.apiKey) })
      : `${t("providers.wizard.apiKey")} `;
    const apiKeyAnswer = (await askSecretLine(apiKeyPrompt)).trim();
    rl = readline.createInterface({ input, output, terminal: true });
    output.write(`\n${t("providers.wizard.step3")}\n`);
    output.write(`${t("providers.wizard.step3.help")}\n`);
    const model = await askWithDefault(rl, t("providers.wizard.model"), existing?.model || "");
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

function askSecretLine(label: string): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    const wasRaw = input.isRaw;
    const cleanup = () => {
      input.off("data", onData);
      if (typeof input.setRawMode === "function") input.setRawMode(wasRaw);
      output.write("\n");
    };
    const finish = () => {
      cleanup();
      resolve(buffer);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return;
        }
        if (ch === "\u0003" || ch === "\u0004") {
          buffer = "";
          finish();
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buffer = buffer.slice(0, -1);
          continue;
        }
        if (ch >= " ") buffer += ch;
      }
    };
    if (typeof input.setRawMode === "function") input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    output.write(label);
  });
}

function hasProviderSetFlags(args: ParsedArgs): boolean {
  return !!(
    getStringFlag(args.flags, "provider")
    || getStringFlag(args.flags, "preset")
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
