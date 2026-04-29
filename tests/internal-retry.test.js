import { describe, expect, it, vi } from "vitest";
import { createChatTurnState } from "../server/chat/turn-state.js";
import { scheduleInternalRetry } from "../server/chat/internal-retry.js";

describe("internal retry scheduling", () => {
  it("hard-closes a hung internal retry so later turns are not fenced by still-streaming state", async () => {
    vi.useFakeTimers();
    try {
      const sessionPath = "/sessions/current.jsonl";
      const state = createChatTurnState();
      const broadcasts = [];
      const streamEvents = [];
      const engine = {
        isSessionStreaming: vi.fn(() => false),
        abortSessionByPath: vi.fn(async () => true),
      };
      const hub = {
        send: vi.fn(() => new Promise(() => {})),
      };

      const scheduled = scheduleInternalRetry({
        sessionPath,
        reason: "truncated_structured_answer",
        retryPrompt: "请补全答案",
        getState: () => state,
        broadcast: (event) => broadcasts.push(event),
        hub,
        engine,
        scheduleSilentBrainAbort: vi.fn(),
        clearSilentBrainAbort: vi.fn(),
        closeStreamAfterError: vi.fn(),
        emitStreamEvent: (_sessionPath, _state, event) => streamEvents.push(event),
      });

      expect(scheduled).toBe(true);
      await Promise.resolve();
      expect(hub.send).toHaveBeenCalledTimes(1);
      expect(state.isStreaming).toBe(true);

      await vi.advanceTimersByTimeAsync(60_001);

      expect(engine.abortSessionByPath).toHaveBeenCalledWith(sessionPath);
      expect(streamEvents).toContainEqual(expect.objectContaining({ type: "turn_end" }));
      expect(streamEvents).toContainEqual(expect.objectContaining({ type: "text_delta" }));
      expect(broadcasts).toContainEqual(expect.objectContaining({
        type: "status",
        isStreaming: false,
        sessionPath,
      }));
      expect(state.isStreaming).toBe(false);
      expect(state.activeStreamToken).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
