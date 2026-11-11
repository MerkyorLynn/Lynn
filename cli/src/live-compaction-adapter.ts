import path from "node:path";
import type { ChatMessage } from "./brain-client.js";
import { resolveDataDir } from "./session/store.js";
import type { MessageEntry, SessionEntry } from "../../core/agent-runtime/session-manager.js";
import { planLiveCompaction, resolveLiveCompactionSettings } from "../../core/agent-runtime/live-compaction-spine.js";
import { LiveCompactionStore, rawBackupRef } from "../../core/agent-runtime/live-compaction-store.js";
import { LiveCompactionCaptureQueue } from "../../core/agent-runtime/live-compaction-queue.js";

export interface CliLiveCompactionResult {
  replaced: number;
  estimatedGain: number;
}

/**
 * CLI-specific adapter. The CLI has its own in-memory loop and does not share
 * LynnAgentSession's JSONL projection yet. It therefore reuses the same safe
 * planner/raw store, but applies a verified replacement directly to the active
 * message array. It is opt-in until CLI session persistence adopts the same
 * live_compaction entry format.
 */
export class CliLiveCompactionAdapter {
  private readonly store: LiveCompactionStore;
  private readonly queue: LiveCompactionCaptureQueue;
  private readonly settings = resolveLiveCompactionSettings({ enabled: true });
  private readonly ids = new WeakMap<object, string>();
  private sequence = 0;

  constructor(dataDir = resolveDataDir(), runId = "cli") {
    this.store = new LiveCompactionStore(path.join(dataDir, "agents", "cli"), runId);
    this.queue = new LiveCompactionCaptureQueue(this.store);
  }

  compact(messages: ChatMessage[]): CliLiveCompactionResult | null {
    if (!["1", "true", "yes"].includes(String(process.env.LYNN_LIVE_COMPACTION || "").toLowerCase())) return null;
    if (messages.length < 2) return null;
    const entries = this.toEntries(messages);
    const baseLeafId = entries.at(-1)?.id;
    if (!baseLeafId) return null;
    const plan = planLiveCompaction({
      branch: entries,
      baseLeafId,
      previousPatchId: null,
      checkpointId: null,
      turnId: `cli-${Date.now()}`,
      settings: this.settings,
      rawRefFor: (toolCallId) => rawBackupRef(this.store.root, toolCallId),
    });
    if (!plan) return null;
    for (const request of plan.backupRequests) this.store.capture(request.toolCallId, request.text);
    const byId = new Map(entries.filter((entry): entry is MessageEntry => entry.type === "message").map((entry) => [entry.id, entry]));
    let replaced = 0;
    for (const replacement of plan.patch.replacements) {
      const entry = byId.get(replacement.entryId);
      if (!entry) continue;
      entry.message.content = replacement.replacement;
      replaced += 1;
    }
    return replaced ? { replaced, estimatedGain: plan.estimatedGain } : null;
  }

  async compactAsync(messages: ChatMessage[]): Promise<CliLiveCompactionResult | null> {
    if (!["1", "true", "yes"].includes(String(process.env.LYNN_LIVE_COMPACTION || "").toLowerCase())) return null;
    if (messages.length < 2) return null;
    const entries = this.toEntries(messages);
    const baseLeafId = entries.at(-1)?.id;
    if (!baseLeafId) return null;
    const plan = planLiveCompaction({
      branch: entries,
      baseLeafId,
      previousPatchId: null,
      checkpointId: null,
      turnId: `cli-${Date.now()}`,
      settings: this.settings,
      rawRefFor: (toolCallId) => rawBackupRef(this.store.root, toolCallId),
    });
    if (!plan) return null;
    await this.queue.capture(plan.backupRequests);
    const byId = new Map(entries.filter((entry): entry is MessageEntry => entry.type === "message").map((entry) => [entry.id, entry]));
    let replaced = 0;
    for (const replacement of plan.patch.replacements) {
      const entry = byId.get(replacement.entryId);
      if (!entry) continue;
      entry.message.content = replacement.replacement;
      replaced += 1;
    }
    return replaced ? { replaced, estimatedGain: plan.estimatedGain } : null;
  }

  private toEntries(messages: ChatMessage[]): SessionEntry[] {
    let previousId: string | null = null;
    let activeRoundId: string | undefined;
    const entries: MessageEntry[] = [];
    for (const message of messages) {
      const object = message as object;
      let id = this.ids.get(object);
      if (!id) {
        id = `cli-live-${++this.sequence}`;
        this.ids.set(object, id);
      }
      if (message.role === "assistant" && message.tool_calls?.length) activeRoundId = `${id}-tools`;
      const entry: MessageEntry = {
        type: "message",
        id,
        parentId: previousId,
        timestamp: new Date().toISOString(),
        message: message as any,
        metadata: {
          origin: message.role === "user" ? "user_input" : message.role === "tool" ? "tool_result" : "assistant",
          turnId: id,
          toolRoundId: activeRoundId,
        },
      };
      entries.push(entry);
      previousId = id;
      if (message.role === "assistant" && !message.tool_calls?.length) activeRoundId = undefined;
    }
    return entries;
  }
}

export function createCliLiveCompactionAdapter(runId: string): CliLiveCompactionAdapter {
  return new CliLiveCompactionAdapter(resolveDataDir(), runId);
}
