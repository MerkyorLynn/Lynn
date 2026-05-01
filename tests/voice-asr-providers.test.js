/**
 * Voice ASR / SER providers 单测 — Lynn V0.79 Phase 1
 *
 * 验证 provider 工厂模式 + URL 配置 + 错误处理
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createASRFallbackProvider } from "../server/clients/asr/index.js";
import { createQwen3AsrProvider } from "../server/clients/asr/qwen3-asr.js";
import { createSERProvider, EMOTION_LLM_HINT } from "../server/clients/ser/index.js";
import { createEmotion2VecProvider } from "../server/clients/ser/emotion2vec-plus.js";
import { createCosyVoice2TtsProvider } from "../server/clients/tts/cosyvoice2.js";
import { createEdgeTtsProvider, createTTSFallbackProvider } from "../server/clients/tts/index.js";
import { normalizeChineseTtsText, stripEmojiForTts } from "../shared/tts-text-normalizer.js";

describe("Qwen3-ASR provider", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.LYNN_QWEN3_ASR_URL;
  });

  it("provider has required interface", () => {
    const p = createQwen3AsrProvider();
    expect(p.name).toBe("qwen3-asr");
    expect(typeof p.transcribe).toBe("function");
    expect(typeof p.health).toBe("function");
    expect(typeof p.transcribeStreaming).toBe("function");
  });

  it("transcribe POSTs multipart with file + language", async () => {
    let captured;
    global.fetch = vi.fn(async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ text: "hello", language: "zh", duration_ms: 1234 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const p = createQwen3AsrProvider();
    const result = await p.transcribe(Buffer.from("audio data"), { language: "zh" });
    expect(result.text).toBe("hello");
    expect(captured.url).toContain("/transcribe");
    expect(captured.init.method).toBe("POST");
    expect(captured.init.body).toBeInstanceOf(FormData);
    expect(captured.init.signal).toBeInstanceOf(AbortSignal);
    expect(captured.init.body.get("language")).toBe("Chinese");
    const file = captured.init.body.get("file");
    expect(file.type).toBe("audio/wav");
    expect(file.name).toBe("audio.wav");
  });

  it("omits language for auto and maps English aliases", async () => {
    const requests = [];
    global.fetch = vi.fn(async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ text: "ok", language: "en" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const p = createQwen3AsrProvider({ timeoutMs: 1234 });
    await p.transcribe(Buffer.from("wav"), { language: "auto", filename: "clip.wav" });
    await p.transcribe(Buffer.from("wav"), { language: "en-US", filename: "clip.wav" });
    expect(requests[0].init.body.get("language")).toBeNull();
    expect(requests[1].init.body.get("language")).toBe("English");
  });

  it("transcribe throws on non-200", async () => {
    global.fetch = vi.fn(async () => new Response("server error", { status: 500 }));
    const p = createQwen3AsrProvider();
    await expect(p.transcribe(Buffer.from("x"))).rejects.toThrow(/HTTP 500/);
  });

  it("health returns false on network error", async () => {
    global.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const p = createQwen3AsrProvider();
    expect(await p.health()).toBe(false);
  });

  it("health returns true on 2xx", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const p = createQwen3AsrProvider();
    expect(await p.health()).toBe(true);
  });

  it("transcribeStreaming throws Phase 1 stub error", async () => {
    const p = createQwen3AsrProvider();
    await expect(p.transcribeStreaming()).rejects.toThrow(/Phase 2/);
  });
});

describe("ASR fallback chain", () => {
  it("reports degraded health when Qwen3 primary fails but SenseVoice fallback is reachable", async () => {
    const p = createASRFallbackProvider({}, {
      primaryProvider: { name: "qwen3-asr", health: vi.fn(async () => false), transcribe: vi.fn() },
      fallbackProvider: { name: "sensevoice", health: vi.fn(async () => true), transcribe: vi.fn() },
    });
    await expect(p.health()).resolves.toMatchObject({
      ok: false,
      fallbackOk: true,
      degraded: true,
    });
  });

  it("uses fallback transcription when the primary ASR throws", async () => {
    const primary = {
      name: "qwen3-asr",
      transcribe: vi.fn(async () => { throw new Error("qwen offline"); }),
      health: vi.fn(async () => false),
    };
    const fallback = {
      name: "sensevoice",
      transcribe: vi.fn(async () => ({ text: "fallback 转写", language: "zh" })),
      health: vi.fn(async () => true),
    };
    const p = createASRFallbackProvider({}, { primaryProvider: primary, fallbackProvider: fallback });
    const result = await p.transcribe(Buffer.from("audio"));
    expect(primary.transcribe).toHaveBeenCalledTimes(1);
    expect(fallback.transcribe).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      text: "fallback 转写",
      fallbackUsed: true,
      primaryError: "qwen offline",
    });
  });
});

describe("emotion2vec+ provider", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.LYNN_EMOTION2VEC_URL;
  });

  it("createSERProvider returns emotion2vec by default", () => {
    const p = createSERProvider();
    expect(p.name).toBe("emotion2vec-plus-base");
    expect(typeof p.classify).toBe("function");
    expect(typeof p.warmup).toBe("function");
  });

  it("createSERProvider throws on unknown provider", () => {
    expect(() => createSERProvider({ provider: "nope" })).toThrow(/Unknown SER provider/);
  });

  it("classify returns normalized {tag, score, all}", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      labels: ["开心/happy", "中立/neutral", "难过/sad"],
      scores: [0.8, 0.15, 0.05],
      top1: "开心/happy",
      top1_score: 0.8,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const p = createEmotion2VecProvider();
    const result = await p.classify(Buffer.from("audio"));
    expect(result.tag).toBe("happy");
    expect(result.score).toBe(0.8);
    expect(result.all).toHaveLength(3);
    expect(result.all[0].tag).toBe("happy");
  });

  it("classify maps unknown labels to 'unknown'", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      labels: ["foo/bar"],
      scores: [0.99],
      top1: "foo/bar",
      top1_score: 0.99,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const p = createEmotion2VecProvider();
    const result = await p.classify(Buffer.from("audio"));
    expect(result.tag).toBe("unknown");
  });

  it("classify throws on non-200", async () => {
    global.fetch = vi.fn(async () => new Response("err", { status: 503 }));
    const p = createEmotion2VecProvider();
    await expect(p.classify(Buffer.from("x"))).rejects.toThrow(/HTTP 503/);
  });

  it("warmup returns false on network error", async () => {
    global.fetch = vi.fn(async () => { throw new Error("nope"); });
    const p = createEmotion2VecProvider();
    expect(await p.warmup()).toBe(false);
  });
});

describe("EMOTION_LLM_HINT — DS V4 Pro 反馈 + Phase 4 注入", () => {
  it("9 个 emotion tag 都有定义", () => {
    const tags = ["happy", "sad", "angry", "fearful", "surprised", "disgusted", "neutral", "other", "unknown"];
    for (const tag of tags) {
      expect(EMOTION_LLM_HINT).toHaveProperty(tag);
    }
  });

  it("中性/其他/unknown → null(不注入 LLM 提示)", () => {
    expect(EMOTION_LLM_HINT.neutral).toBeNull();
    expect(EMOTION_LLM_HINT.other).toBeNull();
    expect(EMOTION_LLM_HINT.unknown).toBeNull();
  });

  it("强情绪 → 中文提示词", () => {
    expect(EMOTION_LLM_HINT.happy).toMatch(/愉快|轻松/);
    expect(EMOTION_LLM_HINT.sad).toMatch(/低落|温和/);
    expect(EMOTION_LLM_HINT.angry).toMatch(/烦躁|平和/);
    expect(EMOTION_LLM_HINT.fearful).toMatch(/焦虑|安抚/);
  });
});

describe("CosyVoice2 TTS provider", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.LYNN_COSYVOICE_URL;
  });

  it("synthesize POSTs OpenAI-compatible speech request and returns audio bytes", async () => {
    let captured;
    const wav = Buffer.from("RIFFxxxxWAVEdata");
    global.fetch = vi.fn(async (url, init) => {
      captured = { url, init };
      return new Response(wav, {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    });
    const p = createCosyVoice2TtsProvider({ base_url: "http://tts.local", default_voice: "中文女" });
    const result = await p.synthesize("你好", { speed: 1.1 });
    expect(captured.url).toBe("http://tts.local/v1/audio/speech");
    expect(JSON.parse(captured.init.body)).toMatchObject({
      model: "cosyvoice2",
      input: "你好",
      voice: "中文女",
      response_format: "wav",
      speed: 1.1,
    });
    expect(result.mimeType).toBe("audio/wav");
    expect(Buffer.compare(result.audio, wav)).toBe(0);
  });

  it("normalizes Chinese dates and numbers before posting to CosyVoice", async () => {
    let captured;
    global.fetch = vi.fn(async (url, init) => {
      captured = { url, init };
      return new Response(Buffer.from("RIFFxxxxWAVEdata"), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    });
    const p = createCosyVoice2TtsProvider({ base_url: "http://tts.local", default_voice: "中文女" });
    await p.synthesize("明天（5月1日）气温在21到26度之间，降雨概率30%。");
    expect(JSON.parse(captured.init.body).input).toBe("明天（五月一日）气温在二十一到二十六度之间，降雨概率百分之三十。");
  });

  it("synthesize throws on non-200", async () => {
    global.fetch = vi.fn(async () => new Response("bad", { status: 502 }));
    const p = createCosyVoice2TtsProvider();
    await expect(p.synthesize("你好")).rejects.toThrow(/HTTP 502/);
  });

  it("health returns false on network error", async () => {
    global.fetch = vi.fn(async () => { throw new Error("offline"); });
    const p = createCosyVoice2TtsProvider();
    expect(await p.health()).toBe(false);
  });

  // 2026-05-01 P0-② 流式 — DGX /v1/audio/speech/stream chunked WAV stream
  function makeWavBuffer(seedByte) {
    const dataLen = 32; // small synthetic WAV body
    const total = 36 + dataLen;
    const buf = Buffer.alloc(8 + total);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(total, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(16000, 24);
    buf.writeUInt32LE(32000, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(dataLen, 40);
    for (let i = 0; i < dataLen; i += 1) {
      buf.writeUInt8(seedByte, 44 + i);
    }
    return buf;
  }

  function streamFromChunks(chunks) {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        controller.close();
      },
    });
  }

  it("synthesizeStream POSTs to /v1/audio/speech/stream and yields each WAV chunk separately", async () => {
    const wavA = makeWavBuffer(0x11);
    const wavB = makeWavBuffer(0x22);
    let capturedUrl;
    global.fetch = vi.fn(async (url, _init) => {
      capturedUrl = url;
      return new Response(streamFromChunks([wavA, wavB]), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    });
    const p = createCosyVoice2TtsProvider({ base_url: "http://tts.local", default_voice: "中文女" });
    const yields = [];
    for await (const piece of p.synthesizeStream("你好世界")) {
      yields.push(piece);
    }
    expect(capturedUrl).toBe("http://tts.local/v1/audio/speech/stream");
    expect(yields).toHaveLength(2);
    expect(yields[0].mimeType).toBe("audio/wav");
    expect(yields[0].provider).toBe("cosyvoice2");
    expect(Buffer.compare(yields[0].audio, wavA)).toBe(0);
    expect(Buffer.compare(yields[1].audio, wavB)).toBe(0);
  });

  it("synthesizeStream re-frames WAV chunks split mid-buffer across network boundaries", async () => {
    const wavA = makeWavBuffer(0x33);
    const wavB = makeWavBuffer(0x44);
    // 把 wavA 后半 + wavB 前半放进同一个 chunk
    const cut = 30;
    const chunkA = wavA.subarray(0, cut);
    const chunkAB = Buffer.concat([wavA.subarray(cut), wavB.subarray(0, cut)]);
    const chunkB = wavB.subarray(cut);
    global.fetch = vi.fn(async () => new Response(streamFromChunks([chunkA, chunkAB, chunkB]), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    }));
    const p = createCosyVoice2TtsProvider({ base_url: "http://tts.local" });
    const yields = [];
    for await (const piece of p.synthesizeStream("跨边界 chunk")) yields.push(piece);
    expect(yields).toHaveLength(2);
    expect(Buffer.compare(yields[0].audio, wavA)).toBe(0);
    expect(Buffer.compare(yields[1].audio, wavB)).toBe(0);
  });

  it("synthesizeStream throws on non-200 status", async () => {
    global.fetch = vi.fn(async () => new Response("server boom", { status: 503 }));
    const p = createCosyVoice2TtsProvider();
    await expect(async () => {
      // eslint-disable-next-line no-unused-vars -- iterator is what triggers the throw
      for await (const _ of p.synthesizeStream("x")) { /* drain */ }
    }).rejects.toThrow(/HTTP 503/);
  });

  it("synthesizeStream rejects corrupt RIFF stream rather than emitting bad audio", async () => {
    global.fetch = vi.fn(async () => new Response(streamFromChunks([Buffer.from("not a wav at all 1234567890123")]), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    }));
    const p = createCosyVoice2TtsProvider();
    await expect(async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of p.synthesizeStream("x")) { /* drain */ }
    }).rejects.toThrow(/corrupt RIFF/);
  });

  it("synthesizeStream rejects empty input upfront", async () => {
    const p = createCosyVoice2TtsProvider();
    await expect(async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of p.synthesizeStream("")) { /* never */ }
    }).rejects.toThrow(/empty text/);
  });
});

