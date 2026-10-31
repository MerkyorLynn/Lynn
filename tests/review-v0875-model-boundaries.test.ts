import { afterEach, describe, expect, it, vi } from "vitest";
import { createLynnAgentSession } from "../core/agent-runtime/create-session.js";
import { SessionManager } from "../core/agent-runtime/session-manager.js";
import { extractToolCallsFromContent } from "../core/agent-runtime/session-openai-adapter.js";

function response(content = "") {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
afterEach(() => vi.unstubAllGlobals());

describe("model execution trust boundaries", () => {
  it.each([
    { provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", compat: {} },
    { provider: "local", baseUrl: "http://127.0.0.1:18099/v1", compat: { allowCrossProviderFallback: true } },
  ])("does not leak an empty $provider conversation to another cloud", async model => {
    const fetch = vi.fn(async () => response()); vi.stubGlobal("fetch", fetch);
    const { session } = await createLynnAgentSession({
      model: { ...model, id: "private-model", apiKey: "test" }, sessionManager: SessionManager.inMemory(),
      modelRegistry: { getAll: () => [{ id: "step-5-preview", provider: "stepfun", baseUrl: "https://api.stepfun.com/v1", apiKey: "test" }] } as never,
    });
    await session.prompt("Private conversation");
    expect(fetch).toHaveBeenCalled();
    expect(fetch.mock.calls.every((call: unknown[]) => String(call[0]).startsWith(model.baseUrl))).toBe(true);
    session.dispose();
  });

  it("does not execute content tags without explicit text-tool compatibility", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "SHOULD NOT RUN" }] }));
    const fetch = vi.fn(async () => response('<tool_call>{"name":"read","arguments":{"path":"/tmp/a"}}</tool_call>'));
    vi.stubGlobal("fetch", fetch);
    const { session } = await createLynnAgentSession({
      sessionManager: SessionManager.inMemory(), model: { id: "local-test", provider: "local", baseUrl: "http://127.0.0.1:18099/v1" },
      tools: [{ name: "read", execute, parameters: { type: "object", properties: { path: { type: "string" } } } }],
    });
    await session.prompt("Explain a tool call");
    expect(execute).not.toHaveBeenCalled(); session.dispose();
  });

  it("ignores tool tags quoted inside explanatory prose", () => {
    const tools = [{ name: "read", execute: vi.fn(), parameters: {} }];
    expect(extractToolCallsFromContent('An example:\n<tool_call>{"name":"read","arguments":{"path":"/tmp/a"}}</tool_call>', tools)).toEqual([]);
  });

  it("does not recover an unconfirmed text bash call through fallback tool resolution", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "executed" }] }));
    const fetch = vi.fn()
      .mockResolvedValueOnce(response('<tool_call>{"name":"bash","arguments":{"command":"echo should-not-run"}}</tool_call>'))
      .mockImplementation(async () => response("Stopped without executing the command."));
    vi.stubGlobal("fetch", fetch);
    const { session } = await createLynnAgentSession({
      sessionManager: SessionManager.inMemory(),
      model: { id: "local-test", provider: "local", baseUrl: "http://127.0.0.1:18099/v1", compat: { text_tool_calls: true } },
      tools: [{ name: "bash", execute, parameters: { type: "object", properties: { command: { type: "string" } } } }],
    });
    await session.prompt("Run the command");
    expect(execute).not.toHaveBeenCalled(); session.dispose();
  });
});
