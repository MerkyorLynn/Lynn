import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { BrainConnectionError, chatCompletionsUrl, checkBrainReachable, parseBrainStreamPayload, parseSsePayloads, streamBrainChat } from "../src/brain-client.js";
import { brainEndpointUrl, HOSTED_BRAIN_URL, LOCAL_BRAIN_URL, resolveDefaultBrainUrl } from "../src/brain-url.js";
import { parseArgs } from "../src/args.js";
import { applyReasoningToBody, parseReasoningOptions, shouldRenderReasoning } from "../src/reasoning.js";
import { setLang } from "../src/i18n.js";

let previousLynnHome: string | undefined;
let testLynnHome: string | null = null;

beforeEach(() => {
  setLang("en");
  previousLynnHome = process.env.LYNN_HOME;
  testLynnHome = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-brain-client-"));
  process.env.LYNN_HOME = testLynnHome;
});

afterEach(() => {
  setLang(null);
  if (previousLynnHome === undefined) delete process.env.LYNN_HOME;
  else process.env.LYNN_HOME = previousLynnHome;
  if (testLynnHome) fs.rmSync(testLynnHome, { recursive: true, force: true });
  testLynnHome = null;
});

describe("brain-client stream parser", () => {
  it("extracts SSE data payloads", () => {
    const payloads = parseSsePayloads([
      "event: message",
      "data: {\"a\":1}",
      "",
      "data: [DONE]",
      "",
    ].join("\n"));

    expect(payloads).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("parses assistant and reasoning deltas", () => {
    const events = parseBrainStreamPayload(JSON.stringify({
      choices: [{
        delta: {
          reasoning_content: "think",
          content: "answer",
        },
      }],
    }));

    expect(events).toEqual([
      { type: "reasoning.delta", text: "think", hidden: true },
      { type: "assistant.delta", text: "answer" },
    ]);
  });

  it("parses OpenAI-style streamed tool call deltas", () => {
    expect(parseBrainStreamPayload(JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":" },
          }],
        },
      }],
    }))).toEqual([
      { type: "tool_call.delta", index: 0, id: "call_1", name: "read_file", arguments: "{\"path\":" },
    ]);

    expect(parseBrainStreamPayload(JSON.stringify({
      choices: [{
        delta: {
          function_call: { name: "grep", arguments: "{\"query\":\"MiMo\"}" },
        },
      }],
    }))).toEqual([
      { type: "tool_call.delta", index: 0, name: "grep", arguments: "{\"query\":\"MiMo\"}" },
    ]);
  });

  it("parses Lynn provider, tool progress, and error SSE payloads", () => {
    expect(parseBrainStreamPayload(JSON.stringify({
      object: "lynn.provider",
      meta: {
        active_provider: "mimo",
        fallback_from: [{ id: "spark", reason: "probe-failed" }],
      },
    }))).toEqual([
      { type: "provider", activeProvider: "mimo", fallbackFrom: [{ id: "spark", reason: "probe-failed" }] },
    ]);

    expect(parseBrainStreamPayload(JSON.stringify({
      object: "lynn.tool_progress",
      tool_progress: { event: "end", name: "web_search", ms: 120, ok: true },
    }))).toEqual([
      { type: "tool_progress", event: "end", name: "web_search", ms: 120, ok: true },
    ]);

    expect(parseBrainStreamPayload(JSON.stringify({
      object: "lynn.error",
      error: "tool_storm_limit",
      code: "tool_storm_limit",
    }))).toEqual([
      { type: "brain.error", error: "tool_storm_limit", code: "tool_storm_limit" },
    ]);

    expect(parseBrainStreamPayload(JSON.stringify({
      error: "all providers failed",
      errors: [],
    }))).toEqual([
      { type: "brain.error", error: "all providers failed" },
    ]);
  });

  it("parses OpenAI-compatible stream usage chunks", () => {
    expect(parseBrainStreamPayload(JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 80,
      },
    }))).toEqual([
      {
        type: "usage",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_cache_hit_tokens: 80,
        },
      },
    ]);
  });

  it("requires prompt or messages", async () => {
    await expect(async () => {
      for await (const _event of streamBrainChat({ brainUrl: "http://127.0.0.1:1", reasoning: { effort: "auto", display: "auto" } })) {
        // no-op
      }
    }).rejects.toThrow("requires a prompt or messages");
  });

  it("explains how to recover when Brain is unreachable", async () => {
    await expect(async () => {
      for await (const _event of streamBrainChat({ brainUrl: "http://127.0.0.1:1", prompt: "hello", reasoning: { effort: "auto", display: "auto" } })) {
        // no-op
      }
    }).rejects.toThrow("Start the Lynn client GUI");
  });

  it("uses a typed error for unreachable Brain", async () => {
    await expect(async () => {
      for await (const _event of streamBrainChat({ brainUrl: "http://127.0.0.1:1", prompt: "hello", reasoning: { effort: "auto", display: "auto" } })) {
        // no-op
      }
    }).rejects.toBeInstanceOf(BrainConnectionError);
  });

  it("returns false when the Brain health probe cannot connect", async () => {
    await expect(checkBrainReachable("http://127.0.0.1:1", 50)).resolves.toBe(false);
  });

  it("preserves hosted Brain path prefixes when building endpoints", () => {
    expect(brainEndpointUrl("https://api.merkyorlynn.com/api/v2", "/health").toString())
      .toBe("https://api.merkyorlynn.com/api/v2/health");
    expect(brainEndpointUrl("https://api.merkyorlynn.com/api/v2/", "/v1/chat/completions").toString())
      .toBe("https://api.merkyorlynn.com/api/v2/v1/chat/completions");
  });

  it("prefers hosted Brain for default startup when reachable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const href = String(url);
      if (href === `${HOSTED_BRAIN_URL}/health`) return new Response("{}", { status: 200 });
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    try {
      await expect(resolveDefaultBrainUrl(undefined, 50)).resolves.toBe(HOSTED_BRAIN_URL);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to local Brain when hosted Brain is unreachable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      const href = String(url);
      if (href === `${HOSTED_BRAIN_URL}/health`) throw new Error("hosted down");
      if (href === `${LOCAL_BRAIN_URL}/health`) return new Response("{}", { status: 200 });
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    try {
      await expect(resolveDefaultBrainUrl(undefined, 50)).resolves.toBe(LOCAL_BRAIN_URL);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to a CLI BYOK OpenAI-compatible provider when Brain is offline", async () => {
    const server = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-test");
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        expect(parsed).toMatchObject({
          model: "test-model",
          stream: true,
          stream_options: { include_usage: true },
        });
        expect(parsed.reasoning_effort).toBeUndefined();
        expect(parsed.extra_body).toBeUndefined();
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"hello from byok\"}}]}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server failed to listen");
      const events = [];
      for await (const event of streamBrainChat({
        brainUrl: "http://127.0.0.1:1",
        prompt: "hello",
        reasoning: { effort: "off", display: "auto" },
        fallbackProvider: {
          provider: "openai-compatible",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          model: "test-model",
          apiKey: "sk-test",
        },
      })) {
        events.push(event);
      }
      expect(events).toContainEqual({ type: "assistant.delta", text: "hello from byok" });
      expect(events).toContainEqual({ type: "provider", activeProvider: "cli-byok:openai-compatible", fallbackFrom: [{ id: "brain", reason: "offline" }] });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("forwards explicit reasoning effort to CLI BYOK without SDK-only extra_body", async () => {
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        expect(parsed.reasoning_effort).toBe("high");
        expect(parsed.extra_body).toBeUndefined();
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"high effort fallback\"}}]}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server failed to listen");
      const events = [];
      for await (const event of streamBrainChat({
        brainUrl: "http://127.0.0.1:1",
        prompt: "hello",
        reasoning: { effort: "high", display: "auto" },
        fallbackProvider: {
          provider: "openai-compatible",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          model: "test-model",
          apiKey: "sk-test",
        },
      })) {
        events.push(event);
      }
      expect(events).toContainEqual({ type: "assistant.delta", text: "high effort fallback" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not leak UI-only reasoning modes to StepFun-style CLI BYOK fallback", async () => {
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        expect(parsed.model).toBe("step-3.7-flash");
        expect(parsed.reasoning_effort).toBeUndefined();
        expect(parsed.extra_body).toBeUndefined();
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"stepfun fallback\"}}]}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server failed to listen");
      const events = [];
      for await (const event of streamBrainChat({
        brainUrl: "http://127.0.0.1:1",
        prompt: "hello",
        reasoning: { effort: "off", display: "auto" },
        fallbackProvider: {
          provider: "openai-compatible",
          baseUrl: `http://127.0.0.1:${address.port}/step_plan/v1`,
          model: "step-3.7-flash",
          apiKey: "sk-test",
        },
      })) {
        events.push(event);
      }
      expect(events).toContainEqual({ type: "assistant.delta", text: "stepfun fallback" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("times out a stalled local Brain quickly when BYOK fallback is available", async () => {
    const stalledBrain = http.createServer((_request, _response) => {
      // Intentionally never respond; the CLI must not hang before trying BYOK.
    });
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        "data: {\"choices\":[{\"delta\":{\"content\":\"fast fallback\"}}]}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
    await new Promise<void>((resolve) => stalledBrain.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const oldTimeout = process.env.LYNN_CLI_BRAIN_TIMEOUT_MS;
    process.env.LYNN_CLI_BRAIN_TIMEOUT_MS = "25";
    try {
      const brainAddress = stalledBrain.address();
      const providerAddress = provider.address();
      if (!brainAddress || typeof brainAddress === "string") throw new Error("brain test server failed to listen");
      if (!providerAddress || typeof providerAddress === "string") throw new Error("provider test server failed to listen");
      const events = [];
      for await (const event of streamBrainChat({
        brainUrl: `http://127.0.0.1:${brainAddress.port}`,
        prompt: "hello",
        reasoning: { effort: "auto", display: "auto" },
        fallbackProvider: {
          provider: "openai-compatible",
          baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
          model: "test-model",
          apiKey: "sk-test",
        },
      })) {
        events.push(event);
      }
      expect(events).toContainEqual({ type: "assistant.delta", text: "fast fallback" });
    } finally {
      if (oldTimeout === undefined) delete process.env.LYNN_CLI_BRAIN_TIMEOUT_MS;
      else process.env.LYNN_CLI_BRAIN_TIMEOUT_MS = oldTimeout;
      await new Promise<void>((resolve) => stalledBrain.close(() => resolve()));
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });

  it("falls back to CLI BYOK when local Brain returns a recoverable 5xx", async () => {
    const brokenBrain = http.createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "brain warming up" }));
    });
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        "data: {\"choices\":[{\"delta\":{\"content\":\"fallback after 503\"}}]}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
    await new Promise<void>((resolve) => brokenBrain.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    try {
      const brainAddress = brokenBrain.address();
      const providerAddress = provider.address();
      if (!brainAddress || typeof brainAddress === "string") throw new Error("brain test server failed to listen");
      if (!providerAddress || typeof providerAddress === "string") throw new Error("provider test server failed to listen");
      const events = [];
      for await (const event of streamBrainChat({
        brainUrl: `http://127.0.0.1:${brainAddress.port}`,
        prompt: "hello",
        reasoning: { effort: "auto", display: "auto" },
        fallbackProvider: {
          provider: "openai-compatible",
          baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
          model: "test-model",
          apiKey: "sk-test",
        },
      })) {
        events.push(event);
      }
      expect(events).toContainEqual({ type: "assistant.delta", text: "fallback after 503" });
      expect(events).toContainEqual({ type: "provider", activeProvider: "cli-byok:openai-compatible", fallbackFrom: [{ id: "brain", reason: "offline" }] });
    } finally {
      await new Promise<void>((resolve) => brokenBrain.close(() => resolve()));
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });

  it("falls back to CLI BYOK when online Brain streams all-providers-failed before any answer", async () => {
    const brokenBrain = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        "data: {\"object\":\"lynn.error\",\"error\":\"all providers failed\",\"code\":\"all_providers_failed\"}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        "data: {\"choices\":[{\"delta\":{\"content\":\"fallback after route failure\"}}]}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
    await new Promise<void>((resolve) => brokenBrain.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    try {
      const brainAddress = brokenBrain.address();
      const providerAddress = provider.address();
      if (!brainAddress || typeof brainAddress === "string") throw new Error("brain test server failed to listen");
      if (!providerAddress || typeof providerAddress === "string") throw new Error("provider test server failed to listen");
      const events = [];
      for await (const event of streamBrainChat({
        brainUrl: `http://127.0.0.1:${brainAddress.port}`,
        prompt: "hello",
        reasoning: { effort: "auto", display: "auto" },
        fallbackProvider: {
          provider: "openai-compatible",
          baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
          model: "test-model",
          apiKey: "sk-test",
        },
      })) {
        events.push(event);
      }
      expect(events).not.toContainEqual({ type: "brain.error", error: "all providers failed", code: "all_providers_failed" });
      expect(events).toContainEqual({ type: "provider", activeProvider: "cli-byok:openai-compatible", fallbackFrom: [{ id: "brain", reason: "offline" }] });
      expect(events).toContainEqual({ type: "assistant.delta", text: "fallback after route failure" });
    } finally {
      await new Promise<void>((resolve) => brokenBrain.close(() => resolve()));
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });

  it("does not fall back after Brain has already streamed answer content", async () => {
    const brokenBrain = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}",
        "",
        "data: {\"object\":\"lynn.error\",\"error\":\"all providers failed\",\"code\":\"all_providers_failed\"}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
    await new Promise<void>((resolve) => brokenBrain.listen(0, "127.0.0.1", resolve));
    try {
      const brainAddress = brokenBrain.address();
      if (!brainAddress || typeof brainAddress === "string") throw new Error("brain test server failed to listen");
      const events = [];
      for await (const event of streamBrainChat({
        brainUrl: `http://127.0.0.1:${brainAddress.port}`,
        prompt: "hello",
        reasoning: { effort: "auto", display: "auto" },
        fallbackProvider: {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:1/v1",
          model: "test-model",
          apiKey: "sk-test",
        },
      })) {
        events.push(event);
      }
      expect(events).toContainEqual({ type: "assistant.delta", text: "partial" });
      expect(events).toContainEqual({ type: "brain.error", error: "all providers failed", code: "all_providers_failed" });
      expect(events).not.toContainEqual({ type: "provider", activeProvider: "cli-byok:openai-compatible", fallbackFrom: [{ id: "brain", reason: "offline" }] });
    } finally {
      await new Promise<void>((resolve) => brokenBrain.close(() => resolve()));
    }
  });

  it("builds chat completion URLs from base URLs", () => {
    expect(chatCompletionsUrl("https://api.example.com/v1").toString()).toBe("https://api.example.com/v1/chat/completions");
    expect(chatCompletionsUrl("https://api.example.com/v1/chat/completions").toString()).toBe("https://api.example.com/v1/chat/completions");
  });
});

describe("reasoning options", () => {
  it("parses CLI reasoning flags", () => {
    expect(parseReasoningOptions(parseArgs(["exec", "x", "--reasoning", "high", "--show-reasoning", "always"]))).toEqual({
      effort: "high",
      display: "always",
    });
  });

  it("maps off to non-thinking request fields", () => {
    expect(applyReasoningToBody({}, { effort: "off", display: "auto" })).toEqual({
      reasoning_effort: "off",
      extra_body: { enable_thinking: false },
    });
  });

  it("always renders reasoning in JSON mode", () => {
    expect(shouldRenderReasoning("never", true)).toBe(true);
    expect(shouldRenderReasoning("auto", false)).toBe(false);
    expect(shouldRenderReasoning("always", false)).toBe(true);
  });
});
