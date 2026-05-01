import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, runVoiceRuntimeSmoke, usage } from "../scripts/voice-runtime-smoke.mjs";

describe("voice-runtime-smoke script", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses service URLs and optional Edge fallback flag", () => {
    const opts = parseArgs([
      "--asr-url", "http://asr.local",
      "--ser-url", "http://ser.local",
      "--tts-url", "http://tts.local",
      "--audio", "/tmp/sample.wav",
      "--include-edge",
      "--timeout-ms", "1234",
    ]);

    expect(opts).toMatchObject({
      asrUrl: "http://asr.local",
      serUrl: "http://ser.local",
      ttsUrl: "http://tts.local",
      audioPath: "/tmp/sample.wav",
      includeEdge: true,
      timeoutMs: 1234,
    });
    expect(usage()).toContain("npm run voice:smoke");
  });

  it("checks mandatory Jarvis services and synthesizes a TTS sample", async () => {
    global.fetch = vi.fn(async (url, init = {}) => {
      const href = String(url);
      if (href.endsWith("/health")) {
        return new Response("ok", { status: 200 });
      }
      if (href.endsWith("/v1/audio/speech")) {
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body)).toMatchObject({
          model: "cosyvoice2",
          input: "测试一句",
          voice: "中文女",
        });
        return new Response(Buffer.from("RIFFxxxxWAVEdata"), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await runVoiceRuntimeSmoke({
      asrUrl: "http://asr.local",
      serUrl: "http://ser.local",
      ttsUrl: "http://tts.local",
      text: "测试一句",
      includeEdge: false,
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.services.qwen3Asr.health.ok).toBe(true);
    expect(result.services.emotion2vec.health.ok).toBe(true);
    expect(result.services.cosyvoice2.inference).toMatchObject({
      ok: true,
      status: 200,
      mimeType: "audio/wav",
    });
    expect(result.services.edgeTts.skipped).toBe(true);
  });

  it("runs ASR and SER inference when an audio sample is provided", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-voice-smoke-"));
    const wav = path.join(dir, "sample.wav");
    fs.writeFileSync(wav, Buffer.from("RIFFxxxxWAVEdata"));

    global.fetch = vi.fn(async (url, init = {}) => {
      const href = String(url);
      if (href.endsWith("/health")) return new Response("ok", { status: 200 });
      if (href.endsWith("/transcribe")) {
        expect(init.body).toBeInstanceOf(FormData);
        return new Response(JSON.stringify({ text: "你好 Lynn", language: "zh" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (href.endsWith("/classify")) {
        expect(init.body).toBeInstanceOf(FormData);
        return new Response(JSON.stringify({ top1: "开心/happy", top1_score: 0.88 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (href.endsWith("/v1/audio/speech")) {
        return new Response(Buffer.from([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await runVoiceRuntimeSmoke({
      asrUrl: "http://asr.local",
      serUrl: "http://ser.local",
      ttsUrl: "http://tts.local",
      audioPath: wav,
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.services.qwen3Asr.inference.result.text).toBe("你好 Lynn");
    expect(result.services.emotion2vec.inference.result.top1).toBe("开心/happy");
  });

  it("marks the smoke failed when a mandatory health check is down", async () => {
    global.fetch = vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("asr.local")) return new Response("down", { status: 503 });
      if (href.endsWith("/health")) return new Response("ok", { status: 200 });
      if (href.endsWith("/v1/audio/speech")) return new Response(Buffer.from([1]), { status: 200 });
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await runVoiceRuntimeSmoke({
      asrUrl: "http://asr.local",
      serUrl: "http://ser.local",
      ttsUrl: "http://tts.local",
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.services.qwen3Asr.health).toMatchObject({
      ok: false,
      status: 503,
    });
  });

  it("can include Edge fallback health as an optional live dependency", async () => {
    global.fetch = vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("/voices/list")) return new Response("[]", { status: 200 });
      if (href.endsWith("/health")) return new Response("ok", { status: 200 });
      if (href.endsWith("/v1/audio/speech")) return new Response(Buffer.from([1]), { status: 200 });
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await runVoiceRuntimeSmoke({
      asrUrl: "http://asr.local",
      serUrl: "http://ser.local",
      ttsUrl: "http://tts.local",
      includeEdge: true,
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.services.edgeTts.health.ok).toBe(true);
  });
});
