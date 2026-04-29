import { describe, expect, it } from "vitest";

import { createSessionStateStore } from "../server/chat/stream-state.js";

describe("session stream state store", () => {
  it("evicts the least recently accessed inactive session when full", () => {
    const store = createSessionStateStore();
    try {
      for (let i = 0; i < 20; i++) {
        store.getState(`/sessions/${i}.jsonl`);
      }

      store.getState("/sessions/0.jsonl");
      store.getState("/sessions/20.jsonl");

      expect(store.hasState("/sessions/0.jsonl")).toBe(true);
      expect(store.hasState("/sessions/1.jsonl")).toBe(false);
      expect(store.hasState("/sessions/20.jsonl")).toBe(true);
      expect(store.sessionState.size).toBe(20);
    } finally {
      store.destroy();
    }
  });

  it("does not evict streaming sessions for capacity cleanup", () => {
    const store = createSessionStateStore();
    try {
      for (let i = 0; i < 20; i++) {
        const ss = store.getState(`/sessions/${i}.jsonl`);
        ss.isStreaming = true;
      }

      store.getState("/sessions/20.jsonl");

      expect(store.sessionState.size).toBe(21);
      expect(store.hasState("/sessions/0.jsonl")).toBe(true);
      expect(store.hasState("/sessions/20.jsonl")).toBe(true);
    } finally {
      store.destroy();
    }
  });
});
