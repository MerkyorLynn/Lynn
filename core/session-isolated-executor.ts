import fs from "fs";
import {
  createAgentSession,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { BrowserManager } from "../lib/browser/browser-manager.js";
import {
  buildClientAgentMetadata,
  readClientAgentKeyFromPreferencesFile,
  readSignedClientAgentHeaders,
} from "./client-agent-identity.js";
import { runPromptWithIntegrity } from "./session-prompt-sanitizer.js";
import {
  prepareDryRunWorkspace,
  runDryRunValidation,
} from "./session-dry-run.js";
import {
  prepareIsolatedToolRuntime,
  resolveIsolatedExecutionModel,
} from "./session-isolated-runtime.js";
import type { ResolvedModel } from "./types.js";

type AnyRecord = Record<string, any>;
type AgentLike = AnyRecord;
type ModelLike = ResolvedModel | AnyRecord | null;
type ToolLike = AnyRecord & { name: string };

export type IsolatedExecutionOptions = AnyRecord & {
  agentId?: string;
  signal?: AbortSignal;
  persist?: string;
  cwd?: string;
  dryRun?: boolean;
  model?: ModelLike;
  toolFilter?: string[];
  builtinFilter?: string[];
  validateCommand?: unknown[];
};

export type IsolatedExecutionResult = {
  sessionPath: string | null;
  replyText: string;
  error: string | null;
  dryRun?: {
    workspacePath: string;
    validation: ReturnType<typeof runDryRunValidation>;
  };
};

export type IsolatedExecutorDeps = {
  getAgent: () => AgentLike;
  getAgentById: (agentId: string) => AgentLike | null | undefined;
  getHomeCwd: () => string | null | undefined;
  getModels: () => AnyRecord;
  getPrefs: () => AnyRecord;
  getSkills?: () => AnyRecord | null;
  getResourceLoader: () => AnyRecord;
  buildTools: (cwd: string, customTools?: unknown, opts?: AnyRecord) => { tools: ToolLike[]; customTools: ToolLike[] };
  createSettings: (model: ModelLike) => unknown;
  adjustHeadlessRefCount: (delta: number) => number;
  emitEvent: (event: AnyRecord, sessionPath: string | null | undefined) => void;
  log: Pick<Console, "log" | "error">;
  t: (key: string, vars?: AnyRecord) => string;
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "unknown error");
}

function cleanupTempSession(tempSessionMgr: AnyRecord | null) {
  const sp = tempSessionMgr?.getSessionFile?.();
  if (!sp) return;
  try { fs.unlinkSync(sp); } catch {}
}

function buildExecResourceLoader(opts: {
  targetAgent: AgentLike;
  activeAgent: AgentLike;
  resourceLoader: AnyRecord;
  skills?: AnyRecord | null;
}) {
  if (opts.targetAgent === opts.activeAgent) return opts.resourceLoader;
  return Object.create(opts.resourceLoader, {
    getSystemPrompt: { value: () => opts.targetAgent.systemPrompt },
    getSkills: { value: () => opts.skills?.getSkillsForAgent?.(opts.targetAgent) || [] },
  });
}

