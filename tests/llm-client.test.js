import fs from "fs";
import os from "os";
import path from "path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callText } from "../core/llm-client.js";
import {
  buildClientSignaturePayload,
} from "../core/client-agent-identity.js";

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("callText", () => {
  it("omits thinking payload for GLM openai-compatible requests when reasoning is off", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const text = await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      model: "glm-5.1",
      provider: "glm",
      messages: [{ role: "user", content: "请只回复OK" }],
      temperature: 0,
      maxTokens: 16,
      timeoutMs: 1000,
    });

    expect(text).toBe("OK");
    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestInit.body);
    expect(body.thinking).toBeUndefined();
  });

  it("keeps qwen enable_thinking payload without zai thinking override", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "hello" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3.5-flash",
      provider: "dashscope",
      quirks: ["enable_thinking"],
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 1000,
    });

    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestInit.body);
    expect(body.enable_thinking).toBe(false);
    expect(body.thinking).toBeUndefined();
  });

  it("extracts final text from structured OpenAI content arrays", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: [
              { type: "reasoning", reasoning: "step by step" },
              { type: "text", text: "最终答案" },
            ],
          },
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const text = await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://example.com/v1",
      model: "demo-model",
      messages: [{ role: "user", content: "请只回复最终答案" }],
      timeoutMs: 1000,
    });

    expect(text).toBe("最终答案");
  });

  it("classifies reasoning-only OpenAI responses without treating them as generic empty text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: "",
            reasoning_content: "chain of thought",
          },
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://example.com/v1",
      model: "demo-reasoner",
      provider: "custom-openai",
      messages: [{ role: "user", content: "ping" }],
      timeoutMs: 1000,
    })).rejects.toMatchObject({
      code: "LLM_EMPTY_RESPONSE",
      retryable: false,
      context: {
        provider: "custom-openai",
        modelId: "demo-reasoner",
        api: "openai-completions",
        responseKind: "reasoning_only",
        reasoningBlockCount: 1,
      },
    });
  });

  it("attaches client identity headers from preferences.json without signature by default", async () => {
    const lynnHome = makeTempDir("hanako-llm-");
    const clientKey = "ak_test_client_001";
    const clientSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    fs.mkdirSync(path.join(lynnHome, "user"), { recursive: true });
    fs.writeFileSync(
      path.join(lynnHome, "user", "preferences.json"),
      JSON.stringify({
        client_agent_key: clientKey,
        client_agent_secret: clientSecret,
      }, null, 2),
      "utf-8",
    );
    vi.stubEnv("LYNN_HOME", lynnHome);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://example.com/v1",
      model: "demo-model",
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: 1000,
    });

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.headers["X-Agent-Key"]).toBe(clientKey);
    expect(requestInit.headers["X-Lynn-Client-Platform"]).toBeTruthy();
    expect(requestInit.headers["X-Lynn-Timestamp"]).toBeUndefined();
    expect(requestInit.headers["X-Lynn-Nonce"]).toBeUndefined();
    expect(requestInit.headers["X-Lynn-Signature"]).toBeUndefined();
  });

  it("attaches signed client identity headers when signature mode is enabled", async () => {
    const lynnHome = makeTempDir("hanako-llm-signature-");
    const clientKey = "ak_test_client_001";
    const clientSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    fs.mkdirSync(path.join(lynnHome, "user"), { recursive: true });
    fs.writeFileSync(
      path.join(lynnHome, "user", "preferences.json"),
      JSON.stringify({
        client_agent_key: clientKey,
        client_agent_secret: clientSecret,
      }, null, 2),
      "utf-8",
    );
    vi.stubEnv("LYNN_HOME", lynnHome);
    vi.stubEnv("LYNN_ENABLE_DEVICE_SIGNATURE", "1");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://example.com/v1",
      model: "demo-model",
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: 1000,
    });

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.headers["X-Agent-Key"]).toBe(clientKey);
    expect(requestInit.headers["X-Lynn-Timestamp"]).toBeTruthy();
    expect(requestInit.headers["X-Lynn-Nonce"]).toMatch(/^[a-f0-9]{24}$/);
    expect(requestInit.headers["X-Lynn-Signature"]).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(requestInit.headers["X-Lynn-Client-Platform"]).toBeTruthy();

    const payload = buildClientSignaturePayload({
      method: "POST",
      pathname: "/chat/completions",
      timestamp: requestInit.headers["X-Lynn-Timestamp"],
      nonce: requestInit.headers["X-Lynn-Nonce"],
      agentKey: clientKey,
    });
    const expectedSignature = crypto
      .createHmac("sha256", clientSecret)
      .update(payload)
      .digest("hex");
    expect(requestInit.headers["X-Lynn-Signature"]).toBe(`v1:${expectedSignature}`);
  });
});
