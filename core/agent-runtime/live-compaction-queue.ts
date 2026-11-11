import type { LiveCompactionBackupRequest } from "./live-compaction-spine.js";
import { LiveCompactionStore, type LiveRawRecord } from "./live-compaction-store.js";

type PendingCapture = Promise<LiveRawRecord>;

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isRetryableCaptureError(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code || "");
  return ["EBUSY", "EACCES", "EPERM", "EMFILE", "ENFILE", "ESHADOWBUSY"].includes(code);
}

/** Serialize writes for one session root while yielding before large captures. */
export class LiveCompactionCaptureQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, PendingCapture>();

  constructor(private readonly store: LiveCompactionStore) {}

  enqueue(toolCallId: string, text: string): PendingCapture {
    const existing = this.pending.get(toolCallId);
    if (existing) return existing;

    const run = this.tail.then(async () => {
      await nextTurn();
      let attempt = 0;
      while (true) {
        try {
          return await this.store.captureAsync(toolCallId, text);
        } catch (error) {
          if (!isRetryableCaptureError(error) || attempt >= 2) throw error;
          attempt += 1;
          await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
        }
      }
    });
    const result = run.finally(() => {
      if (this.pending.get(toolCallId) === result) this.pending.delete(toolCallId);
    });
    this.pending.set(toolCallId, result);
    this.tail = result.catch(() => undefined);
    return result;
  }

  capture(requests: readonly LiveCompactionBackupRequest[]): Promise<LiveRawRecord[]> {
    return Promise.all(requests.map((request) => this.enqueue(request.toolCallId, request.text)));
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}
