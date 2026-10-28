import path from "node:path";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from "../../shared/codex-app-server-client.js";
import type { CliProviderProfile } from "./provider-profile.js";
import { brainRouteUsable, fetchBrainProviderStatus } from "./brain-status.js";
import { startCodexResponsesProxy } from "./codex-responses-proxy.js";
import type { ReasoningOptions } from "./reasoning.js";
import { readVersionInfo } from "./version.js";

export type CodeHarnessMode = "auto" | "legacy" | "codex";
export type SelectedCodeHarness = "legacy" | "codex";
export type CodexAppServerProtocol = "v2-camel" | "hybrid-kebab-thread" | "legacy-kebab";

export interface CodeHarnessSelection {
  requested: CodeHarnessMode;
  selected: SelectedCodeHarness;
  reason: string;
  protocol?: CodexAppServerProtocol;
}

export interface CodeHarnessSelectionInput {
  requested: CodeHarnessMode;
  cwd: string;
  brainUrl: string;
  provider?: CliProviderProfile | null;
  ultra: boolean;
  hasMedia?: boolean;
  machineReadable?: boolean;
  approval?: "ask" | "on-failure" | "never" | "yolo";
  /** The session has hooks configured; only the native loop can run them. */
  hasHooks?: boolean;
  /** Plan mode is a safety property; only the native loop can enforce it. */
  planMode?: boolean;
  reasoning?: ReasoningOptions;
  lynnHome?: string;
  probe?: (options: CodexAppServerClientOptions) => Promise<CodexAppServerProtocol>;
  brainProbe?: (brainUrl: string) => Promise<{ supported: boolean; reason: string }>;
  routeProbe?: (input: CodeHarnessRouteProbeInput) => Promise<void>;
  clientOptions?: CodexAppServerClientOptions;
}

export interface CodeHarnessRouteProbeInput {
  brainUrl: string;
  provider?: CliProviderProfile | null;
  reasoning: ReasoningOptions;
  lynnHome?: string;
}

function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function protocolThreadSandbox(protocol: CodexAppServerProtocol): "readOnly" | "read-only" {
  return protocol === "v2-camel" ? "readOnly" : "read-only";
}

function protocolTurnSandbox(protocol: CodexAppServerProtocol): "readOnly" | "read-only" {
  return protocol === "legacy-kebab" ? "read-only" : "readOnly";
}

function protocolApproval(protocol: CodexAppServerProtocol): "unlessTrusted" | "untrusted" {
  return protocol === "v2-camel" ? "unlessTrusted" : "untrusted";
}

function looksLikeProtocolMismatch(error: unknown): boolean {
  return /invalid (?:request|params)|unknown variant|expected one of|-32602/i.test(errorMessage(error));
}

async function probeCodexAppServerProtocol(
  protocol: CodexAppServerProtocol,
  options: CodexAppServerClientOptions,
): Promise<void> {
  const cwd = path.resolve(options.cwd || process.cwd());
  const envKey = "LYNN_CODEX_PREFLIGHT_TOKEN";
  const provider = "lynn_preflight";
  const client = new CodexAppServerClient({
    ...options,
    cwd,
    // Cold thread startup can exceed five seconds while the app-server loads
    // its integrations. Use the same bounded wait as the actual client.
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    clientVersion: options.clientVersion || readVersionInfo().version,
    env: { [envKey]: "local-preflight-only", ...(options.env || {}) },
    configOverrides: options.configOverrides || [
      `model_provider="${provider}"`,
      `model_providers.${provider}={name="Lynn preflight",base_url="http://127.0.0.1:9/v1",env_key="${envKey}",wire_api="responses"}`,
    ],
  });
  try {
    await client.start();
    const result = await client.startThread({
      model: "lynn-preflight",
      modelProvider: provider,
      allowProviderModelFallback: false,
      cwd,
      approvalPolicy: protocolApproval(protocol),
      sandbox: protocolThreadSandbox(protocol),
      ephemeral: true,
    });
    const thread = result.thread;
    if (!thread || typeof thread !== "object" || Array.isArray(thread) || typeof (thread as { id?: unknown }).id !== "string") {
      throw new Error("Codex app-server preflight did not return a thread id");
    }
    const threadId = (thread as { id: string }).id;
    const turn = await client.startTurn({
      threadId,
      input: [{ type: "text", text: "Lynn protocol preflight only" }],
      cwd,
      approvalPolicy: protocolApproval(protocol),
      sandboxPolicy: { type: protocolTurnSandbox(protocol) },
      model: "lynn-preflight",
    });
    const turnId = turn.turn && typeof turn.turn === "object" && !Array.isArray(turn.turn)
      ? (turn.turn as { id?: unknown }).id
      : null;
    if (typeof turnId !== "string") throw new Error("Codex app-server preflight did not return a turn id");
    await client.interruptTurn(threadId, turnId).catch(() => undefined);
  } finally {
    await client.stop();
  }
}

export async function probeCodexAppServer(options: CodexAppServerClientOptions = {}): Promise<CodexAppServerProtocol> {
  let firstError: unknown;
  try {
    await probeCodexAppServerProtocol("v2-camel", options);
    return "v2-camel";
  } catch (error) {
    if (!looksLikeProtocolMismatch(error)) throw error;
    firstError = error;
  }
  try {
    await probeCodexAppServerProtocol("hybrid-kebab-thread", options);
    return "hybrid-kebab-thread";
  } catch (error) {
    if (!looksLikeProtocolMismatch(error)) throw error;
    try {
      await probeCodexAppServerProtocol("legacy-kebab", options);
      return "legacy-kebab";
    } catch {
      throw firstError;
    }
  }
}

