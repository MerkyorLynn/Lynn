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
      expect(streamEvents).not.toContainEqual(expect.objectContaining({ type: "text_delta" }));
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

  it("keeps the hard timeout armed when hub.send resolves before the retry stream closes", async () => {
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
        send: vi.fn(async () => undefined),
      };

      const scheduled = scheduleInternalRetry({
        sessionPath,
        reason: "empty_reply",
        retryPrompt: "请重新回答",
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
      await Promise.resolve();
      expect(hub.send).toHaveBeenCalledTimes(1);
      expect(state.isStreaming).toBe(true);

      await vi.advanceTimersByTimeAsync(60_001);

      expect(engine.abortSessionByPath).toHaveBeenCalledWith(sessionPath);
      expect(streamEvents).not.toContainEqual(expect.objectContaining({ type: "text_delta" }));
      expect(streamEvents).toContainEqual(expect.objectContaining({ type: "turn_end" }));
      expect(broadcasts).toContainEqual(expect.objectContaining({
        type: "status",
        isStreaming: false,
        sessionPath,
      }));
      expect(state.isStreaming).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not append retry fallback text after an already visible answer", async () => {
    vi.useFakeTimers();
    try {
      const sessionPath = "/sessions/current.jsonl";
      const state = createChatTurnState();
      state.visibleTextAcc = "已经生成了一段有效答案。";
      state.hasOutput = true;
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

      await vi.advanceTimersByTimeAsync(60_001);

      expect(streamEvents).toContainEqual(expect.objectContaining({ type: "turn_end" }));
      expect(streamEvents.filter((event) => event.type === "text_delta")).toHaveLength(0);
      expect(broadcasts).toContainEqual(expect.objectContaining({
        type: "status",
        isStreaming: false,
        sessionPath,
      }));
      expect(state.isStreaming).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
