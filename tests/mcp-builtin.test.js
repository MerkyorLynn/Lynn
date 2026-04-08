import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { McpManager } from "../lib/mcp-client.js";
import { createMcpRoute } from "../server/routes/mcp.js";

function createJsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

describe("builtin MCP integrations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists builtin Tencent Docs credentials and reconnects with HTTP MCP", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-mcp-"));
    const lynnHome = path.join(tempRoot, ".lynn");
    fs.mkdirSync(lynnHome, { recursive: true });

    const fetchMock = vi.fn(async (url, init = {}) => {
      const payload = JSON.parse(String(init.body || "{}"));
      if (payload.method === "initialize") {
        return createJsonResponse({
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2024-11-05", capabilities: {} },
        });
      }
      if (payload.method === "tools/list") {
        return createJsonResponse({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            tools: [
              {
                name: "search_docs",
                description: "Search Tencent Docs",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
      }
      if (payload.method === "resources/list") {
        return createJsonResponse({
          jsonrpc: "2.0",
          id: payload.id,
          result: { resources: [] },
        });
      }
      return createJsonResponse({ jsonrpc: "2.0", id: payload.id, result: {} });
    });

    vi.stubGlobal("fetch", fetchMock);

    const manager = new McpManager(lynnHome);
    await manager.init();
    const builtin = await manager.saveBuiltinCredentials("tencent-docs", {
      credentials: { token: "docs_test_token" },
      enabled: true,
    });

    expect(builtin?.configured).toBe(true);
    expect(builtin?.connected).toBe(true);
    expect(builtin?.toolCount).toBe(1);

    const credentialsPath = path.join(lynnHome, "user", "mcp-credentials.json");
    const raw = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
    expect(raw["tencent-docs"].credentials.token).toBe("docs_test_token");
    expect(fs.statSync(credentialsPath).mode & 0o777).toBe(0o600);

    const initCall = fetchMock.mock.calls.find(([url, init]) => {
      if (url !== "https://docs.qq.com/openapi/mcp") return false;
      const payload = JSON.parse(String(init.body || "{}"));
      return payload.method === "initialize";
    });
    expect(initCall).toBeTruthy();
    expect(initCall[1].headers.Authorization).toBe("Bearer docs_test_token");
  });

  it("exposes builtin MCP endpoints through the server route", async () => {
    const listBuiltinStates = vi.fn(() => [
      {
        name: "tencent-docs",
        label: "腾讯文档",
        transport: "http",
        configured: true,
        enabled: true,
        connected: true,
        credentialFields: [{ key: "token", label: "Token", value: "docs_xxx" }],
      },
    ]);
    const saveBuiltinCredentials = vi.fn(async () => ({ ok: true }));
    const testBuiltinServer = vi.fn(async () => ({ ok: true, toolCount: 54, resourceCount: 0 }));

    const app = new Hono();
    app.route(
      "/api",
      createMcpRoute({
        mcpManager: {
          listServerStates: () => [],
          listBuiltinStates,
          saveBuiltinCredentials,
          testBuiltinServer,
          reload: vi.fn(async () => {}),
        },
      }),
    );

    const listRes = await app.request("/api/mcp/builtin");
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listBuiltinStates).toHaveBeenCalledTimes(1);
    expect(listData.builtin[0].name).toBe("tencent-docs");

    const saveRes = await app.request("/api/mcp/builtin/tencent-docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { token: "docs_test_token" }, enabled: true }),
    });
    expect(saveRes.status).toBe(200);
    expect(saveBuiltinCredentials).toHaveBeenCalledWith("tencent-docs", {
      credentials: { token: "docs_test_token" },
      enabled: true,
    });

    const testRes = await app.request("/api/mcp/builtin/tencent-docs/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { token: "docs_test_token" } }),
    });
    expect(testRes.status).toBe(200);
    const testData = await testRes.json();
    expect(testBuiltinServer).toHaveBeenCalledWith("tencent-docs", {
      credentials: { token: "docs_test_token" },
    });
    expect(testData.toolCount).toBe(54);
  });
});
