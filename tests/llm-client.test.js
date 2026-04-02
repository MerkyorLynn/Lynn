import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callText } from "../core/llm-client.js";

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
  it("disables thinking for GLM openai-compatible requests", async () => {
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
    expect(body.thinking).toEqual({ type: "disabled" });
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

  it("attaches client agent key header from preferences.json", async () => {
    const lynnHome = makeTempDir("hanako-llm-");
    fs.mkdirSync(path.join(lynnHome, "user"), { recursive: true });
    fs.writeFileSync(
      path.join(lynnHome, "user", "preferences.json"),
      JSON.stringify({ client_agent_key: "ak_test_client_001" }, null, 2),
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
    expect(requestInit.headers["X-Agent-Key"]).toBe("ak_test_client_001");
  });
});