export async function executeIsolatedSession(
  prompt: string,
  opts: IsolatedExecutionOptions,
  deps: IsolatedExecutorDeps,
): Promise<IsolatedExecutionResult> {
  const targetAgent = opts.agentId ? deps.getAgentById(opts.agentId) : deps.getAgent();
  if (!targetAgent) throw new Error(deps.t("error.agentNotInitialized", { id: opts.agentId }));

  if (opts.signal?.aborted) {
    return { sessionPath: null, replyText: "", error: "aborted" };
  }

  const bm = BrowserManager.instance();
  const wasBrowserRunning = bm.isRunning;
  const headlessRefCount = deps.adjustHeadlessRefCount(1);
  if (headlessRefCount === 1) bm.setHeadless(true);

  let tempSessionMgr: AnyRecord | null = null;
  let dryRunWorkspace: string | null = null;

  try {
    const sessionDir = opts.persist || targetAgent.sessionDir;
    fs.mkdirSync(sessionDir, { recursive: true });

    const baseExecCwd = opts.cwd || deps.getHomeCwd() || process.cwd();
    if (opts.dryRun) {
      dryRunWorkspace = await prepareDryRunWorkspace(baseExecCwd);
    }
    const execCwd = dryRunWorkspace || baseExecCwd;
    const models = deps.getModels();
    const resolved = resolveIsolatedExecutionModel({
      explicitModel: opts.model,
      targetAgent,
      availableModels: models.availableModels,
      defaultModel: models.defaultModel,
    });
    const resolvedModel = resolved.model;
    if (!resolvedModel) {
      deps.log.error(`[executeIsolated] agent "${targetAgent.agentName}" 未指定 models.chat，也没有可用的默认模型`);
      throw new Error(deps.t("error.executeIsolatedNoModel", { name: targetAgent.agentName }));
    }
    if (resolved.usedFallback && resolved.requestedModelId) {
      deps.log.log(`[executeIsolated] 模型 "${resolved.requestedModelId}" 不可用，fallback → ${resolvedModel.id}`);
    }

    const execModel = models.resolveExecutionModel(resolvedModel);
    tempSessionMgr = SessionManager.create(execCwd, sessionDir);
    const isolatedTools = prepareIsolatedToolRuntime({
      execCwd,
      targetAgent,
      execModel,
      buildTools: deps.buildTools,
      getSessionPath: () => tempSessionMgr?.getSessionFile?.() || null,
      toolFilter: opts.toolFilter,
      builtinFilter: opts.builtinFilter,
    });
    if (isolatedTools.suppressClientTools) {
      deps.log.log(`[executeIsolated] using Brain V2 internal tool chain for ${execModel?.provider || "?"}/${execModel?.id || execModel?.name || "?"}; client tool schema suppressed`);
    }

    const activeAgent = deps.getAgent();
    const skills = deps.getSkills?.();
    const execResourceLoader = buildExecResourceLoader({
      targetAgent,
      activeAgent,
      resourceLoader: deps.getResourceLoader(),
      skills,
    });

    const clientAgentKey = readClientAgentKeyFromPreferencesFile();
    const clientAgentHeaders = readSignedClientAgentHeaders({
      method: "POST",
      pathname: "/chat/completions",
    });
    const clientAgentMetadata = buildClientAgentMetadata(clientAgentKey);
    const { session } = await createAgentSession({
      cwd: execCwd,
      sessionManager: tempSessionMgr,
      settingsManager: deps.createSettings(execModel),
      authStorage: models.authStorage,
      modelRegistry: models.modelRegistry,
      model: execModel,
      thinkingLevel: models.resolveThinkingLevel(deps.getPrefs().getThinkingLevel(), execModel),
      resourceLoader: execResourceLoader,
      tools: isolatedTools.tools,
      customTools: isolatedTools.customTools,
      ...(Object.keys(clientAgentHeaders).length > 0 && { requestHeaders: clientAgentHeaders }),
      ...(clientAgentMetadata && { requestMetadata: clientAgentMetadata }),
    } as any);

    const abortHandler = () => session.abort();
    opts.signal?.addEventListener("abort", abortHandler, { once: true });

    if (opts.signal?.aborted) {
      opts.signal.removeEventListener("abort", abortHandler);
      cleanupTempSession(tempSessionMgr);
      return { sessionPath: null, replyText: "", error: "aborted" };
    }

    let replyText = "";
    try {
      replyText = await runPromptWithIntegrity(session, prompt);
    } finally {
      opts.signal?.removeEventListener("abort", abortHandler);
    }

    const sessionPath = session.sessionManager?.getSessionFile?.() || null;
    const dryRunValidation = opts.dryRun
      ? runDryRunValidation(execCwd, opts.validateCommand)
      : null;

    if (!opts.persist && sessionPath) {
      cleanupTempSession(tempSessionMgr);
      return {
        sessionPath: null,
        replyText,
        error: null,
        ...(dryRunWorkspace ? { dryRun: { workspacePath: dryRunWorkspace, validation: dryRunValidation } } : {}),
      };
    }

    return {
      sessionPath,
      replyText,
      error: null,
      ...(dryRunWorkspace ? { dryRun: { workspacePath: dryRunWorkspace, validation: dryRunValidation } } : {}),
    };
  } catch (err) {
    deps.log.error(`isolated execution failed: ${errMessage(err)}`);
    if (!opts.persist && tempSessionMgr) {
      cleanupTempSession(tempSessionMgr);
    }
    return { sessionPath: null, replyText: "", error: errMessage(err) };
  } finally {
    const remaining = deps.adjustHeadlessRefCount(-1);
    if (remaining === 0) bm.setHeadless(false);
    const browserNowRunning = bm.isRunning;
    if (browserNowRunning !== wasBrowserRunning) {
      deps.emitEvent({ type: "browser_bg_status", running: browserNowRunning, url: bm.currentUrl }, null);
    }
  }
}
