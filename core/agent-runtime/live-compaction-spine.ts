import crypto from "node:crypto";
import type { ChatMessage, SessionFailureMetadata, SessionMessageMetadata } from "./types.js";
import type { MessageEntry, SessionEntry } from "./session-manager.js";
import type { LiveCompactionEntry, LiveCompactionPatchInput, LiveCompactionReplacement } from "./live-compaction-types.js";
import { contentSha256 } from "./live-compaction-store.js";

export const LIVE_COMPACTION_DEFAULTS = Object.freeze({
  enabled: false,
  minTokens: 20_000,
  keepRounds: 3,
  pointerTokens: 32_000,
  chunkMin: 1_000,
  chunkMax: 32_000,
  bigGate: 650_000,
  reserveTokens: 16_384,
});

export interface LiveCompactionSettings {
  enabled: boolean;
  minTokens: number;
  keepRounds: number;
  pointerTokens: number;
  chunkMin: number;
  chunkMax: number;
  bigGate: number;
  reserveTokens: number;
  contextWindow?: number | null;
}

export interface LiveCompactionBackupRequest {
  toolCallId: string;
  text: string;
}

export interface LiveCompactionPlan {
  patch: LiveCompactionPatchInput;
  backupRequests: LiveCompactionBackupRequest[];
  estimatedBefore: number;
  estimatedGain: number;
}

interface ToolRound {
  turnId: string;
  assistantEntryId: string;
  toolEntries: MessageEntry[];
}

function isMessageEntry(entry: SessionEntry): entry is MessageEntry {
  return entry.type === "message" && "message" in entry;
}

function isLiveCompactionEntry(entry: SessionEntry): entry is LiveCompactionEntry {
  return entry.type === "live_compaction" && "replacements" in entry;
}

function numberValue(value: unknown, fallback: number, min = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.round(number)) : fallback;
}

export function resolveLiveCompactionSettings(input: Partial<LiveCompactionSettings> = {}, env = process.env): LiveCompactionSettings {
  const enabledValue = input.enabled ?? ["1", "true", "yes"].includes(String(env.LYNN_LIVE_COMPACTION || "").toLowerCase());
  const contextWindow = numberValue(input.contextWindow, 0, 0) || null;
  const reserveTokens = numberValue(input.reserveTokens ?? env.LYNN_LIVE_COMPACTION_RESERVE_TOKENS, LIVE_COMPACTION_DEFAULTS.reserveTokens);
  const configuredGate = numberValue(input.bigGate ?? env.LYNN_LIVE_COMPACTION_BIG_GATE, LIVE_COMPACTION_DEFAULTS.bigGate, 1);
  const effectiveGate = contextWindow ? Math.min(configuredGate, Math.max(4_096, contextWindow - reserveTokens)) : configuredGate;
  return {
    enabled: Boolean(enabledValue),
    minTokens: numberValue(input.minTokens ?? env.LYNN_LIVE_COMPACTION_MIN_TOKENS, LIVE_COMPACTION_DEFAULTS.minTokens),
    keepRounds: numberValue(input.keepRounds ?? env.LYNN_LIVE_COMPACTION_KEEP_ROUNDS, LIVE_COMPACTION_DEFAULTS.keepRounds, 1),
    pointerTokens: numberValue(input.pointerTokens ?? env.LYNN_LIVE_COMPACTION_POINTER_TOKENS, LIVE_COMPACTION_DEFAULTS.pointerTokens),
    chunkMin: numberValue(input.chunkMin ?? env.LYNN_LIVE_COMPACTION_CHUNK_MIN, LIVE_COMPACTION_DEFAULTS.chunkMin),
    chunkMax: numberValue(input.chunkMax ?? env.LYNN_LIVE_COMPACTION_CHUNK_MAX, LIVE_COMPACTION_DEFAULTS.chunkMax, 1),
    bigGate: effectiveGate,
    reserveTokens,
    contextWindow,
  };
}

