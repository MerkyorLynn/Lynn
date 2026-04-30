import { describe, expect, it, vi } from "vitest";
import { createLifecycleHooks } from "../server/chat/lifecycle-hooks.js";

describe("createLifecycleHooks", () => {
  it("runs handlers in registration order and supports unsubscribe", () => {
    const hooks = createLifecycleHooks();
    const seen = [];
    hooks.tap("tool_start", () => seen.push("a"));
    const off = hooks.tap("tool_start", () => seen.push("b"));

    expect(hooks.run("tool_start", { toolName: "bash" })).toBe(2);
    off();
    expect(hooks.run("tool_start", { toolName: "bash" })).toBe(1);
    expect(seen).toEqual(["a", "b", "a"]);
  });

  it("isolates handler failures", () => {
    const onError = vi.fn();
    const hooks = createLifecycleHooks({ onError });
    const after = vi.fn();
    hooks.tap("turn_end", () => {
      throw new Error("boom");
    });
    hooks.tap("turn_end", after);

    hooks.run("turn_end", { sessionPath: "/tmp/session.jsonl" });

    expect(onError).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
  });
});
