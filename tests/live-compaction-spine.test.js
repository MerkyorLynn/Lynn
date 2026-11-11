import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../core/agent-runtime/session-manager.js";
import { LynnAgentSession } from "../core/agent-runtime/create-session.js";
import {
  collectCompletedToolRounds,
  computeBranchDigest,
  hasRecognizedToolFailure,
  planLiveCompaction,
  resolveLiveCompactionSettings,
} from "../core/agent-runtime/live-compaction-spine.js";
import { LiveCompactionStore, rawBackupRef } from "../core/agent-runtime/live-compaction-store.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-live-compact-"));
}

function addRound(manager, index, size = 20_000) {
  const turnId = `turn-${index}`;
  const toolRoundId = `round-${index}`;
  const callId = `call-${index}`;
  manager.appendMessage({ role: "user", content: `question ${index}` }, { origin: "user_input", turnId });
  manager.appendMessage({
    role: "assistant",
    content: "",
    tool_calls: [{ id: callId, type: "function", function: { name: "read", arguments: "{}" } }],
  }, { origin: "assistant", turnId, toolRoundId });
  manager.appendMessage({ role: "tool", tool_call_id: callId, name: "read", content: "x".repeat(size) }, {
    origin: "tool_result",
    turnId,
    toolRoundId,
  });
  manager.appendMessage({ role: "assistant", content: `done ${index}` }, { origin: "assistant", turnId });
}

