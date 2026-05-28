import { describe, expect, it, vi } from "vitest";
import {
  abortAllStreamingSessions,
  abortCachedSessionByPath,
  closeAllCachedSessions,
  closeCachedSession,
  getCachedSessionByPath,
  isCachedSessionStreaming,
} from "../core/session-lifecycle.js";

describe("session lifecycle helpers", () => {
  it("aborts only streaming sessions and ignores abort failures", async () => {
    const abortOk = vi.fn(async () => {});
    const abortFail = vi.fn(async () => { throw new Error("closed"); });
    const abortIdle = vi.fn(async () => {});
    const sessions = new Map([
      ["a", { session: { isStreaming: true, abort: abortOk } }],
      ["b", { session: { isStreaming: true, abort: abortFail } }],
      ["c", { session: { isStreaming: false, abort: abortIdle } }],
    ]);

    await expect(abortAllStreamingSessions(sessions)).resolves.toBe(2);
    expect(abortOk).toHaveBeenCalledTimes(1);
    expect(abortFail).toHaveBeenCalledTimes(1);
    expect(abortIdle).not.toHaveBeenCalled();
  });

  it("closes a cached session with memory notification, unsubscribe, and confirm cleanup", async () => {
    const abort = vi.fn(async () => {});
    const unsub = vi.fn();
    const notifySessionEnd = vi.fn();
    const abortBySession = vi.fn();
    const setCurrentSession = vi.fn();
    const sessions = new Map([
      ["current", { agentId: "agent-a", session: { isStreaming: true, abort }, unsub }],
    ]);

    await closeCachedSession({
      sessions,
      sessionPath: "current",
      currentSessionPath: "current",
      setCurrentSession,
      getAgentById: (agentId) => ({ id: agentId }),
      getFallbackAgent: () => ({ id: "fallback" }),
      notifySessionEnd,
      getConfirmStore: () => ({ abortBySession }),
    });

    expect(notifySessionEnd).toHaveBeenCalledWith({ id: "agent-a" }, "current", "close session");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(abortBySession).toHaveBeenCalledWith("current");
    expect(sessions.has("current")).toBe(false);
    expect(setCurrentSession).toHaveBeenCalledWith(null);
  });

  it("closes all cached sessions and clears the active session reference", async () => {
    const abort = vi.fn(async () => {});
    const unsubA = vi.fn();
    const unsubB = vi.fn();
    const setCurrentSession = vi.fn();
    const sessions = new Map([
      ["a", { session: { isStreaming: true, abort }, unsub: unsubA }],
      ["b", { session: { isStreaming: false }, unsub: unsubB }],
    ]);

    await closeAllCachedSessions({ sessions, setCurrentSession });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(unsubA).toHaveBeenCalledTimes(1);
    expect(unsubB).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(0);
    expect(setCurrentSession).toHaveBeenCalledWith(null);
  });

  it("reads and aborts cached sessions by path", async () => {
    const abort = vi.fn(async () => {});
    const session = { isStreaming: true, abort };
    const sessions = new Map([["s", { session }]]);

    expect(getCachedSessionByPath(sessions, "s")).toBe(session);
    expect(isCachedSessionStreaming(sessions, "s")).toBe(true);
    await expect(abortCachedSessionByPath(sessions, "s")).resolves.toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    await expect(abortCachedSessionByPath(sessions, "missing")).resolves.toBe(false);
  });
});
