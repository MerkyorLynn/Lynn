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
        promise: Promise.resolve({ action: "confirmed_once" }),
      })),
    };
    const emitEvent = vi.fn();
    const sessionAllowlist = { check: vi.fn(() => false), add: vi.fn() };
    const tool = wrapPathTool(
      { name: "write", execute: executed },
      { check: () => ({ allowed: false, reason: "blocked" }) },
      "write",
      "/repo",
      {
        mode: "authorized",
        allowlist: { check: vi.fn(() => false), add: vi.fn() },
        sessionAllowlist,
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
    expect(sessionAllowlist.add).not.toHaveBeenCalled();
  });

  it("stores session authorization in session allowlist", async () => {
    const executed = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const sessionAllowlist = { check: vi.fn(() => false), add: vi.fn() };
    const allowlist = { check: vi.fn(() => false), add: vi.fn() };

    const tool = wrapPathTool(
      { name: "write", execute: executed },
      { check: () => ({ allowed: false, reason: "blocked" }) },
      "write",
      "/repo",
      {
        mode: "authorized",
        allowlist,
        sessionAllowlist,
        confirmStore: {
          create: vi.fn(() => ({
            confirmId: "confirm-2",
            promise: Promise.resolve({ action: "confirmed_session" }),
          })),
        },
        emitEvent: vi.fn(),
        getSessionPath: () => "/sessions/current.jsonl",
      },
    );

    await tool.execute("call-2", { path: "notes.md" });

    expect(sessionAllowlist.add).toHaveBeenCalledWith(expect.objectContaining({
      category: "path_write",
      identifier: expect.stringContaining("notes.md"),
    }));
    expect(allowlist.add).not.toHaveBeenCalled();
    expect(executed).toHaveBeenCalled();
  });

  it("stores persistent authorization in persistent allowlist", async () => {
    const executed = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const sessionAllowlist = { check: vi.fn(() => false), add: vi.fn() };
    const allowlist = { check: vi.fn(() => false), add: vi.fn() };

    const tool = wrapPathTool(
      { name: "write", execute: executed },
      { check: () => ({ allowed: false, reason: "blocked" }) },
      "write",
      "/repo",
      {
        mode: "authorized",
        allowlist,
        sessionAllowlist,
        confirmStore: {
          create: vi.fn(() => ({
            confirmId: "confirm-3",
            promise: Promise.resolve({ action: "confirmed_persistent" }),
          })),
        },
        emitEvent: vi.fn(),
        getSessionPath: () => "/sessions/current.jsonl",
      },
    );

    await tool.execute("call-3", { path: "notes.md" });

    expect(allowlist.add).toHaveBeenCalledWith(expect.objectContaining({
      category: "path_write",
      identifier: expect.stringContaining("notes.md"),
    }));
    expect(sessionAllowlist.add).not.toHaveBeenCalled();
    expect(executed).toHaveBeenCalled();
  });
});
