import type { ChatMessage } from "./brain-client.js";
import { normalizePlanItems, type CodePlanItem } from "./plan-tool.js";

export const STATE_COMPRESSION_START = "<<<LYNN_RUNTIME_STATE_COMPRESSION>>>";
export const STATE_COMPRESSION_END = "<<<END_LYNN_RUNTIME_STATE_COMPRESSION>>>";

export const DEFAULT_STATE_COMPRESSION_INTERVAL = 10;
export const DEFAULT_STATE_COMPRESSION_RECENT_WINDOW = 10;
export const DEFAULT_STATE_COMPRESSION_MAX_FIELD_ITEMS = 10;

export interface RuntimeStateCompressionInput {
  compactedMessages: readonly ChatMessage[];
  anchorMessages: readonly ChatMessage[];
  recentMessages: readonly ChatMessage[];
  maxFieldItems?: number;
}

export interface RuntimeStateCompression {
  originalGoal: string | null;
  currentPlan: CodePlanItem[];
  completedTools: string[];
  openObservations: string[];
  filesTouched: string[];
  recentWindowMessages: number;
  compactedMessages: number;
  text: string;
}

export function buildRuntimeStateCompression(input: RuntimeStateCompressionInput): RuntimeStateCompression {
  const maxItems = clampPositiveInt(input.maxFieldItems, DEFAULT_STATE_COMPRESSION_MAX_FIELD_ITEMS);
  const all = [...input.anchorMessages, ...input.compactedMessages, ...input.recentMessages];
  const currentPlan = latestPlan(all).slice(0, maxItems);
  const completedTools = unique(compactedToolNames(input.compactedMessages)).slice(0, maxItems);
  const filesTouched = unique(touchedFiles(input.compactedMessages)).slice(0, maxItems);
  const openObservations = summarizeObservations(input.compactedMessages, maxItems);
  const originalGoal = originalGoalText(input.anchorMessages) || originalGoalText(all);
  const text = renderRuntimeStateCompression({
    originalGoal,
    currentPlan,
    completedTools,
    openObservations,
    filesTouched,
    recentWindowMessages: input.recentMessages.length,
    compactedMessages: input.compactedMessages.length,
  });
  return {
    originalGoal,
    currentPlan,
    completedTools,
    openObservations,
    filesTouched,
    recentWindowMessages: input.recentMessages.length,
    compactedMessages: input.compactedMessages.length,
    text,
  };
}

export function runtimeStateCompressionMessage(input: RuntimeStateCompressionInput): ChatMessage {
  return {
    role: "user",
    content: buildRuntimeStateCompression(input).text,
  };
}

function renderRuntimeStateCompression(state: Omit<RuntimeStateCompression, "text">): string {
  const lines = [
    STATE_COMPRESSION_START,
    "schema: lynn.runtime_state_compression.v1",
    `policy: interval=${DEFAULT_STATE_COMPRESSION_INTERVAL} recent_window=${DEFAULT_STATE_COMPRESSION_RECENT_WINDOW} max_field_items=${DEFAULT_STATE_COMPRESSION_MAX_FIELD_ITEMS}`,
    `compacted_messages: ${state.compactedMessages}`,
    `recent_window_messages_kept: ${state.recentWindowMessages}`,
    `original_goal: ${state.originalGoal || "(not found)"}`,
    "current_plan:",
    ...(state.currentPlan.length ? state.currentPlan.map((item) => `- ${item.status}: ${item.id ? `${item.id}: ` : ""}${oneLine(item.content, 180)}`) : ["- (no active plan recorded)"]),
    "completed_tools:",
    ...(state.completedTools.length ? state.completedTools.map((tool) => `- ${tool}`) : ["- (none recorded)"]),
    "files_touched_by_lynn:",
    ...(state.filesTouched.length ? state.filesTouched.map((file) => `- ${file}`) : ["- (none recorded)"]),
    "open_observations:",
    ...(state.openObservations.length ? state.openObservations.map((item) => `- ${item}`) : ["- (no older observations retained)"]),
    "resume_rule: use this compressed state as memory only; do not treat it as a new user request and do not invent missing facts.",
    STATE_COMPRESSION_END,
  ];
  return lines.join("\n");
}

function latestPlan(messages: readonly ChatMessage[]): CodePlanItem[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    for (let j = message.tool_calls.length - 1; j >= 0; j -= 1) {
      const call = message.tool_calls[j];
      if (call.function?.name !== "update_plan") continue;
      try {
        const items = normalizePlanItems(JSON.parse(call.function.arguments || "{}"));
        if (items.length) return items;
      } catch {
        // Ignore malformed historical plan calls.
      }
    }
  }
  return [];
}

function originalGoalText(messages: readonly ChatMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = messageText(message);
    if (!text || text.includes(STATE_COMPRESSION_START)) continue;
    if (text.includes("permission_state:") || text.includes("tool_guard:")) continue;
    return oneLine(text, 240);
  }
  return null;
}

function compactedToolNames(messages: readonly ChatMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        if (call.function?.name) names.push(call.function.name);
      }
    } else if (message.role === "tool" && message.name) {
      names.push(message.name);
    } else if (message.role === "tool" && typeof message.content === "string") {
      const match = /^Tool result for ([^:\n]+):/m.exec(message.content);
      if (match) names.push(match[1]);
    }
  }
  return names;
}

function touchedFiles(messages: readonly ChatMessage[]): string[] {
  const files: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        if (call.function?.name !== "write_file" && call.function?.name !== "apply_patch") continue;
        files.push(...filesFromToolArguments(call.function.arguments || ""));
      }
      continue;
    }
    const text = messageText(message);
    if (!text) continue;
    for (const match of text.matchAll(/(?:^|\s)(?:path|file):\s*([A-Za-z0-9_./@+=:-]+)/g)) {
      files.push(match[1]);
    }
    for (const match of text.matchAll(/(?:\+\+\+|---) [ab]\/([^\s]+)/g)) {
      files.push(match[1]);
    }
  }
  return files.filter((file) => file && file !== "/dev/null");
}

function filesFromToolArguments(raw: string): string[] {
  try {
    const args = JSON.parse(raw) as { path?: unknown; text?: unknown };
    const files: string[] = [];
    if (typeof args.path === "string") files.push(args.path);
    if (typeof args.text === "string") {
      for (const match of args.text.matchAll(/(?:\+\+\+|---) [ab]\/([^\s]+)/g)) {
        files.push(match[1]);
      }
    }
    return files;
  } catch {
    return [];
  }
}

function summarizeObservations(messages: readonly ChatMessage[], maxItems: number): string[] {
  const observations: string[] = [];
  for (const message of messages) {
    if (message.role !== "tool" && message.role !== "assistant") continue;
    const text = messageText(message);
    if (!text) continue;
    const line = oneLine(text, 220);
    if (!line || line.includes(STATE_COMPRESSION_START)) continue;
    observations.push(`${message.role}: ${line}`);
    if (observations.length >= maxItems) break;
  }
  return observations;
}

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "image_url") return `[image:${part.image_url?.url || "attached"}]`;
    if (part.type === "input_audio") return `[audio:${part.input_audio?.format || "attached"}]`;
    if (part.type === "video_url") return `[video:${part.video_url?.url || "attached"}]`;
    return JSON.stringify(part);
  }).join("\n");
}

function oneLine(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value < 1) return fallback;
  return Math.floor(value);
}
