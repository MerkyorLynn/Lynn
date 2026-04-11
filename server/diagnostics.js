const runtimeDiagnostics = {
  current: null,
  lastToolCall: null,
  lastFallback: null,
  lastProviderIssue: null,
};

function withTimestamp(payload = {}) {
  return {
    at: new Date().toISOString(),
    ...payload,
  };
}

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : null;
}

function normalizeIssueKind(message = "", code = "") {
  const text = `${code || ""} ${message || ""}`.toLowerCase();
  if (text.includes("429")) return "429";
  if (text.includes("400")) return "400";
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  return code || "error";
}

export function recordCurrentProvider(payload = {}) {
  runtimeDiagnostics.current = withTimestamp(payload);
}

export function recordToolCall(payload = {}) {
  runtimeDiagnostics.lastToolCall = withTimestamp(payload);
}

export function recordFallback(payload = {}) {
  runtimeDiagnostics.lastFallback = withTimestamp(payload);
}

export function recordProviderIssue(payload = {}) {
  runtimeDiagnostics.lastProviderIssue = withTimestamp({
    kind: normalizeIssueKind(payload.message, payload.code),
    ...payload,
  });
}

export function getRuntimeDiagnostics(engine) {
  const currentModel = engine?.currentModel || null;
  let mcp = [];
  try {
    mcp = engine?.mcpManager?.listServerStates?.()?.map((server) => ({
      name: server.name,
      label: server.label || server.name,
      transport: server.transport,
      connected: !!server.connected,
      builtin: !!server.builtin,
      toolCount: Number(server.toolCount || 0),
      error: server.error || null,
    })) || [];
  } catch {
    mcp = [];
  }

  return {
    current: clone(runtimeDiagnostics.current) || {
      at: new Date().toISOString(),
      provider: currentModel?.provider || null,
      modelId: currentModel?.id || null,
      modelName: currentModel?.name || currentModel?.id || null,
      routeIntent: null,
      sessionPath: engine?.currentSessionPath || null,
    },
    lastToolCall: clone(runtimeDiagnostics.lastToolCall),
    lastFallback: clone(runtimeDiagnostics.lastFallback),
    lastProviderIssue: clone(runtimeDiagnostics.lastProviderIssue),
    mcp,
  };
}
