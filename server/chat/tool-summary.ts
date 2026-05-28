import { extractText } from "./content-utils.js";
import { clearPendingMutationOnSuccessfulDelete } from "./turn-retry-policy.js";
import type { TurnRetryState } from "./turn-retry-policy.js";

type ToolArgs = Record<string, unknown>;

interface ToolSummaryLike {
  outputPreview?: unknown;
}

export interface ToolSuccessRecord {
  name: string;
  command: string;
  filePath: string;
  outputPreview: string;
}

export interface ToolSummaryState extends TurnRetryState {
  successfulToolCount?: number;
  lastSuccessfulTools?: ToolSuccessRecord[];
  hasFailedTool?: boolean;
  lastFailedTools?: string[];
}

interface ToolResultLike {
  details?: ToolArgs;
  content?: unknown;
  isError?: unknown;
}

interface ToolExecutionEvent {
  toolName?: string;
  args?: unknown;
  isError?: unknown;
  result?: ToolResultLike | null;
}

/**
 * Per-source trace returned by Lynn brain v2's /v1/web-search proxy.
 * Mirror of lib/tools/web-search.ts → SearchSourceTrace, declared here to
 * avoid pulling agent-SDK types into the server boundary.
 */
export interface WebSearchSource {
  name: string;
  ok: boolean;
  error?: string;
  items: Array<{ title: string; url: string; snippet: string }>;
  summary?: string;
}

export interface WebSearchPublicSummary {
  provider?: string;
  summary?: string;
  sources?: WebSearchSource[];
}

export interface ToolPublicSummary {
  linesAdded?: number;
  linesRemoved?: number;
  filePath?: string;
  bytesWritten?: number;
  outputPreview?: string;
  command?: string;
  totalLines?: unknown;
  truncated?: boolean;
  matchCount?: number;
  lineCount?: number;
  /**
   * Populated for `web_search` results when the brain-proxy tier wins. Carries
   * the LLM-synthesized answer and per-source trace so the UI can render a
   * collapsible "View sources (N)" panel below the synthesized answer.
   */
  webSearch?: WebSearchPublicSummary;
}

export interface ToolExecutionSummaryResult {
  toolName: string;
  rawDetails: ToolArgs;
  normalizedArgs: ToolArgs;
  toolIsError: boolean;
  summary: ToolPublicSummary;
  publicSummary?: ToolPublicSummary;
}

/** tool_start broadcasts only these arg fields to avoid sending full file contents. */
export const TOOL_ARG_SUMMARY_KEYS = [
  "file_path",
  "path",
  "command",
  "cmd",
  "shell",
  "script",
  "pattern",
  "url",
  "query",
  "key",
  "value",
  "action",
  "type",
  "schedule",
  "prompt",
  "label",
];

export function normalizeToolArgsForSummary(toolName: string, rawArgs: unknown): unknown {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return rawArgs;
  const args = { ...(rawArgs as ToolArgs) };
  if (toolName === "bash" && (typeof args.command !== "string" || !args.command.trim())) {
    for (const key of ["query", "cmd", "shell", "script"]) {
      if (typeof args[key] === "string" && args[key].trim()) {
        args.command = args[key];
        break;
      }
    }
  }
  return args;
}

export function rememberSuccessfulTool(
  ss: ToolSummaryState | null | undefined,
  toolName: string | null | undefined,
  toolSummary: ToolSummaryLike | null | undefined,
  rawArgs: unknown,
): void {
  if (!ss || !toolName) return;
  ss.successfulToolCount = (ss.successfulToolCount || 0) + 1;
  const args = (normalizeToolArgsForSummary(toolName, rawArgs) || {}) as ToolArgs;
  const filePath = args.file_path || args.path;
  const record: ToolSuccessRecord = {
    name: toolName,
    command: typeof args.command === "string" ? args.command : "",
    filePath: typeof filePath === "string" ? filePath : "",
    outputPreview: typeof toolSummary?.outputPreview === "string" ? toolSummary.outputPreview : "",
  };
  ss.lastSuccessfulTools = [...(ss.lastSuccessfulTools || []), record].slice(-8);
  if (toolName === "bash" && record.command) {
    clearPendingMutationOnSuccessfulDelete(ss, record.command);
  }
}

export function rememberFailedTool(ss: ToolSummaryState | null | undefined, toolName: string | null | undefined): void {
  if (!ss || !toolName) return;
  ss.hasFailedTool = true;
  ss.lastFailedTools = [...(ss.lastFailedTools || []), toolName].slice(-8);
}

export function buildPrefetchToolSummary(context: unknown): ToolPublicSummary {
  const lines = String(context || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^【系统已完成/.test(line))
    .filter((line) => !/^(?:下面是|请直接|如果资料不足|来源[:：]?)/.test(line));
  const outputPreview = lines.slice(0, 6).join("\n").slice(0, 200);
  return outputPreview ? { outputPreview } : {};
}

