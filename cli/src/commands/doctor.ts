import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { listProviderPresets } from "../provider-presets.js";
import { providerProfilePath, readCliProviderProfile, redactApiKey } from "../provider-profile.js";
import { resolveDataDir } from "../session/store.js";
import { readVersionInfo } from "../version.js";
import { brainRouteReadiness, fetchBrainProviderStatus, type BrainProviderStatus } from "../brain-status.js";
import { parseBrainStreamPayload, parseSsePayloads } from "../brain-client.js";
import { signedBrainHeaders } from "../brain-auth.js";
import { brainEndpointUrl, resolveDefaultBrainUrl } from "../brain-url.js";

export interface DoctorResult {
  ok: boolean;
  version: string;
  node: string;
  brainUrl: string;
  brain: "ok" | "skipped" | "unreachable";
  brainProviders?: BrainProviderStatus | null;
  brainSmoke?: BrainRouteSmokeResult | null;
  cliProvider: {
    configured: boolean;
    path: string;
    provider?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
  presets: string[];
  checks: Array<{ name: string; ok: boolean; message: string }>;
}

export interface BrainRouteSmokeResult {
  ok: boolean;
  provider?: string;
  message: string;
}

export async function runDoctor(args: ParsedArgs): Promise<DoctorResult> {
  const version = readVersionInfo();
  const brainUrl = await resolveDefaultBrainUrl(args);
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  const profile = await readCliProviderProfile(dataDir);
  const profilePath = providerProfilePath(dataDir);
  const presets = listProviderPresets().map((preset) => `${preset.name}:${preset.model}`);
  const checks: DoctorResult["checks"] = [
    { name: "node", ok: true, message: process.version },
    { name: "cwd", ok: true, message: process.cwd() },
    profile
      ? { name: "cli-byok", ok: true, message: `${profile.provider} / ${profile.model} @ ${profile.baseUrl} (key ${redactApiKey(profile.apiKey)})` }
      : { name: "cli-byok", ok: true, message: `not configured (${profilePath}); optional CLI-only BYOK: Lynn providers set --preset stepfun --api-key <api-key>` },
    { name: "presets", ok: true, message: presets.join(", ") },
  ];

  let brain: DoctorResult["brain"] = "skipped";
  let brainProviders: BrainProviderStatus | null = null;
  let brainSmoke: BrainRouteSmokeResult | null = null;
  if (!hasFlag(args.flags, "offline")) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(brainEndpointUrl(brainUrl, "/health"), { signal: ctrl.signal });
      brain = res.ok ? "ok" : "unreachable";
      checks.push({ name: "brain", ok: res.ok, message: `${res.status} ${res.statusText}`.trim() });
      if (res.ok) {
        const providerStatus = await fetchBrainProviderStatus(brainUrl, 1500);
        brainProviders = providerStatus;
        const readiness = providerStatus
          ? brainRouteReadiness(providerStatus)
          : { usable: true, message: "provider status unavailable; verifying route with chat smoke" };
        checks.push({ name: "brain-route", ok: readiness.usable, message: readiness.message });
        if (readiness.usable) {
          if (hasFlag(args.flags, "no-route-smoke")) {
            checks.push({ name: "brain-smoke", ok: true, message: "skipped (--no-route-smoke)" });
          } else {
            brainSmoke = await smokeBrainRoute(brainUrl, 5000);
            checks.push({
              name: "brain-smoke",
              ok: brainSmoke.ok,
              message: brainSmoke.message,
            });
          }
        }
      }
    } catch (error) {
      brain = "unreachable";
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ name: "brain", ok: false, message });
    } finally {
      clearTimeout(timer);
    }
  } else {
    checks.push({ name: "brain", ok: true, message: "skipped (--offline)" });
  }

  return {
    ok: checks.every((check) => check.ok),
    version: version.version,
    node: process.version,
    brainUrl,
    brain,
    brainProviders,
    brainSmoke,
    cliProvider: {
      configured: !!profile,
      path: profilePath,
      provider: profile?.provider,
      baseUrl: profile?.baseUrl,
      model: profile?.model,
      apiKey: profile ? redactApiKey(profile.apiKey) : undefined,
    },
    presets,
    checks,
  };
}

export async function smokeBrainRoute(brainUrl: string, timeoutMs = 5000): Promise<BrainRouteSmokeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let activeProvider = "";
  try {
    const response = await fetch(brainEndpointUrl(brainUrl, "/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signedBrainHeaders({ pathname: "/v1/chat/completions" }),
      },
      body: JSON.stringify({
        model: "lynn-brain-router",
        stream: true,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with OK." }],
        extra_body: { enable_thinking: false },
      }),
      signal: ctrl.signal,
    });
    if (!response.ok) {
      return { ok: false, message: `request failed: ${response.status} ${response.statusText}`.trim() };
    }
    if (!response.body) return { ok: false, message: "request returned no response body" };

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const split = buffer.split(/\n\n+/);
      buffer = split.pop() || "";
      const verdict = inspectSmokeBlocks(split, (provider) => { activeProvider = provider || activeProvider; });
      if (verdict) return withProvider(verdict, activeProvider);
    }
    buffer += decoder.decode();
    const verdict = inspectSmokeBlocks([buffer], (provider) => { activeProvider = provider || activeProvider; });
    if (verdict) return withProvider(verdict, activeProvider);
    return { ok: false, provider: activeProvider || undefined, message: activeProvider ? `provider ${activeProvider} returned no assistant output` : "no assistant output" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, provider: activeProvider || undefined, message };
  } finally {
    clearTimeout(timer);
  }
}

function inspectSmokeBlocks(blocks: string[], onProvider: (provider: string) => void): BrainRouteSmokeResult | null {
  for (const block of blocks) {
    for (const payload of parseSsePayloads(`${block}\n\n`)) {
      for (const event of parseBrainStreamPayload(payload)) {
        if (event.type === "provider") onProvider(event.activeProvider);
        if (event.type === "brain.error") {
          return { ok: false, message: event.code ? `${event.error} (${event.code})` : event.error };
        }
        if (event.type === "assistant.delta" && event.text.trim()) {
          return { ok: true, message: "route returned assistant output" };
        }
      }
    }
  }
  return null;
}

function withProvider(result: BrainRouteSmokeResult, provider: string): BrainRouteSmokeResult {
  if (!provider) return result;
  return {
    ...result,
    provider,
    message: result.ok ? `${result.message} via ${provider}` : `${result.message} via ${provider}`,
  };
}

export function renderDoctor(result: DoctorResult): string {
  const lines = [
    `Lynn CLI ${result.version}`,
    `Node ${result.node}`,
    `Brain ${result.brain}: ${result.brainUrl}`,
    "",
    ...result.checks.map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.message}`),
  ];
  return lines.join("\n");
}