export function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return String(message.content ?? "");
  return message.content
    .map((part: any) => part && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

export function estimateBranchTokens(entries: readonly SessionEntry[]): number {
  return entries.reduce((sum, entry) => isMessageEntry(entry) ? sum + estimateTokens(entry.message) : sum, 0);
}

export function computeBranchDigest(entries: readonly SessionEntry[]): string {
  const body = entries.map((entry) => `${entry.id}\0${entry.type}\0${entry.parentId || ""}`).join("\n");
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}

export function isRealUserBoundary(entry: MessageEntry): boolean {
  if (entry.message.role !== "user") return false;
  const origin = entry.metadata?.origin;
  return origin === undefined || origin === "unknown" || origin === "user_input";
}

function failureMetadata(entry: MessageEntry): SessionFailureMetadata | undefined {
  const failure = entry.metadata?.failure;
  if (!failure) return undefined;
  const values = Object.values(failure).filter((value) => value !== undefined && value !== null && value !== "");
  return values.length ? failure : undefined;
}

export function hasRecognizedToolFailure(entry: MessageEntry): boolean {
  const failure = failureMetadata(entry);
  if (!failure) return false;
  return failure.isError === true
    || failure.exitCode !== null && failure.exitCode !== undefined && failure.exitCode !== 0
    || Boolean(failure.errorType || failure.stderr || failure.stdout || failure.failureReason);
}

function toolRoundId(entry: MessageEntry): string {
  return entry.metadata?.toolRoundId || entry.metadata?.turnId || entry.id;
}

export function collectCompletedToolRounds(entries: readonly SessionEntry[]): ToolRound[] {
  const rounds: ToolRound[] = [];
  let pending: { turnId: string; assistantEntryId: string; expected: Set<string>; toolEntries: MessageEntry[] } | null = null;
  const abandon = () => { pending = null; };

  for (const entry of entries) {
    if (!isMessageEntry(entry)) continue;
    const message = entry.message;
    if (isRealUserBoundary(entry)) {
      abandon();
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      abandon();
      const ids = message.tool_calls.map((call) => String(call?.id || "")).filter(Boolean);
      if (ids.length === 0 || new Set(ids).size !== ids.length) continue;
      pending = {
        turnId: toolRoundId(entry),
        assistantEntryId: entry.id,
        expected: new Set(ids),
        toolEntries: [],
      };
      continue;
    }
    if (message.role === "tool") {
      if (!pending || !message.tool_call_id || !pending.expected.has(message.tool_call_id)) {
        abandon();
        continue;
      }
      if (pending.toolEntries.some((candidate) => candidate.message.tool_call_id === message.tool_call_id)) {
        abandon();
        continue;
      }
      pending.toolEntries.push(entry);
      pending.expected.delete(message.tool_call_id);
      if (pending.expected.size === 0) {
        rounds.push({ turnId: pending.turnId, assistantEntryId: pending.assistantEntryId, toolEntries: pending.toolEntries });
        pending = null;
      }
      continue;
    }
    if (pending && message.role === "assistant") abandon();
  }
  return rounds;
}

function boundedExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const edge = Math.max(80, Math.floor(maxChars / 2));
  return `${text.slice(0, edge)}\n[... live compact middle omitted ...]\n${text.slice(-edge)}`;
}

function pointerText({ rawRef, sha256, bytes, toolCallId, failure }: { rawRef: string; sha256: string; bytes: number; toolCallId: string; failure?: SessionFailureMetadata }): string {
  const failureText = failure?.failureReason || failure?.errorType || (failure?.isError ? "tool error" : "");
  return [
    `[Lynn Live Compact] tool result ${toolCallId} was replaced by a verified local pointer.`,
    `Original: ${rawRef}`,
    `sha256:${sha256} bytes:${bytes}`,
    failureText ? `Failure: ${boundedExcerpt(failureText, 240)}` : "",
  ].filter(Boolean).join("\n");
}

