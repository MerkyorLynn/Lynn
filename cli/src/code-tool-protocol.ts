import type { BrainStreamEvent, ChatAssistantToolCall, ChatToolDefinition } from "./brain-client.js";
import type { ClientToolName } from "./tools/types.js";
import { workingCheckpointEnabled } from "./code-working-checkpoint.js";
import { webScanEnabled } from "./tools/web-scan.js";

export interface CodeToolRequest {
  toolCallId?: string;
  toolCallName?: string;
  toolCallArguments?: string;
  tool: ClientToolName;
  args: {
    path?: string;
    text?: string;
    query?: string;
    pattern?: string;
    command?: string;
    maxBytes?: number;
    offset?: number;
    plan?: unknown;
    content?: string;
    url?: string;
  };
  /** Loop iteration (step) this request belongs to; used for fallback tool-call ids and step events. */
  step?: number;
}

export interface CollectedToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

export function toolRequestFingerprint(request: CodeToolRequest): string {
  return JSON.stringify({
    tool: request.tool,
    args: stableObject(request.args as Record<string, unknown>),
  });
}

export function codeToolDefinitions(): ChatToolDefinition[] {
  const tools: ChatToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "update_plan",
        description: "Update the visible task plan. Use this before and during multi-step coding work.",
        parameters: objectSchema({
          items: {
            type: "array",
            description: "Plan items in execution order.",
            items: objectSchema({
              id: stringSchema("Optional stable item id, for example S0 or C1."),
              content: stringSchema("Task step description."),
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Current state for this step.",
              },
            }, ["content", "status"]),
          },
        }, ["items"]),
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file inside the current workspace.",
        parameters: objectSchema({
          path: stringSchema("Workspace-relative file path."),
          maxBytes: numberSchema("Optional maximum bytes to read."),
          offset: numberSchema("Optional byte offset for continuing a previous read."),
        }, ["path"]),
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search files in the workspace for a text or regex query.",
        parameters: objectSchema({
          query: stringSchema("Search query or regular expression."),
          path: stringSchema("Optional workspace-relative directory or file to search."),
        }, ["query"]),
      },
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: "List workspace files matching a glob pattern.",
        parameters: objectSchema({
          pattern: stringSchema("Glob pattern, for example **/*.ts."),
          path: stringSchema("Optional workspace-relative directory to search."),
        }, ["pattern"]),
      },
    },
    {
      type: "function",
      function: {
        name: "apply_patch",
        description: "Apply a patch inside the workspace. Prefer this for edits.",
        parameters: objectSchema({
          text: stringSchema("Patch text. Supports Codex *** Begin Patch format or unified diff."),
        }, ["text"]),
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a full text file inside the workspace. Use sparingly; prefer apply_patch for edits.",
        parameters: objectSchema({
          path: stringSchema("Workspace-relative file path."),
          text: stringSchema("Full file content to write."),
        }, ["path", "text"]),
      },
    },
    {
      type: "function",
      function: {
        name: "bash",
        description: "Run a shell command in the workspace, usually for tests or inspection.",
        parameters: objectSchema({
          command: stringSchema("Shell command to run."),
        }, ["command"]),
      },
    },
  ];
  // Opt-in (LYNN_CLI_WORKING_CHECKPOINT=1): a model-curated scratchpad,
  // re-injected every step and immune to history compaction. This keeps durable
  // context small in-process instead of leaning on long history.
  if (workingCheckpointEnabled(process.env)) {
    tools.push({
      type: "function",
      function: {
        name: "update_working_checkpoint",
        description: "Overwrite your private working checkpoint — a short scratchpad of the key facts, decisions, and next steps you must not lose. It is re-injected every step and survives history compaction, so keep durable context here instead of relying on long history. Keep it concise.",
        parameters: objectSchema({
          content: stringSchema("The full new checkpoint text. Replaces the previous one. Keep it tight."),
        }, ["content"]),
      },
    });
  }
  // Opt-in (LYNN_CLI_WEB_SCAN=1): read-only public web fetch + token-frugal
  // simplification. SSRF-guarded; no logged-in/browser actions (that is the GUI).
  if (webScanEnabled(process.env)) {
    tools.push({
      type: "function",
      function: {
        name: "web_scan",
        description: "Fetch a public web page over http/https and return simplified, token-frugal text (title + readable body). Read-only; for docs/reference. Cannot reach private/loopback hosts.",
        parameters: objectSchema({
          url: stringSchema("Absolute http(s) URL to fetch."),
        }, ["url"]),
      },
    });
  }
  return tools;
}

export function parseCodeToolRequest(text: string): CodeToolRequest | null {
  return parseCodeToolRequests(text)[0] ?? null;
}

