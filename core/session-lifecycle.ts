type AnyRecord = Record<string, any>;

type SessionLike = AnyRecord & {
  isStreaming?: boolean;
  abort?: () => Promise<unknown> | unknown;
};

type SessionEntryLike = AnyRecord & {
  session?: SessionLike;
  agentId?: string;
  unsub?: () => void;
};

type AgentLike = AnyRecord;

type ConfirmStoreLike = {
  abortBySession?: (sessionPath: string) => unknown;
};

export function getCachedSessionByPath(
  sessions: Map<string, SessionEntryLike>,
  sessionPath: string,
) {
  return sessions.get(sessionPath)?.session ?? null;
}

export function isCachedSessionStreaming(
  sessions: Map<string, SessionEntryLike>,
  sessionPath: string,
) {
  return !!getCachedSessionByPath(sessions, sessionPath)?.isStreaming;
}

export async function abortCachedSessionByPath(
  sessions: Map<string, SessionEntryLike>,
  sessionPath: string,
) {
  const session = getCachedSessionByPath(sessions, sessionPath);
  if (!session?.isStreaming) return false;
  await session.abort?.();
  return true;
}

export async function abortAllStreamingSessions(
  sessions: Map<string, SessionEntryLike>,
) {
  const tasks: Promise<unknown>[] = [];
  for (const [, entry] of sessions) {
    if (entry.session?.isStreaming) {
      tasks.push(Promise.resolve(entry.session.abort?.()).catch(() => {}));
    }
  }
  await Promise.all(tasks);
  return tasks.length;
}

export async function closeCachedSession(opts: {
  sessions: Map<string, SessionEntryLike>;
  sessionPath: string;
  currentSessionPath?: string | null;
  setCurrentSession: (session: SessionLike | null) => void;
  getAgentById: (agentId: string) => AgentLike | null | undefined;
  getFallbackAgent: () => AgentLike | null | undefined;
  notifySessionEnd: (agent: AgentLike | null | undefined, sessionPath: string, context: string) => unknown;
  getConfirmStore?: () => ConfirmStoreLike | null | undefined;
}) {
  const entry = opts.sessions.get(opts.sessionPath);
  if (entry) {
    const agent = opts.getAgentById(String(entry.agentId || "")) || opts.getFallbackAgent();
    opts.notifySessionEnd(agent, opts.sessionPath, "close session");
    if (entry.session?.isStreaming) {
      try { await entry.session.abort?.(); } catch {}
    }
    entry.unsub?.();
    opts.sessions.delete(opts.sessionPath);
    opts.getConfirmStore?.()?.abortBySession?.(opts.sessionPath);
  }

  if (opts.sessionPath === opts.currentSessionPath) {
    opts.setCurrentSession(null);
  }
}

export async function closeAllCachedSessions(opts: {
  sessions: Map<string, SessionEntryLike>;
  setCurrentSession: (session: SessionLike | null) => void;
}) {
  for (const [, entry] of opts.sessions) {
    if (entry.session?.isStreaming) {
      try { await entry.session.abort?.(); } catch {}
    }
    entry.unsub?.();
  }
  opts.sessions.clear();
  opts.setCurrentSession(null);
}