function replacementFor(entry: MessageEntry, rawRef: string, settings: LiveCompactionSettings): { replacement: string; gain: number; request: LiveCompactionBackupRequest } | null {
  // Keep the complete diagnostic on the surface. A pointer plus a short
  // reason can hide stderr, stdout, or the exit code needed to recover.
  if (hasRecognizedToolFailure(entry)) return null;
  const text = messageText(entry.message);
  const tokens = estimateTokens(text);
  if (!entry.message.tool_call_id || tokens < settings.chunkMin) return null;
  const hash = contentSha256(text);
  const bytes = Buffer.byteLength(text, "utf8");
  const failure = failureMetadata(entry);
  const pointer = pointerText({ rawRef, sha256: hash, bytes, toolCallId: entry.message.tool_call_id, failure });
  const replacement = tokens >= settings.pointerTokens
    ? pointer
    : `${pointer}\n\nExcerpt:\n${boundedExcerpt(text, Math.max(640, settings.chunkMin * 2))}`;
  const gain = Math.max(0, tokens - estimateTokens(replacement));
  if (gain < settings.chunkMin) return null;
  return { replacement, gain, request: { toolCallId: entry.message.tool_call_id, text } };
}

export function planLiveCompaction(options: {
  branch: readonly SessionEntry[];
  baseLeafId: string;
  previousPatchId: string | null;
  checkpointId: string | null;
  turnId: string;
  settings: LiveCompactionSettings;
  rawRefFor: (toolCallId: string) => string;
}): LiveCompactionPlan | null {
  const { branch, baseLeafId, previousPatchId, checkpointId, turnId, settings, rawRefFor } = options;
  if (!settings.enabled) return null;
  const baseIndex = branch.findIndex((entry) => entry.id === baseLeafId);
  if (baseIndex < 0) return null;
  const checkpointIndex = checkpointId ? branch.findIndex((entry) => entry.id === checkpointId) : -1;
  const scope = branch.slice(Math.max(0, checkpointIndex + 1), baseIndex + 1);
  const estimatedBefore = estimateBranchTokens(scope);
  if (estimatedBefore < settings.minTokens || estimatedBefore >= settings.bigGate) return null;

  const patchedIds = new Set<string>();
  for (const entry of scope) {
    if (isLiveCompactionEntry(entry)) for (const replacement of entry.replacements) patchedIds.add(replacement.entryId);
  }
  const rounds = collectCompletedToolRounds(scope).filter((round) => round.toolEntries.every((entry) => !patchedIds.has(entry.id)));
  if (rounds.length <= settings.keepRounds) return null;

  const candidates = rounds.slice(0, -settings.keepRounds);
  const replacements: LiveCompactionReplacement[] = [];
  const backupRequests: LiveCompactionBackupRequest[] = [];
  let estimatedGain = 0;
  for (const round of candidates) {
    for (const entry of round.toolEntries) {
      const toolCallId = entry.message.tool_call_id || "";
      const rawRef = rawRefFor(toolCallId);
      const planned = replacementFor(entry, rawRef, settings);
      if (!planned) continue;
      const text = messageText(entry.message);
      const hash = contentSha256(text);
      const bytes = Buffer.byteLength(text, "utf8");
      replacements.push({
        entryId: entry.id,
        toolCallId,
        originalContentSha256: hash,
        bytes,
        rawRef,
        sha256: hash,
        pointer: planned.replacement.split("\n\nExcerpt:")[0],
        replacement: planned.replacement,
      });
      backupRequests.push(planned.request);
      estimatedGain += planned.gain;
      if (estimatedGain >= settings.chunkMax) break;
    }
    if (estimatedGain >= settings.chunkMax) break;
  }
  if (estimatedGain < settings.chunkMin || replacements.length === 0) return null;

  return {
    patch: {
      version: 1,
      patchId: crypto.randomUUID(),
      baseLeafId,
      baseBranchDigest: computeBranchDigest(branch.slice(0, baseIndex + 1)),
      previousPatchId,
      checkpointId,
      turnId,
      sourceRange: { firstEntryId: replacements[0].entryId, lastEntryId: replacements.at(-1)!.entryId },
      replacements,
    },
    backupRequests,
    estimatedBefore,
    estimatedGain,
  };
}