describe("live compaction spine", () => {
  it("only returns fully closed tool rounds and preserves user boundaries", () => {
    const manager = SessionManager.inMemory();
    addRound(manager, 1, 4_000);
    manager.appendMessage({ role: "user", content: "new boundary" }, { origin: "user_input", turnId: "boundary" });
    const entries = manager.getBranch();
    expect(collectCompletedToolRounds(entries)).toHaveLength(1);

    const incomplete = SessionManager.inMemory();
    incomplete.appendMessage({ role: "user", content: "q" }, { origin: "user_input", turnId: "t" });
    incomplete.appendMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "a", type: "function", function: { name: "read", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "read", arguments: "{}" } },
      ],
    }, { origin: "assistant", turnId: "t", toolRoundId: "r" });
    incomplete.appendMessage({ role: "tool", tool_call_id: "a", content: "only one" }, { origin: "tool_result", turnId: "t", toolRoundId: "r" });
    expect(collectCompletedToolRounds(incomplete.getBranch())).toHaveLength(0);
  });

  it("backs up, commits, projects, and restores a patch after restart", () => {
    const root = tempDir();
    const manager = SessionManager.create(root, root);
    for (let index = 0; index < 5; index += 1) addRound(manager, index);
    const branch = manager.getBranch();
    const store = new LiveCompactionStore(manager.getSessionDir(), manager.getSessionId());
    const settings = resolveLiveCompactionSettings({ enabled: true, minTokens: 20_000, chunkMin: 500, chunkMax: 32_000 });
    const plan = planLiveCompaction({
      branch,
      baseLeafId: manager.getLeafId(),
      previousPatchId: null,
      checkpointId: null,
      turnId: "close-turn",
      settings,
      rawRefFor: (toolCallId) => rawBackupRef(store.root, toolCallId),
    });
    expect(plan).toBeTruthy();
    for (const request of plan.backupRequests) store.capture(request.toolCallId, request.text);
    manager.appendLiveCompaction(plan.patch);
    const projected = manager.buildSessionContext().messages;
    expect(projected.some((message) => String(message.content).includes("[Lynn Live Compact]"))).toBe(true);
    expect(projected.filter((message) => message.role === "tool" && String(message.content).includes("[Lynn Live Compact]")).length).toBeGreaterThan(0);

    const reopened = SessionManager.open(manager.getSessionFile(), root);
    const restored = reopened.buildSessionContext().messages;
    expect(restored.some((message) => String(message.content).includes("[Lynn Live Compact]"))).toBe(true);
    expect(computeBranchDigest(reopened.getBranch().slice(0, reopened.getBranch().length - 1))).toBeTruthy();

    const replacement = plan.patch.replacements[0];
    fs.unlinkSync(replacement.rawRef);
    const fallback = reopened.buildSessionContext().messages;
    expect(fallback.some((message) => String(message.content).includes("x".repeat(100)))).toBe(true);

    const chainState = reopened.getLiveCompactionChainStatus();
    expect(chainState.valid).toBe(false);
    expect(chainState.latest).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("repairs a raw-only crash by writing the missing metadata on retry", () => {
    const root = tempDir();
    const store = new LiveCompactionStore(root, "sid");
    const ref = rawBackupRef(store.root, "call-crash");
    fs.mkdirSync(store.root, { recursive: true });
    fs.writeFileSync(ref, "raw body");
    const record = store.capture("call-crash", "raw body");
    expect(record.bytes).toBe(8);
    expect(fs.existsSync(`${ref}.meta.json`)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fails closed when existing raw metadata is inconsistent", () => {
    const root = tempDir();
    const store = new LiveCompactionStore(root, "sid");
    const record = store.capture("call-meta", "raw body");
    fs.writeFileSync(`${record.rawRef}.meta.json`, JSON.stringify({ version: 1, toolCallId: "wrong", bytes: record.bytes, sha256: record.sha256 }));
    expect(() => store.capture("call-meta", "raw body")).toThrow(/metadata verification failed/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps failed tool diagnostics out of pointer replacement", () => {
    const manager = SessionManager.inMemory();
    const failedCall = "failed-call";
    manager.appendMessage({ role: "user", content: "failed round" }, { origin: "user_input", turnId: "failed-turn" });
    manager.appendMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: failedCall, type: "function", function: { name: "read", arguments: "{}" } }],
    }, { origin: "assistant", turnId: "failed-turn", toolRoundId: "failed-round" });
    manager.appendMessage({ role: "tool", tool_call_id: failedCall, content: "stderr: permission denied\n".repeat(2_000) }, {
      origin: "tool_result",
      turnId: "failed-turn",
      toolRoundId: "failed-round",
      failure: { isError: true, exitCode: 1, stderr: "permission denied" },
    });
    manager.appendMessage({ role: "assistant", content: "failed" }, { origin: "assistant", turnId: "failed-turn" });
    for (let index = 1; index < 5; index += 1) addRound(manager, index);
    const plan = planLiveCompaction({
      branch: manager.getBranch(),
      baseLeafId: manager.getLeafId(),
      previousPatchId: null,
      checkpointId: null,
      turnId: "failure-check",
      settings: resolveLiveCompactionSettings({ enabled: true, minTokens: 20_000, chunkMin: 500, chunkMax: 32_000 }),
      rawRefFor: (id) => `/tmp/${id}`,
    });
    expect(plan?.patch.replacements.some((replacement) => replacement.toolCallId === failedCall)).toBe(false);
  });

  it("does not treat a successful zero-exit metadata record as a failure", () => {
    expect(hasRecognizedToolFailure({
      type: "message",
      id: "success-tool",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "tool", tool_call_id: "success-call", content: "ok" },
      metadata: { origin: "tool_result", failure: { isError: false, exitCode: 0 } },
    })).toBe(false);
  });

  it("refuses an empty official compaction summary", () => {
    const manager = SessionManager.inMemory();
    expect(() => manager.appendCompaction("  ", "entry", 0)).toThrow(/summary is empty/);
    expect(manager.getEntries()).toHaveLength(0);
  });

  it("does not compact when disabled", () => {
    const manager = SessionManager.inMemory();
    for (let index = 0; index < 5; index += 1) addRound(manager, index);
    const plan = planLiveCompaction({
      branch: manager.getBranch(),
      baseLeafId: manager.getLeafId(),
      previousPatchId: null,
      checkpointId: null,
      turnId: "disabled",
      settings: resolveLiveCompactionSettings(),
      rawRefFor: (id) => `/tmp/${id}`,
    });
    expect(plan).toBeNull();
  });

  it("caps an explicit big gate to the model context reserve", () => {
    const settings = resolveLiveCompactionSettings({
      enabled: true,
      bigGate: 100_000,
      contextWindow: 40_000,
      reserveTokens: 4_000,
    });
    expect(settings.bigGate).toBe(36_000);
  });

  it("runs the shared session close hook without calling a model", async () => {
    const root = tempDir();
    const manager = SessionManager.create(root, root);
    const session = new LynnAgentSession({
      cwd: root,
      sessionManager: manager,
      model: { provider: "local-test", id: "test", contextWindow: 128_000, baseUrl: "http://127.0.0.1:1" },
      liveCompaction: { enabled: true, minTokens: 20_000, chunkMin: 500, chunkMax: 32_000 },
    });
    for (let index = 0; index < 5; index += 1) addRound(manager, index);
    session.activeTurnId = "runtime-close";
    session.activeTurnClosed = false;
    session.closeTurnForLiveCompaction();
    expect(manager.getLatestLiveCompaction()).toBeNull();
    await session.flushLiveCompaction();
    expect(manager.getLatestLiveCompaction()).toBeTruthy();
    expect(session.messages.some((message) => String(message.content).includes("[Lynn Live Compact]"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