export function parseCodeToolRequests(text: string): CodeToolRequest[] {
  const requests: CodeToolRequest[] = [];
  const seen = new Set<string>();
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      for (const payload of toolPayloadCandidates(parsed)) {
        const request = normalizeToolPayload(payload);
        if (!request) continue;
        const fingerprint = toolRequestFingerprint(request);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        requests.push(request);
      }
    } catch {
      // Try the next candidate.
    }
  }
  return requests;
}

export interface StreamingToolCallAccumulator {
  append(event: Extract<BrainStreamEvent, { type: "tool_call.delta" }>): void;
  toJsonText(): string;
  toToolCalls(): CollectedToolCall[];
  hasCalls(): boolean;
}

export function createStreamingToolCallAccumulator(): StreamingToolCallAccumulator {
  const calls = new Map<number, { id?: string; name?: string; arguments: string }>();
  return {
    append(event) {
      const current = calls.get(event.index) || { arguments: "" };
      calls.set(event.index, {
        id: event.id || current.id,
        name: event.name || current.name,
        arguments: current.arguments + (event.arguments || ""),
      });
    },
    hasCalls() {
      return calls.size > 0;
    },
    toJsonText() {
      if (!calls.size) return "";
      return JSON.stringify({
        tool_calls: this.toToolCalls().map((call, index) => ({
          index,
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: call.arguments,
          },
        })),
      });
    },
    toToolCalls() {
      return [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.arguments }));
    },
  };
}

export function toolRequestsFromCollectedCalls(calls: readonly CollectedToolCall[], step: number): CodeToolRequest[] {
  const requests: CodeToolRequest[] = [];
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    const request = normalizeToolPayload({ name: call.name, arguments: call.arguments });
    if (!request) continue;
    requests.push({
      ...request,
      toolCallId: call.id || `lynn_call_${step}_${i}`,
      toolCallName: call.name || request.tool,
      toolCallArguments: call.arguments,
    });
  }
  return requests;
}

export function assistantToolCallsForMessages(requests: readonly CodeToolRequest[]): ChatAssistantToolCall[] {
  return requests.map((request, index) => ({
    id: request.toolCallId || `lynn_call_${index}`,
    type: "function",
    function: {
      name: request.toolCallName || request.tool,
      arguments: request.toolCallArguments || JSON.stringify(cleanToolArgsForProvider(request.args)),
    },
  }));
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function numberSchema(description: string): Record<string, unknown> {
  return { type: "number", description };
}

function cleanToolArgsForProvider(args: CodeToolRequest["args"]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

function stableObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? stableObject(v as Record<string, unknown>) : v]),
  );
}

function normalizeToolPayload(payload: Record<string, unknown>): CodeToolRequest | null {
  const rawToolName = typeof payload.tool === "string"
    ? payload.tool
    : typeof payload.name === "string"
      ? payload.name
      : "";
  if (!rawToolName) return null;
  const toolName = normalizeClientToolName(rawToolName);
  if (!toolName) return null;
  const args = normalizeToolArgAliases(toolName, normalizeToolArgs(payload));
  return {
    tool: toolName,
    args: {
      path: stringArg(args.path),
      text: stringArg(args.text ?? args.content ?? args.patch),
      query: stringArg(args.query),
      pattern: stringArg(args.pattern),
      command: stringArg(args.command),
      maxBytes: numberArg(args.maxBytes ?? args.max_bytes),
      offset: numberArg(args.offset ?? args.start_offset ?? args.startOffset),
      plan: args.plan,
      content: stringArg(args.content),
      url: stringArg(args.url),
    },
  };
}

const TOOL_NAME_ALIASES: Record<string, ClientToolName> = {
  read_file: "read_file",
  read: "read_file",
  open_file: "read_file",
  read_path: "read_file",
  view_file: "read_file",
  cat: "read_file",
  write_file: "write_file",
  write: "write_file",
  create_file: "write_file",
  save_file: "write_file",
  edit_file: "apply_patch",
  edit: "apply_patch",
  patch: "apply_patch",
  apply_patch: "apply_patch",
  apply_diff: "apply_patch",
  apply_patch_file: "apply_patch",
  grep: "grep",
  search: "grep",
  search_files: "grep",
  ripgrep: "grep",
  rg: "grep",
  glob: "glob",
  list_files: "glob",
  find_files: "glob",
  ls: "glob",
  bash: "bash",
  shell: "bash",
  run_shell: "bash",
  run_bash: "bash",
  terminal: "bash",
  exec: "bash",
  update_plan: "update_plan",
  todowrite: "update_plan",
  todo_write: "update_plan",
  update_todos: "update_plan",
  todo: "update_plan",
  plan: "update_plan",
  update_working_checkpoint: "update_working_checkpoint",
  working_checkpoint: "update_working_checkpoint",
  checkpoint: "update_working_checkpoint",
  scratchpad: "update_working_checkpoint",
  web_scan: "web_scan",
  web_fetch: "web_scan",
  fetch_url: "web_scan",
  browse: "web_scan",
};