export function summarizeToolExecution(event: ToolExecutionEvent | null | undefined): ToolExecutionSummaryResult {
  const rawDetails = event?.result?.details || {};
  const toolName = event?.toolName || "";
  const normalizedArgs = (normalizeToolArgsForSummary(toolName, event?.args) || {}) as ToolArgs;
  const toolIsError = Boolean(event?.isError || event?.result?.isError);
  const summary: ToolPublicSummary = {};

  if (toolName === "edit" || toolName === "edit-diff") {
    if (rawDetails.diff) {
      const lines = (rawDetails.diff as string).split("\n");
      let added = 0;
      let removed = 0;
      for (const line of lines) {
        if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
        if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
      }
      summary.linesAdded = added;
      summary.linesRemoved = removed;
      summary.filePath = (normalizedArgs.file_path || normalizedArgs.path || "") as string;
    }
  } else if (toolName === "write") {
    summary.filePath = (normalizedArgs.file_path || normalizedArgs.path || "") as string;
    const text = extractText(event?.result?.content as Parameters<typeof extractText>[0]);
    const bytesMatch = text.match(/(\d+)\s*bytes/i);
    if (bytesMatch) summary.bytesWritten = parseInt(bytesMatch[1], 10);
  } else if (toolName === "bash") {
    const text = extractText(event?.result?.content as Parameters<typeof extractText>[0]);
    if (text) summary.outputPreview = text.slice(0, 200);
    summary.command = ((normalizedArgs.command as string) || "").slice(0, 80);
    if (rawDetails.truncation) {
      summary.totalLines = (rawDetails.truncation as { totalLines?: unknown }).totalLines;
      summary.truncated = true;
    }
  } else if (toolName === "grep" || toolName === "glob" || toolName === "find") {
    const text = extractText(event?.result?.content as Parameters<typeof extractText>[0]);
    if (text) {
      const matchLines = text.trim().split("\n").filter(Boolean);
      summary.matchCount = matchLines.length;
      summary.outputPreview = matchLines.slice(0, 5).join("\n");
    }
  } else if (toolName === "web_search") {
    const text = extractText(event?.result?.content as Parameters<typeof extractText>[0]);
    if (text) summary.outputPreview = text.slice(0, 200);
    // Surface brain-proxy structured summary + per-source trace when present.
    // Source: lib/tools/web-search.ts createWebSearchTool.execute() returns
    //   { content, details: { summary?, sources?, provider, ... } }
    // We expose only the curated subset the UI needs (sources may be large).
    const webDetails = (rawDetails as { summary?: unknown; sources?: unknown; provider?: unknown });
    const webSummary: WebSearchPublicSummary = {};
    if (typeof webDetails.summary === "string" && webDetails.summary.trim()) {
      webSummary.summary = webDetails.summary;
    }
    if (typeof webDetails.provider === "string" && webDetails.provider.trim()) {
      webSummary.provider = webDetails.provider;
    }
    if (Array.isArray(webDetails.sources)) {
      const sources: WebSearchSource[] = [];
      for (const raw of webDetails.sources) {
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as { name?: unknown; ok?: unknown; error?: unknown; items?: unknown; summary?: unknown };
        const name = typeof entry.name === "string" ? entry.name : "";
        if (!name) continue;
        const itemsRaw = Array.isArray(entry.items) ? entry.items : [];
        const items = itemsRaw
          .map((it) => {
            if (!it || typeof it !== "object") return null;
            const r = it as { title?: unknown; url?: unknown; snippet?: unknown };
            return {
              title: typeof r.title === "string" ? r.title : "",
              url: typeof r.url === "string" ? r.url : "",
              snippet: typeof r.snippet === "string" ? r.snippet : "",
            };
          })
          .filter((it): it is { title: string; url: string; snippet: string } => it !== null);
        sources.push({
          name,
          ok: entry.ok === true,
          error: typeof entry.error === "string" ? entry.error : undefined,
          items,
          summary: typeof entry.summary === "string" ? entry.summary : undefined,
        });
      }
      if (sources.length > 0) webSummary.sources = sources;
    }
    // Only surface webSearch when there is actually synthesized content the UI
    // can render — provider alone is metadata, not actionable display data.
    if (webSummary.summary || (webSummary.sources?.length ?? 0) > 0) {
      summary.webSearch = webSummary;
    }
  } else if (toolName === "read") {
    summary.filePath = (normalizedArgs.file_path || normalizedArgs.path || "") as string;
    const text = extractText(event?.result?.content as Parameters<typeof extractText>[0]);
    if (text) summary.lineCount = text.split("\n").length;
  } else {
    const text = extractText(event?.result?.content as Parameters<typeof extractText>[0]);
    if (text) summary.outputPreview = text.slice(0, 200);
  }

  return {
    toolName,
    rawDetails,
    normalizedArgs,
    toolIsError,
    summary,
    publicSummary: Object.keys(summary).length > 0 ? summary : undefined,
  };
}
