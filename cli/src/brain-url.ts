import { getStringFlag, type ParsedArgs } from "./args.js";

export const LOCAL_BRAIN_URL = "http://127.0.0.1:8790";
export const HOSTED_BRAIN_URL = "https://api.merkyorlynn.com/api/v2";

export function configuredBrainUrl(args?: ParsedArgs): string | null {
  return getStringFlag(args?.flags || {}, "brain-url") || process.env.LYNN_BRAIN_URL || null;
}

export function defaultBrainUrl(): string {
  return process.env.LYNN_CLI_DISABLE_HOSTED_BRAIN === "1" ? LOCAL_BRAIN_URL : HOSTED_BRAIN_URL;
}

export async function resolveDefaultBrainUrl(args?: ParsedArgs, timeoutMs = 500): Promise<string> {
  const explicit = configuredBrainUrl(args);
  if (explicit) return explicit;
  if (process.env.LYNN_CLI_DISABLE_HOSTED_BRAIN === "1") return LOCAL_BRAIN_URL;
  if (await canReachBrain(HOSTED_BRAIN_URL, timeoutMs)) return HOSTED_BRAIN_URL;
  if (await canReachBrain(LOCAL_BRAIN_URL, timeoutMs)) return LOCAL_BRAIN_URL;
  return HOSTED_BRAIN_URL;
}

export function brainEndpointUrl(brainUrl: string, endpointPath: string): URL {
  const base = new URL(brainUrl.endsWith("/") ? brainUrl : `${brainUrl}/`);
  const basePath = base.pathname.replace(/\/+$/, "");
  const cleanEndpoint = endpointPath.replace(/^\/+/, "");
  base.pathname = `${basePath}/${cleanEndpoint}`.replace(/\/{2,}/g, "/");
  return base;
}

async function canReachBrain(brainUrl: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(brainEndpointUrl(brainUrl, "/health"), { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
