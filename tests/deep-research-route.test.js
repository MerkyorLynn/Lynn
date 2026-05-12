import { Hono } from "hono";
import fs from "fs";
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
        rankedScores: [{ providerId: "deepseek-chat", avg: 1.33 }],
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
      rankedScores: [{ providerId: "deepseek-chat", avg: 1.33 }],
      qualityRejected: false,
      usage: { completion_tokens: 8 },
    });
  });

  it("marks low-quality winners as rejected instead of treating them as pass", () => {
    const raw = [
      sseLine({
        object: "deep-research.meta",
        type: "quality-rejected-final",
        winnerProviderId: "mimo",
        rankedScores: [{ providerId: "mimo", avg: 4.67 }],
      }),
      sseLine({
        choices: [{ delta: { content: "候选答案质量不足。" }, finish_reason: "stop" }],
      }),
    ].join("");

    expect(parseDeepResearchSse(raw)).toMatchObject({
      ok: false,
      qualityRejected: true,
      winnerProviderId: "mimo",
      text: "候选答案质量不足。",
    });
  });

  it("recognizes Brain v2 nested meta.event quality rejection payloads", () => {
    const raw = [
      sseLine({
        id: "chatcmpl-deep",
        object: "deep-research.meta",
        meta: {
          event: "quality-rejected-final",
          winnerProviderId: null,
          qualityRejected: true,
          rankedScores: [{ providerId: "deepseek-chat", avg: 5.33, maxDimension: 6 }],
        },
      }),
      sseLine({
        choices: [{ delta: { content: "这轮 Deep Research 已拦截。" }, finish_reason: "stop" }],
      }),
    ].join("");

    expect(parseDeepResearchSse(raw)).toMatchObject({
      ok: false,
      qualityRejected: true,
      winnerProviderId: null,
      rankedScores: [{ providerId: "deepseek-chat", avg: 5.33, maxDimension: 6 }],
      text: "这轮 Deep Research 已拦截。",
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
          qualityRejected: false,
          rankedScores: [{ providerId: "deepseek-chat", avg: 1 }],
        },
      }),
      sseLine({
        choices: [{ delta: { content: "MoE 是混合专家模型。" }, finish_reason: "stop" }],
      }),
    ].join("");

    expect(parseDeepResearchSse(raw)).toMatchObject({
      ok: true,
      qualityRejected: false,
      winnerProviderId: "deepseek-chat",
      rankedScores: [{ providerId: "deepseek-chat", avg: 1 }],
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
      sseLine({ choices: [{ delta: { content: "A3B 通常指 active 3B parameters。" } }] }),
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
        candidates: ["deepseek-chat", "mimo"],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      text: "A3B 通常指 active 3B parameters。",
      winnerProviderId: "deepseek-chat",
      baseUrl: "http://brain-v2.test",
      source: "brain-v2-deep-research",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://brain-v2.test/v2/deep-research/completions",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      messages: [{ role: "user", content: "A3B 是什么意思？" }],
      candidates: ["deepseek-chat", "mimo"],
    });
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
        rankedScores: [{ providerId: "deepseek-chat", avg: 1 }],
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
    expect(await res.json()).toMatchObject({
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
    expect(lines[2].message.content[0].text).toContain("Deep Research");
    expect(lines[2].message.content[0].text).toContain("winner: deepseek-chat");
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

  it("falls back across default Brain v2 base URLs", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async (url) => {
      attempts += 1;
      if (attempts <= 4) {
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
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.merkyorlynn.com/api/v2/v2/deep-research/completions");
    expect(fetchImpl.mock.calls[2][0]).toBe("http://82.156.182.240/api/v2/v2/deep-research/completions");
    expect(fetchImpl.mock.calls[4][0]).toBe("http://127.0.0.1:8790/v2/deep-research/completions");
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
