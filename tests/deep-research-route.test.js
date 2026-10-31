import { Hono } from "hono";
import fs from "fs";
import { createServer } from "http";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  buildDeepResearchEndpoint,
  buildDeepResearchEndpointCandidates,
  createDeepResearchRoute,
  parseDeepResearchSse,
  resolveDeepResearchBaseUrl,
  resolveDeepResearchBaseUrls,
} from "../server/routes/deep-research.js";

function makeApp(fetchImpl) {
  const app = new Hono();
  app.route("/api", createDeepResearchRoute({}, { fetchImpl }));
  return app;
}

function makeAppWithEngine(fetchImpl, engine) {
  const app = new Hono();
  app.route("/api", createDeepResearchRoute(engine, { fetchImpl }));
  return app;
}

function sseLine(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

describe("deep research route", () => {
  it("parses text chunks and winner metadata from Brain v2 SSE", () => {
    const raw = [
      sseLine({
        id: "dr-test",
        choices: [{ delta: { content: "第一段" } }],
      }),
      sseLine({
        object: "deep-research.meta",
        type: "winner-picked",
        providerId: "deepseek-chat",
      }),
      sseLine({
        id: "dr-test",
        choices: [{ delta: { content: "，第二段" }, finish_reason: "stop" }],
        usage: { completion_tokens: 8 },
      }),
      "data: [DONE]\n\n",
    ].join("");

    expect(parseDeepResearchSse(raw)).toMatchObject({
      ok: true,
      text: "第一段，第二段",
      finishReason: "stop",
      winnerProviderId: "deepseek-chat",
      usage: { completion_tokens: 8 },
    });
  });

  it("treats legacy meta payloads as metadata, not route-level rejection", () => {
    const raw = [
      sseLine({
        object: "deep-research.meta",
        type: "candidate-picked",
        winnerProviderId: "step-3.7-flash",
      }),
      sseLine({
        choices: [{ delta: { content: "模型原样输出。" }, finish_reason: "stop" }],
      }),
    ].join("");

    expect(parseDeepResearchSse(raw)).toMatchObject({
      ok: true,
      winnerProviderId: null,
      text: "模型原样输出。",
    });
  });

  it("does not turn nested metadata payloads into route-level rejection", () => {
    const raw = [
      sseLine({
        id: "chatcmpl-deep",
        object: "deep-research.meta",
        meta: {
          event: "candidate-picked",
          winnerProviderId: null,
        },
      }),
      sseLine({
        choices: [{ delta: { content: "深度调研返回模型内容。" }, finish_reason: "stop" }],
      }),
    ].join("");

    expect(parseDeepResearchSse(raw)).toMatchObject({
      ok: true,
      winnerProviderId: null,
      text: "深度调研返回模型内容。",
    });
  });

  it("recognizes Brain v2 nested winner-picked payloads", () => {
    const raw = [
      sseLine({
        id: "chatcmpl-deep",
        object: "deep-research.meta",
        meta: {
          event: "winner-picked",
          winnerProviderId: "deepseek-chat",
        },
      }),
      sseLine({
        choices: [{ delta: { content: "MoE 是混合专家模型。" }, finish_reason: "stop" }],
      }),
    ].join("");

    expect(parseDeepResearchSse(raw)).toMatchObject({
      ok: true,
      winnerProviderId: "deepseek-chat",
      text: "MoE 是混合专家模型。",
    });
  });

  it("rejects empty prompts before calling Brain v2", async () => {
    const fetchImpl = vi.fn();
    const app = makeApp(fetchImpl);

    const res = await app.request("/api/deep-research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "  " }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_prompt" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards prompt requests to Brain v2 and returns normalized JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response([
      sseLine({ choices: [{ delta: { content: "A3B 通常指 active 3B parameters。<script>alert(1)</script>" } }] }),
      sseLine({
        object: "deep-research.meta",
        type: "winner-picked",
        providerId: "deepseek-chat",
      }),
    ].join(""), { status: 200 }));
    const app = makeApp(fetchImpl);

    const res = await app.request("/api/deep-research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "A3B 是什么意思？",
        baseUrl: "http://brain-v2.test",
        candidates: ["deepseek-chat", "step-3.7-flash"],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      text: "A3B 通常指 active 3B parameters。<script>alert(1)</script>",
      winnerProviderId: "deepseek-chat",
      baseUrl: "http://brain-v2.test",
      source: "brain-v2-deep-research",
    });
    expect(json.artifact).toMatchObject({
      artifactType: "html",
      type: "html",
      language: "html",
    });
    expect(json.artifact.content).toContain("<!DOCTYPE html>");
    expect(json.artifact.content).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(json.artifact.content).not.toContain("<script>alert(1)</script>");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://brain-v2.test/v2/deep-research/completions",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      messages: [{ role: "user", content: "A3B 是什么意思？" }],
      candidates: ["deepseek-chat", "step-3.7-flash"],
    });
  });

  it("uses the selected BYOK model directly instead of hardcoded Brain candidates", async () => {
    const seenBodies = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        seenBodies.push(JSON.parse(raw || "{}"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "selected model answer" }, finish_reason: "stop" }],
        }));
      });
    });
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const fetchImpl = vi.fn(async () => {
      throw new Error("Brain upstream should not be called for a selected BYOK model");
    });
    const engine = {
      availableModels: [{ id: "gpt-5.4", provider: "openai-codex", name: "GPT 5.4", api: "openai-completions" }],
      resolveProviderCredentials: () => ({ api_key: "test-key", base_url: baseUrl, api: "openai-completions" }),
      authStorage: { get: () => null, getApiKey: async () => "" },
      providerRegistry: { get: () => ({ authType: "apiKey" }) },
    };
    const app = makeAppWithEngine(fetchImpl, engine);

    try {
      const res = await app.request("/api/deep-research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "做个调研",
          provider: "openai-codex",
          model: "gpt-5.4",
          sourceLabel: "GPT 5.4",
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({
        ok: true,
        text: "selected model answer",
        winnerProviderId: "openai-codex",
        winnerModelId: "gpt-5.4",
        sourceLabel: "GPT 5.4",
        source: "selected-model-deep-research",
      });
      expect(json.artifact).toMatchObject({
        artifactType: "html",
        title: "深度调研报告 · 做个调研",
      });
      expect(json.artifact.content).toContain("selected model answer");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(seenBodies[0]).toMatchObject({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "做个调研" }],
        max_tokens: 32768,
      });
    } finally {
      server.close();
    }
  });

  it("retries selected BYOK deep research without thinking when the first response has no visible answer", async () => {
    const seenBodies = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        seenBodies.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        if (seenBodies.length === 1) {
          res.end(JSON.stringify({
            choices: [{ message: { role: "assistant", content: "", reasoning_content: "hidden thinking" }, finish_reason: "stop" }],
          }));
          return;
        }
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "selected model no-think fallback answer" }, finish_reason: "stop" }],
        }));
      });
    });
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const fetchImpl = vi.fn(async () => {
      throw new Error("Brain upstream should not be called for a selected BYOK model");
    });
    const engine = {
      availableModels: [{ id: "glm-5.1", provider: "zhipu-coding", name: "GLM 5.1", api: "openai-completions" }],
      resolveProviderCredentials: () => ({ api_key: "test-key", base_url: baseUrl, api: "openai-completions" }),
      authStorage: { get: () => null, getApiKey: async () => "" },
      providerRegistry: { get: () => ({ authType: "apiKey" }) },
    };
    const app = makeAppWithEngine(fetchImpl, engine);

    try {
      const res = await app.request("/api/deep-research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "做个调研",
          provider: "zhipu-coding",
          model: "glm-5.1",
          sourceLabel: "GLM 5.1",
          max_tokens: 512,
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({
        ok: true,
        text: "selected model no-think fallback answer",
        winnerProviderId: "zhipu-coding",
        winnerModelId: "glm-5.1",
        source: "selected-model-deep-research",
      });
      expect(json.metaEvents.some((event) => event.type === "selected-model-deep-research-retry")).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(seenBodies).toHaveLength(2);
      expect(seenBodies[0].messages.at(-1).content).toBe("做个调研");
      expect(seenBodies[0].enable_thinking).toBeUndefined();
      expect(seenBodies[1].messages.at(-1).content).toContain("/no_think");
      expect(seenBodies[1].enable_thinking).toBe(false);
    } finally {
      server.close();
    }
  });

  it("retries local deep research with thinking disabled when thinking-on returns no visible answer", async () => {
    const seenBodies = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      seenBodies.push(JSON.parse(init?.body || "{}"));
      if (seenBodies.length === 1) {
        return new Response([
          sseLine({ choices: [{ delta: { reasoning_content: "long hidden reasoning" }, finish_reason: "length" }] }),
          "data: [DONE]\n\n",
        ].join(""), { status: 200 });
      }
      return new Response([
        sseLine({ choices: [{ delta: { content: "本地 thinking-off fallback 输出了可见调研报告。" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ].join(""), { status: 200 });
    });
    const app = makeApp(fetchImpl);

    const res = await app.request("/api/deep-research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "做一份长调研",
        provider: "local-qwen35-9b-q4km-imatrix",
        model: "qwen35-9b-q4km-imatrix",
        localBaseUrl: "http://127.0.0.1:18099/v1",
        max_tokens: 512,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      text: "本地 thinking-off fallback 输出了可见调研报告。",
      source: "local-qwen35-deep-research",
    });
    expect(json.metaEvents.some((event) => event.type === "local-deep-research-retry")).toBe(true);
    expect(json.artifact).toMatchObject({ artifactType: "html", language: "html" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(seenBodies[0].chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(seenBodies[1].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(seenBodies[1].messages.at(-1).content).toContain("/no_think");
  });

  it("persists Deep Research user and assistant messages when sessionPath is provided", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-deep-research-"));
    const agentsDir = path.join(tmpDir, "agents");
    const sessionDir = path.join(agentsDir, "lynn", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "test.jsonl");
    fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: "test" })}\n`);

    const fetchImpl = vi.fn(async () => new Response([
      sseLine({ choices: [{ delta: { content: "MoE 的 active parameters 是每次推理实际参与计算的参数。" }, finish_reason: "stop" }] }),
      sseLine({
        object: "deep-research.meta",
        type: "winner-picked",
        providerId: "deepseek-chat",
      }),
    ].join(""), { status: 200 }));
    const app = makeAppWithEngine(fetchImpl, { agentsDir });

    const res = await app.request("/api/deep-research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "解释 active parameters",
        baseUrl: "http://brain-v2.test",
        sessionPath,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      persisted: true,
      persistedSessionPath: sessionPath,
    });
    const lines = fs.readFileSync(sessionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "解释 active parameters" }] },
    });
    expect(lines[2].message.role).toBe("assistant");
    expect(lines[2].message.content[0].text).toContain("深度调研");
    expect(lines[2].message.content[0].text).toContain("输出来源：deepseek-chat");
    expect(lines[2].message.content[0].text).not.toContain("推荐来源");
    expect(lines[2].message.content[1]).toMatchObject({
      type: "toolCall",
      name: "create_artifact",
      arguments: {
        artifactId: json.artifact.artifactId,
        type: "html",
        language: "html",
      },
    });
    expect(lines[2].message.content[1].arguments.content).toContain("<!DOCTYPE html>");
    expect(lines[2].message.content[1].arguments.content).toContain("MoE 的 active parameters");
  });

  it("surfaces upstream failures with a useful error", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const app = makeApp(fetchImpl);

    const res = await app.request("/api/deep-research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "调研 A3B", baseUrl: "brain-v2.test" }),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: "deep_research_upstream_error",
      status: 500,
      message: "boom",
      baseUrl: "http://brain-v2.test",
    });
  });

  it("normalizes env and direct base URLs", () => {
    expect(resolveDeepResearchBaseUrl("brain-v2.test/")).toBe("http://brain-v2.test");
    expect(resolveDeepResearchBaseUrl("https://brain-v2.test/api/")).toBe("https://brain-v2.test/api");
    expect(resolveDeepResearchBaseUrls("brain-v2.test/")).toEqual(["http://brain-v2.test"]);
    expect(buildDeepResearchEndpoint("http://brain-v2.test")).toBe("http://brain-v2.test/v2/deep-research/completions");
    expect(buildDeepResearchEndpoint("http://brain-v2.test/api/v2")).toBe("http://brain-v2.test/api/v2/v2/deep-research/completions");
    expect(buildDeepResearchEndpointCandidates("http://brain-v2.test/api/v2")).toEqual([
      "http://brain-v2.test/api/v2/v2/deep-research/completions",
      "http://brain-v2.test/api/v2/deep-research/completions",
    ]);
  });

  it("falls back to the local mirror without downgrading to remote HTTP", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async (url) => {
      attempts += 1;
      if (attempts <= 2) {
        throw new Error("dns failed");
      }
      return new Response([
        sseLine({
          object: "deep-research.meta",
          type: "winner-picked",
          providerId: "deepseek-chat",
        }),
        sseLine({ choices: [{ delta: { content: "fallback ok" }, finish_reason: "stop" }] }),
      ].join(""), { status: 200 });
    });
    const app = makeApp(fetchImpl);

    const res = await app.request("/api/deep-research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "测试默认 fallback" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      text: "fallback ok",
      winnerProviderId: "deepseek-chat",
      source: "brain-v2-deep-research",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.merkyorlynn.com/api/v2/v2/deep-research/completions");
    expect(fetchImpl.mock.calls[2][0]).toBe("http://127.0.0.1:8790/v2/deep-research/completions");
    expect(fetchImpl.mock.calls.every(([url]) => new URL(url).protocol === "https:" || new URL(url).hostname === "127.0.0.1")).toBe(true);
  });

  it("tries the mirror-compatible nested v2 endpoint before legacy mirror endpoint", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/api/v2/v2/deep-research/completions")) {
        return new Response([
          sseLine({
            object: "deep-research.meta",
            type: "winner-picked",
            providerId: "deepseek-chat",
          }),
          sseLine({ choices: [{ delta: { content: "mirror ok" }, finish_reason: "stop" }] }),
        ].join(""), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const app = makeApp(fetchImpl);

    const res = await app.request("/api/deep-research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "测试镜像 nested v2", baseUrl: "http://mirror.test/api/v2" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      text: "mirror ok",
      endpoint: "http://mirror.test/api/v2/v2/deep-research/completions",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