export async function probeBrainHarnessSupport(brainUrl: string): Promise<{ supported: boolean; reason: string }> {
  const status = await fetchBrainProviderStatus(brainUrl, 5_000);
  if (!status) {
    return {
      supported: true,
      reason: "Brain status is unavailable; defer to the authenticated Responses route preflight",
    };
  }
  if (status.capabilities?.responses !== true || status.capabilities?.appServerHarness !== true) {
    return { supported: false, reason: "Brain does not declare Codex app-server Responses compatibility" };
  }
  if (!brainRouteUsable(status)) return { supported: false, reason: "Brain has no configured provider route" };
  return { supported: true, reason: "Brain Responses route is ready" };
}

export async function probeCodeHarnessRoute(input: CodeHarnessRouteProbeInput): Promise<void> {
  const proxy = await startCodexResponsesProxy(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Codex route preflight timed out")), 20_000);
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${proxy.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: input.provider?.model || "step-5-preview",
        input: "Reply with OK.",
        max_output_tokens: 64,
        stream: false,
      }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`provider/model preflight returned HTTP ${response.status}: ${body.slice(0, 240)}`);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new Error("provider/model preflight returned invalid JSON");
    }
    if (parsed.error) {
      const message = typeof parsed.error === "object" && parsed.error && "message" in parsed.error
        ? String((parsed.error as { message?: unknown }).message || "provider/model rejected the request")
        : String(parsed.error);
      throw new Error(`provider/model preflight failed: ${message}`);
    }
    if (!parsed.id && !parsed.output && !parsed.output_text) {
      throw new Error("provider/model preflight returned no Responses result");
    }
  } finally {
    clearTimeout(timer);
    await proxy.stop();
  }
}

export async function resolveCodeHarnessSelection(input: CodeHarnessSelectionInput): Promise<CodeHarnessSelection> {
  // Plan mode is enforced by the native loop's tool gate; handing the turn to
  // the Codex app-server would silently drop that guarantee.
  if (input.planMode) {
    return {
      requested: input.requested,
      selected: "legacy",
      reason: "plan mode can only be enforced by the native loop",
    };
  }
  if (input.requested === "auto" && input.hasHooks) {
    return {
      requested: input.requested,
      selected: "legacy",
      reason: "hooks are configured; the Codex harness has no per-tool hook surface",
    };
  }
  if (input.requested === "legacy") {
    return { requested: input.requested, selected: "legacy", reason: "explicit legacy mode" };
  }
  if (input.requested === "codex") {
    if (input.ultra) throw new Error("--harness codex cannot be combined with --ultra yet; use --harness auto or legacy");
    if (input.hasMedia) throw new Error("--harness codex does not yet preserve Lynn's multimodal attachment bridge; use --harness auto or legacy");
    if (input.machineReadable) throw new Error("--harness codex does not yet preserve Lynn's per-tool JSON audit stream; use --harness auto or legacy");
    if (input.approval === "never") {
      throw new Error(`--harness codex does not yet preserve Lynn's ${input.approval} approval semantics; use --harness auto or legacy`);
    }
    const protocol = await (input.probe || probeCodexAppServer)({
      cwd: path.resolve(input.cwd),
      ...input.clientOptions,
    });
    await (input.routeProbe || probeCodeHarnessRoute)({
      brainUrl: input.brainUrl,
      provider: input.provider,
      reasoning: input.reasoning || { effort: "auto", display: "auto" },
      lynnHome: input.lynnHome,
    });
    return {
      requested: input.requested,
      selected: "codex",
      reason: `explicit Codex app-server mode; authentication, provider, model, and ${protocol} protocol preflight passed`,
      protocol,
    };
  }
  if (input.ultra) {
    return { requested: input.requested, selected: "legacy", reason: "ultra mode uses the legacy multi-worker loop" };
  }
  if (input.hasMedia) {
    return { requested: input.requested, selected: "legacy", reason: "attached media uses Lynn's verified legacy multimodal bridge" };
  }
  if (input.machineReadable) {
    return { requested: input.requested, selected: "legacy", reason: "JSON mode uses Lynn's verified per-tool audit stream" };
  }
  if (input.approval === "never") {
    return { requested: input.requested, selected: "legacy", reason: `${input.approval} approval mode requires Lynn's strict tool-approval semantics` };
  }
  if (input.provider && !input.provider.apiKey && !isLoopbackBaseUrl(input.provider.baseUrl)) {
    return { requested: input.requested, selected: "legacy", reason: "remote BYOK provider has no API key" };
  }
  if (!input.provider) {
    const brain = await (input.brainProbe || probeBrainHarnessSupport)(input.brainUrl);
    if (!brain.supported) {
      return { requested: input.requested, selected: "legacy", reason: brain.reason };
    }
  }
  try {
    const protocol = await (input.probe || probeCodexAppServer)({
      cwd: path.resolve(input.cwd),
      ...input.clientOptions,
    });
    await (input.routeProbe || probeCodeHarnessRoute)({
      brainUrl: input.brainUrl,
      provider: input.provider,
      reasoning: input.reasoning || { effort: "auto", display: "auto" },
      lynnHome: input.lynnHome,
    });
    return { requested: input.requested, selected: "codex", reason: `Codex app-server, authentication, provider, and ${protocol} protocol preflight passed`, protocol };
  } catch (error) {
    return {
      requested: input.requested,
      selected: "legacy",
      reason: `Codex app-server preflight failed: ${errorMessage(error)}`,
    };
  }
}
