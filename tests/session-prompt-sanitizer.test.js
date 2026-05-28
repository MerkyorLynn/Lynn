import { describe, expect, it, vi } from "vitest";
import { runPromptWithIntegrity } from "../core/session-prompt-sanitizer.js";

describe("session prompt sanitizer helpers", () => {
  it("runs a prompt while collecting assistant text deltas", async () => {
    let handler = null;
    const unsub = vi.fn();
    const session = {
      subscribe: vi.fn((fn) => {
        handler = fn;
        return unsub;
      }),
      prompt: vi.fn(async () => {
        handler?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
        handler?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } });
      }),
    };

    await expect(runPromptWithIntegrity(session, "hi", { images: [] })).resolves.toBe("hello world");
    expect(session.prompt).toHaveBeenCalledWith("hi", { images: [] });
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes when prompt throws", async () => {
    const unsub = vi.fn();
    const session = {
      subscribe: vi.fn(() => unsub),
      prompt: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    await expect(runPromptWithIntegrity(session, "hi")).rejects.toThrow("boom");
    expect(session.prompt).toHaveBeenCalledWith("hi");
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
