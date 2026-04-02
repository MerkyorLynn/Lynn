import { describe, expect, it, vi } from "vitest";
import { loadLocale } from "../server/i18n.js";
import { wrapPathTool } from "../lib/sandbox/tool-wrapper.js";

loadLocale("en");

describe("tool authorization session path propagation", () => {
  it("uses dynamic getSessionPath for confirmation creation and event emission", async () => {
    const executed = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const confirmStore = {
      create: vi.fn(() => ({
        confirmId: "confirm-1",
        promise: Promise.resolve({ action: "confirmed" }),
      })),
    };
    const emitEvent = vi.fn();
    const tool = wrapPathTool(
      { name: "write", execute: executed },
      { check: () => ({ allowed: false, reason: "blocked" }) },
      "write",
      "/repo",
      {
        mode: "authorized",
        allowlist: { check: vi.fn(() => false), add: vi.fn() },
        confirmStore,
        emitEvent,
        getSessionPath: () => "/sessions/current.jsonl",
      },
    );

    await tool.execute("call-1", { path: "notes.md" });

    expect(confirmStore.create).toHaveBeenCalledWith(
      "tool_authorization",
      expect.objectContaining({
        command: "write notes.md",
        category: "path_write",
      }),
      "/sessions/current.jsonl",
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool_authorization",
        confirmId: "confirm-1",
      }),
      "/sessions/current.jsonl",
    );
    expect(executed).toHaveBeenCalled();
  });
});
