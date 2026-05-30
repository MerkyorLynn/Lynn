import { modelDisplayName } from "./provider-presets.js";
import { brainEndpointUrl } from "./brain-url.js";

export interface BrainProviderStatusEntry {
  id: string;
  model: string;
  endpoint: string;
  wire: string;
  credential: "set" | "missing" | "not_required";
  configured: boolean;
  local: boolean;
  inRoute: boolean;
}

export interface BrainProviderStatus {
  ok: true;
  route: string[];
  providers: BrainProviderStatusEntry[];
}

export interface BrainRouteReadiness {
  usable: boolean;
  headReady: boolean;
  headId?: string;
  readyProviders: string[];
  missingProviders: string[];
  summary: string;
  message: string;
}

export async function fetchBrainProviderStatus(brainUrl: string, timeoutMs = 1500): Promise<BrainProviderStatus | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(brainEndpointUrl(brainUrl, "/v1/providers/status"), { signal: ctrl.signal });
    if (!res.ok) return null;
    const parsed = await res.json() as Partial<BrainProviderStatus>;
    if (parsed?.ok !== true || !Array.isArray(parsed.route) || !Array.isArray(parsed.providers)) return null;
    return parsed as BrainProviderStatus;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function summarizeBrainProviderStatus(status: BrainProviderStatus | null): string {
  if (!status) return "provider status unavailable";
  const byId = new Map(status.providers.map((provider) => [provider.id, provider]));
  const route = status.route.slice(0, 6).map((id) => {
    const provider = byId.get(id);
    const label = modelDisplayName(provider?.model || id);
    if (!provider) return `${label}:unknown`;
    if (provider.credential === "set") return `${label}:key`;
    if (provider.credential === "not_required") return `${label}:local`;
    return `${label}:missing-key`;
  });
  return route.join(" -> ");
}

export function brainRouteHeadReady(status: BrainProviderStatus | null): boolean {
  return brainRouteReadiness(status).headReady;
}

export function brainRouteUsable(status: BrainProviderStatus | null): boolean {
  return brainRouteReadiness(status).usable;
}

export function brainRouteReadiness(status: BrainProviderStatus | null): BrainRouteReadiness {
  const summary = summarizeBrainProviderStatus(status);
  if (!status) {
    return {
      usable: false,
      headReady: false,
      readyProviders: [],
      missingProviders: [],
      summary,
      message: summary,
    };
  }
  if (!status.route.length) {
    return {
      usable: false,
      headReady: false,
      readyProviders: [],
      missingProviders: [],
      summary,
      message: "provider route is empty",
    };
  }

  const byId = new Map(status.providers.map((provider) => [provider.id, provider]));
  const headId = status.route[0];
  const readyProviders = status.route.filter((id) => byId.get(id)?.configured);
  const missingProviders = status.route.filter((id) => !byId.get(id)?.configured);
  const headReady = Boolean(byId.get(headId)?.configured);
  const usable = readyProviders.length > 0;
  const labelFor = (id: string): string => {
    const provider = byId.get(id);
    return modelDisplayName(provider?.model || id);
  };

  let detail = "";
  if (!usable) {
    detail = "no configured provider in route; configure MiMo/StepFun in the Lynn client or CLI BYOK";
  } else if (!headReady) {
    detail = `head ${labelFor(headId)} not configured; fallback ready: ${readyProviders.map(labelFor).join(", ")}`;
  } else {
    const fallbacks = readyProviders.slice(1).map(labelFor);
    detail = fallbacks.length > 0
      ? `head ready: ${labelFor(headId)}; fallback ready: ${fallbacks.join(", ")}`
      : `head ready: ${labelFor(headId)}`;
  }

  return {
    usable,
    headReady,
    headId,
    readyProviders,
    missingProviders,
    summary,
    message: `${summary} (${detail})`,
  };
}
