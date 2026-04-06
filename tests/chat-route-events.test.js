import { Hono } from "hono";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChatRoute } from "../server/routes/chat.js";

function makeWebSocketHarness() {
  const clients = [];
  const upgradeWebSocket = (factory) => (c) => {
    const client = {
      readyState: 1,
      sent: [],
      close: vi.fn(),
      send(payload) {
        this.sent.push(JSON.parse(payload));
      },
    };
    clients.push(client);
    const handlers = factory(c);
    handlers.onOpen?.({}, client);
    return new Response(null, { status: 200 });
  };
  return { clients, upgradeWebSocket };
}

describe("chat route event forwarding", () => {
  let subscribed;
  let hub;
  let engine;
  let app;
  let clients;
  let editRollbackStore;

  beforeEach(() => {
    subscribed = null;
    hub = {
      subscribe: vi.fn((handler) => {
        subscribed = handler;
        return () => {};
      }),
    };
    engine = {
      currentSessionPath: "/sessions/current.jsonl",
      abortAllStreaming: vi.fn(async () => 0),
      getSessionByPath: vi.fn(() => ({ messages: [] })),
      isSessionStreaming: vi.fn(() => false),
      promptSession: vi.fn(),
      steerSession: vi.fn(() => false),
      abortSession: vi.fn(() => false),
      cwd: process.cwd(),
    };
    const wsHarness = makeWebSocketHarness();
    clients = wsHarness.clients;
    const route = createChatRoute(engine, hub, { upgradeWebSocket: wsHarness.upgradeWebSocket });
    editRollbackStore = route.editRollbackStore;
    app = new Hono();
    app.route("", route.wsRoute);
  });

  it("forwards tool_authorization events to websocket clients", async () => {
    const res = await app.request("/ws");
    expect(res.status).toBe(200);
    expect(typeof subscribed).toBe("function");

    subscribed({
      type: "tool_authorization",
      confirmId: "confirm-1",
      command: "sudo rm -rf /tmp/test",
      reason: "blocked",
      description: "needs confirmation",
      category: "elevated_command",
      identifier: "sudo",
    }, "/sessions/current.jsonl");

    expect(clients).toHaveLength(1);
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "tool_authorization",
      sessionPath: "/sessions/current.jsonl",
      confirmId: "confirm-1",
      command: "sudo rm -rf /tmp/test",
      category: "elevated_command",
    }));
  });

  it("captures edit snapshots and emits rollbackId on file_diff events", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "lynn-chat-route-"));
    const filePath = path.join(tmpDir, "sample.txt");
    try {
      await fsPromises.writeFile(filePath, "before\n", "utf8");
      engine.getSessionByPath = vi.fn(() => ({
        sessionManager: { getCwd: () => tmpDir },
        messages: [],
      }));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      subscribed({
        type: "tool_execution_start",
        toolCallId: "call_123",
        toolName: "edit",
        args: { path: "sample.txt" },
      }, "/sessions/current.jsonl");

      await fsPromises.writeFile(filePath, "after\n", "utf8");

      subscribed({
        type: "tool_execution_end",
        toolCallId: "call_123",
        toolName: "edit",
        args: { path: "sample.txt" },
        result: { details: { diff: "@@ -1 +1 @@\n-before\n+after" } },
        isError: false,
      }, "/sessions/current.jsonl");

      expect(clients[0].sent).toContainEqual(expect.objectContaining({
        type: "file_diff",
        rollbackId: "call_123",
        filePath: "sample.txt",
      }));

      expect(editRollbackStore.get("call_123")).toEqual(expect.objectContaining({
        rollbackId: "call_123",
        filePath,
        originalContent: "before\n",
      }));
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("broadcasts security_mode updates", async () => {
    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    subscribed({ type: "security_mode", mode: "safe" }, "/sessions/current.jsonl");

    expect(clients[0].sent).toContainEqual({ type: "security_mode", mode: "safe" });
  });
});