describe("normalizeChineseTtsText", () => {
  it("turns compact weather/date text into Chinese speech text", () => {
    expect(normalizeChineseTtsText("2026-05-01 深圳 21~26℃，30%")).toBe(
      "二零二六年五月一日 深圳 二十一到二十六摄氏度，百分之三十",
    );
  });

  it("keeps long identifiers digit-by-digit instead of English tokens", () => {
    expect(normalizeChineseTtsText("600176 今天上涨 3.5%")).toBe("六零零一七六 今天上涨 百分之三点五");
  });

  it("strips emoji before text is sent to TTS", () => {
    expect(stripEmojiForTts("在呢在呢！😁 有什么需要帮忙的？")).toBe("在呢在呢！ 有什么需要帮忙的？");
    expect(normalizeChineseTtsText("明天 5 月 1 日可以去 😊")).toBe("明天 五月一日可以去");
  });
});

describe("Edge TTS fallback provider", () => {
  class FakeEdgeWebSocket {
    static instances = [];
    handlers = {};
    sent = [];

    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      FakeEdgeWebSocket.instances.push(this);
    }

    on(event, cb) {
      this.handlers[event] = cb;
      return this;
    }

    send(message, _opts, cb) {
      this.sent.push(message);
      cb?.();
    }

    close() {}

    open() {
      this.handlers.open?.();
    }

    message(data, isBinary) {
      this.handlers.message?.(data, isBinary);
    }
  }

  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
    FakeEdgeWebSocket.instances = [];
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("synthesizes raw 16k PCM through Edge read-aloud websocket", async () => {
    const p = createEdgeTtsProvider({
      websocketCtor: FakeEdgeWebSocket,
      default_voice: "zh-CN-XiaoxiaoNeural",
      timeout_ms: 1000,
    });

    const pending = p.synthesize("你好 <Lynn>", { speed: 1.2 });
    const ws = FakeEdgeWebSocket.instances[0];
    ws.open();
    const pcm = Buffer.from([1, 2, 3, 4]);
    ws.message(Buffer.concat([Buffer.from("Path:audio\r\n"), pcm]), true);
    ws.message(Buffer.from("Path:turn.end\r\n"), false);

    const result = await pending;
    expect(result.provider).toBe("edge-tts");
    expect(result.mimeType).toContain("audio/pcm");
    expect(Buffer.compare(result.audio, pcm)).toBe(0);
    expect(ws.sent[0]).toContain("raw-16khz-16bit-mono-pcm");
    expect(ws.sent[1]).toContain("rate='+20%'");
    expect(ws.sent[1]).toContain("你好 &lt;Lynn&gt;");
  });

  it("health checks the Edge voice list endpoint", async () => {
    global.fetch = vi.fn(async () => new Response("[]", { status: 200 }));
    const p = createEdgeTtsProvider({ websocketCtor: FakeEdgeWebSocket });
    expect(await p.health()).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toContain("/voices/list");
  });

  it("rejects cleanly when Edge synthesis is aborted before websocket open", async () => {
    const controller = new AbortController();
    controller.abort();
    const p = createEdgeTtsProvider({ websocketCtor: FakeEdgeWebSocket, timeout_ms: 1000 });
    await expect(p.synthesize("你好", { signal: controller.signal })).rejects.toThrow(/aborted/);
  });
});

