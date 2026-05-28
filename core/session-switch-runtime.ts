import { findModel } from "../shared/model-ref.js";
import type { ResolvedModel } from "./types.js";
import type { ModelRef } from "./session-switch-meta.js";

type AnyRecord = Record<string, any>;
type AgentLike = AnyRecord;
type SessionLike = AnyRecord;
type ModelLike = ResolvedModel | AnyRecord | null;
type AvailableModelLike = (ResolvedModel | AnyRecord) & { id: string };

export type SwitchSessionEntry = AnyRecord & {
  session: SessionLike;
  agentId: string;
  lastTouchedAt: number;
};

export async function notifyActiveSessionEnd(opts: {
  activeSession: SessionLike | null | undefined;
  sessions: Map<string, SwitchSessionEntry>;
  getAgentById: (agentId: string) => AgentLike | null | undefined;
  getFallbackAgent: () => AgentLike;
  notifySessionEnd: (agent: AgentLike | null | undefined, sessionPath: string, context: string) => void | Promise<void>;
  context: string;
}) {
  const oldSessionPath = opts.activeSession?.sessionManager?.getSessionFile?.();
  if (!oldSessionPath) return;

  const oldEntry = opts.sessions.get(oldSessionPath);
  const oldAgent = oldEntry ? opts.getAgentById(oldEntry.agentId) : opts.getFallbackAgent();
  await opts.notifySessionEnd(oldAgent, oldSessionPath, opts.context);
}

export async function prepareCachedSessionSwitch(opts: {
  activeSession: SessionLike | null | undefined;
  targetEntry: SwitchSessionEntry;
  sessions: Map<string, SwitchSessionEntry>;
  memoryEnabled: boolean;
  getAgentById: (agentId: string) => AgentLike | null | undefined;
  getFallbackAgent: () => AgentLike;
  notifySessionEnd: (agent: AgentLike | null | undefined, sessionPath: string, context: string) => void | Promise<void>;
  now?: () => number;
}) {
  if (opts.activeSession && opts.activeSession !== opts.targetEntry.session) {
    await notifyActiveSessionEnd({
      activeSession: opts.activeSession,
      sessions: opts.sessions,
      getAgentById: opts.getAgentById,
      getFallbackAgent: opts.getFallbackAgent,
      notifySessionEnd: opts.notifySessionEnd,
      context: "session switch",
    });
  }

  opts.targetEntry.lastTouchedAt = opts.now?.() ?? Date.now();
  const targetAgent = opts.getAgentById(opts.targetEntry.agentId) || opts.getFallbackAgent();
  targetAgent.setMemoryEnabled?.(opts.memoryEnabled);
  return opts.targetEntry.session;
}

export function resolveColdStartSwitchModel(opts: {
  savedModelRef: ModelRef | null;
  availableModels: AvailableModelLike[];
  onMissingModel?: (modelRef: ModelRef) => void;
}) {
  if (!opts.savedModelRef) return null;

  const model = findModel(
    opts.availableModels,
    opts.savedModelRef.id,
    opts.savedModelRef.provider || undefined,
  ) as ModelLike;
  if (!model) opts.onMissingModel?.(opts.savedModelRef);
  return model;
}