function normalizeClientToolName(raw: string): ClientToolName | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return TOOL_NAME_ALIASES[key] ?? null;
}

function toolPayloadCandidates(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const parsed = value as Record<string, unknown>;
  const candidates: Record<string, unknown>[] = [parsed];
  const fn = parsed.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    const functionCall = fn as Record<string, unknown>;
    candidates.push({ name: functionCall.name, arguments: functionCall.arguments });
  }
  const toolCalls = parsed.tool_calls ?? parsed.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!call || typeof call !== "object" || Array.isArray(call)) continue;
      const record = call as Record<string, unknown>;
      const callFn = record.function;
      if (callFn && typeof callFn === "object" && !Array.isArray(callFn)) {
        const functionCall = callFn as Record<string, unknown>;
        candidates.push({ name: functionCall.name, arguments: functionCall.arguments });
      } else {
        candidates.push(record);
      }
    }
  }
  return candidates;
}

function normalizeToolArgs(parsed: Record<string, unknown>): Record<string, unknown> {
  const explicit = parsed.args ?? parsed.arguments ?? parsed.input ?? parsed.parameters;
  if (explicit && typeof explicit === "object" && !Array.isArray(explicit)) {
    return explicit as Record<string, unknown>;
  }
  if (typeof explicit === "string") {
    try {
      const decoded = JSON.parse(explicit) as unknown;
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) return decoded as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const { tool: _tool, name: _name, args: _args, arguments: _arguments, input: _input, parameters: _parameters, function: _function, tool_calls: _toolCalls, toolCalls: _toolCallsCamel, ...topLevelArgs } = parsed;
  return topLevelArgs;
}

function normalizeToolArgAliases(tool: ClientToolName, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...args };
  const path = firstArg(args.path, args.file, args.filepath, args.filePath, args.filename, args.target);
  const oldText = firstArg(args.old_string, args.oldString, args.old_text, args.oldText, args.search, args.original);
  const newText = firstArg(args.new_string, args.newString, args.new_text, args.newText, args.replacement, args.replace);
  const editPatch = buildCodexEditPatch(path, oldText, newText);
  const text = firstArg(args.text, args.content, args.body, args.data, args.patch, args.diff, editPatch);
  const command = firstArg(args.command, args.cmd, args.shell, args.script);
  const query = firstArg(args.query, args.pattern, args.search, args.regex);
  const pattern = firstArg(args.pattern, args.glob, args.query);
  const dir = firstArg(args.path, args.dir, args.directory, args.cwd, args.folder);

  if ((tool === "read_file" || tool === "write_file") && path !== undefined) normalized.path = path;
  if (tool === "write_file" && text !== undefined) normalized.text = text;
  if (tool === "apply_patch" && text !== undefined) normalized.text = text;
  if (tool === "bash" && command !== undefined) normalized.command = command;
  if (tool === "update_plan") {
    normalized.plan = firstArg(args.plan, args.items, args.todos, args.tasks, args.steps, args);
  }
  if (tool === "grep") {
    if (query !== undefined) normalized.query = query;
    if (dir !== undefined) normalized.path = dir;
  }
  if (tool === "glob") {
    if (pattern !== undefined) normalized.pattern = pattern;
    if (dir !== undefined) normalized.path = dir;
  }
  return normalized;
}

function firstArg(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function buildCodexEditPatch(path: unknown, oldText: unknown, newText: unknown): string | undefined {
  if (typeof path !== "string" || typeof oldText !== "string" || typeof newText !== "string") return undefined;
  if (!path.trim() || !oldText) return undefined;
  return [
    "*** Begin Patch",
    `*** Update File: ${path.trim()}`,
    "@@",
    ...oldText.replace(/\r\n/g, "\n").split("\n").map((line) => `-${line}`),
    ...newText.replace(/\r\n/g, "\n").split("\n").map((line) => `+${line}`),
    "*** End Patch",
    "",
  ].join("\n");
}

function extractJsonCandidates(text: string): string[] {
  const out: string[] = [];
  const fence = text.match(/```(?:json|lynn-tool|tool)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) out.push(fence[1].trim());
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) out.push(trimmed);
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const candidate = scanJsonObject(text, start);
    if (candidate) out.push(candidate);
  }
  return [...new Set(out)];
}

function scanJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