describe("TTS fallback chain", () => {
  it("reports degraded health when primary fails but fallback is reachable", async () => {
    const p = createTTSFallbackProvider({}, {
      primaryProvider: { name: "primary", health: vi.fn(async () => false), synthesize: vi.fn() },
      fallbackProvider: { name: "fallback", health: vi.fn(async () => true), synthesize: vi.fn() },
    });
    await expect(p.health()).resolves.toMatchObject({
      ok: false,
      fallbackOk: true,
      degraded: true,
    });
  });

  it("uses fallback synthesis when the primary provider throws", async () => {
    const primary = {
      name: "primary",
      synthesize: vi.fn(async () => { throw new Error("primary down"); }),
      health: vi.fn(async () => false),
    };
    const fallback = {
      name: "fallback",
      synthesize: vi.fn(async () => ({ audio: Buffer.from([9]), provider: "fallback" })),
      health: vi.fn(async () => true),
    };
    const p = createTTSFallbackProvider({}, { primaryProvider: primary, fallbackProvider: fallback });
    const result = await p.synthesize("你好");
    expect(primary.synthesize).toHaveBeenCalledTimes(1);
    expect(fallback.synthesize).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      provider: "fallback",
      fallbackUsed: true,
      primaryError: "primary down",
    });
  });
});
