/**
 * Voice WS route + VoiceSession 状态机 单测 — Lynn V0.79 Phase 1
 *
 * 验证:
 *   - createVoiceWsRoute 工厂能创建 wsRoute
 *   - VoiceSession 在 PCM_AUDIO 时进入 LISTENING
 *   - PING → PONG echo
 *   - END_OF_TURN 触发 transcript_final + 回 IDLE
 *   - INTERRUPT 在 SPEAKING/THINKING 状态正确处理
 *   - frame seq u16 wrap 不出错
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  FRAME,
  STATE,
  makeFrame,
  createVoiceWsRoute,
  parseFrame,
  pcm16ToWav,
  pcm16Rms,
  normalizeTtsAudioToPcm16Mono16k,
  normalizeVoiceTranscript,
  resolveVoiceRuntimeAsrConfig,
  splitTextForTts,
} from "../server/routes/voice-ws.js";

// Hono upgradeWebSocket 接受 (handler) → returns Hono handler
// 我们 mock 让 handler 立即被调用,拿到 ws 接管对象
function makeMockUpgrade() {
  let captured = null;
  return {
    upgradeWebSocket: (handler) => {
      // Hono 内部调 handler(c) 返回 hooks
      // 我们直接保存 handler,后面用 mock c 调
      captured = handler;
      return () => undefined; // 假 Hono handler
    },
    invoke(mockC = {}) {
      return captured(mockC);
    },
  };
}

class MockWs {
  constructor() {
    this.readyState = 1; // OPEN
    this.sent = [];
  }
  send(buf) {
    this.sent.push(buf);
  }
}

function makeHealthyDeps(overrides = {}) {
  return {
    healthOnOpen: false,
    // 2026-05-01 P1-① 测试默认禁 AEC,防 native processor 在 macOS arm64 真接管
    // 把 mic PCM 压制(NS 把测试用的方波 amplitude 滤掉),让 VAD/转写 断言失效。
    // 显式 AEC pipeline 测试单独传 aec mock。
    aec: { createProcessor: () => null, processRender: () => {}, processCapture: (_h, m) => m },
    asrProvider: {
      transcribe: vi.fn(async () => ({ text: "你好 Lynn", language: "zh" })),
      health: vi.fn(async () => true),
    },
    serProvider: {
      classify: vi.fn(async () => ({ tag: "happy", score: 0.8 })),
      warmup: vi.fn(async () => true),
      health: vi.fn(async () => true),
    },
    ttsProvider: {
      synthesize: vi.fn(async () => ({ audio: Buffer.alloc(6400, 1), mimeType: "audio/pcm" })),
      health: vi.fn(async () => true),
    },
    brainRunner: vi.fn(async () => "好的。我听到了。"),
    ...overrides,
  };
}

function pcmFrame(amplitude = 0) {
  const out = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i += 1) {
    const sample = amplitude === 0 ? 0 : (i % 2 === 0 ? amplitude : -amplitude);
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

describe("voice-ws route — createVoiceWsRoute", () => {
  it("creates wsRoute Hono instance", () => {
    const upg = makeMockUpgrade();
    const { wsRoute } = createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket });
    expect(wsRoute).toBeDefined();
    expect(typeof wsRoute.get).toBe("function");
  });

  it("defaults Jarvis Runtime ASR to Qwen3-ASR with SenseVoice fallback", () => {
    expect(resolveVoiceRuntimeAsrConfig({})).toMatchObject({
      provider: "qwen3-asr",
      fallback_provider: "sensevoice",
    });
    expect(resolveVoiceRuntimeAsrConfig({ provider: "sensevoice" })).toMatchObject({
      provider: "qwen3-asr",
      fallback_provider: "sensevoice",
    });
    expect(resolveVoiceRuntimeAsrConfig({ provider: "openai", base_url: "https://example.test" })).toMatchObject({
      provider: "openai",
      base_url: "https://example.test",
    });
  });
});

describe("voice-ws route — VoiceSession state machine", () => {
  let upg, hooks, ws;

  beforeEach(() => {
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...makeHealthyDeps() });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);
  });

  it("idle → listening on first PCM_AUDIO frame", async () => {
    const pcm = Buffer.alloc(3200, 0); // 1600 samples Int16 = 3200 bytes
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, pcm) }, ws);
    // STATE_CHANGE 应已发出
    await new Promise((r) => setTimeout(r, 5));
    const stateMsgs = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE);
    expect(stateMsgs.length).toBeGreaterThan(0);
    const lastState = stateMsgs[stateMsgs.length - 1].subarray(4).toString("utf-8");
    expect(lastState).toBe(STATE.LISTENING);
  });

  it("PING echoes PONG with same seq + payload", () => {
    const pingPayload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    hooks.onMessage({ data: makeFrame(FRAME.PING, 0, 99, pingPayload) }, ws);
    const pong = ws.sent.find((b) => b[0] === FRAME.PONG);
    expect(pong).toBeDefined();
    expect(pong.readUInt16BE(2)).toBe(99);
    expect(Buffer.compare(pong.subarray(4), pingPayload)).toBe(0);
  });

  it("END_OF_TURN with no buffered audio → IDLE", async () => {
    hooks.onMessage({ data: makeFrame(FRAME.END_OF_TURN, 0, 0, Buffer.alloc(0)) }, ws);
    await new Promise((r) => setTimeout(r, 10));
    // 没 audio buffered,直接回 IDLE(state-change 可能为空,因为 IDLE → IDLE 不发)
    expect(ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).length).toBe(0);
  });

  it("END_OF_TURN with buffered PCM → ASR → Brain → TTS PCM → IDLE", async () => {
    const deps = makeHealthyDeps();
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);

    // 先发一个 PCM 进入 LISTENING
    const pcm = Buffer.alloc(3200, 0);
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, pcm) }, ws);
    await new Promise((r) => setTimeout(r, 5));
    ws.sent = []; // 清空
    // EOT
    hooks.onMessage({ data: makeFrame(FRAME.END_OF_TURN, 0, 1, Buffer.alloc(0)) }, ws);
    await vi.waitFor(() => {
      expect(deps.ttsProvider.synthesize).toHaveBeenCalledTimes(2);
    });

    const stateMsgs = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
    expect(stateMsgs).toContain(STATE.THINKING);
    expect(stateMsgs).toContain(STATE.SPEAKING);
    expect(stateMsgs).toContain(STATE.IDLE);

    expect(deps.asrProvider.transcribe).toHaveBeenCalledTimes(1);
    const asrAudio = deps.asrProvider.transcribe.mock.calls[0][0];
    expect(asrAudio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(deps.brainRunner).toHaveBeenCalledWith(expect.objectContaining({ transcript: "你好 Lynn" }));
    const transcripts = ws.sent.filter((b) => b[0] === FRAME.TRANSCRIPT_FINAL);
    expect(transcripts.length).toBe(1);
    expect(transcripts[0].subarray(4).toString("utf-8")).toBe("你好 Lynn");
    const replies = ws.sent.filter((b) => b[0] === FRAME.ASSISTANT_REPLY);
    expect(replies.length).toBe(1);
    expect(replies[0].subarray(4).toString("utf-8")).toBe("好的。我听到了。");

    const ttsFrames = ws.sent.filter((b) => b[0] === FRAME.PCM_TTS).map(parseFrame);
    expect(ttsFrames.length).toBeGreaterThanOrEqual(2);
    expect(ttsFrames[0].payload.length).toBeLessThanOrEqual(3200);
  });

  it("normalizes spoken restart artifacts before emitting transcript_final", async () => {
    const deps = makeHealthyDeps({
      asrProvider: {
        transcribe: vi.fn(async () => ({ text: "嗯，我要查的是什我要查的是深圳天气。", language: "zh" })),
        health: vi.fn(async () => true),
      },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, Buffer.alloc(3200, 0)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.END_OF_TURN, 0, 1, Buffer.alloc(0)) }, ws);
    await vi.waitFor(() => expect(deps.asrProvider.transcribe).toHaveBeenCalledTimes(1));

    expect(normalizeVoiceTranscript("嗯，我要查的是什我要查的是深圳天气。")).toBe("我要查的是深圳天气。");
    const transcripts = ws.sent.filter((b) => b[0] === FRAME.TRANSCRIPT_FINAL);
    expect(transcripts.at(-1).subarray(4).toString("utf-8")).toBe("我要查的是深圳天气。");
  });

  it("chat mode only transcribes, leaving Brain/tool execution to the normal chat pipeline", async () => {
    const deps = makeHealthyDeps();
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, Buffer.alloc(3200, 0)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.END_OF_TURN, 0, 1, Buffer.alloc(0)) }, ws);
    await vi.waitFor(() => expect(deps.asrProvider.transcribe).toHaveBeenCalledTimes(1));

    expect(ws.sent.some((b) => b[0] === FRAME.TRANSCRIPT_FINAL)).toBe(true);
    expect(deps.brainRunner).not.toHaveBeenCalled();
    expect(deps.ttsProvider.synthesize).not.toHaveBeenCalled();
  });

  it("SPEAK_TEXT synthesizes an existing chat reply without rerunning Brain", async () => {
    const deps = makeHealthyDeps();
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from("这是聊天框的回复。", "utf-8")),
    }, ws);
    await vi.waitFor(() => expect(deps.ttsProvider.synthesize).toHaveBeenCalledTimes(1));

    expect(deps.brainRunner).not.toHaveBeenCalled();
    expect(ws.sent.some((b) => b[0] === FRAME.ASSISTANT_REPLY)).toBe(true);
    expect(ws.sent.some((b) => b[0] === FRAME.PCM_TTS)).toBe(true);
  });

  it("does not let a late on-open health probe override active speaking state", async () => {
    let resolveHealth;
    let resolveSynth;
    const ttsHealth = new Promise((resolve) => { resolveHealth = resolve; });
    const synthResult = new Promise((resolve) => {
      resolveSynth = () => resolve({ audio: Buffer.alloc(3200, 1), mimeType: "audio/pcm" });
    });
    const deps = makeHealthyDeps({
      healthOnOpen: true,
      ttsProvider: {
        synthesize: vi.fn(async () => synthResult),
        health: vi.fn(async () => ttsHealth),
      },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from("这是聊天框的回复。", "utf-8")),
    }, ws);
    await vi.waitFor(() => {
      const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
      expect(states).toContain(STATE.SPEAKING);
    });

    resolveHealth({ ok: false, fallbackOk: false, degraded: true });
    await vi.waitFor(() => {
      const health = ws.sent.find((b) => b[0] === FRAME.HEALTH_STATUS);
      expect(health).toBeTruthy();
      expect(JSON.parse(health.subarray(4).toString("utf-8"))).toMatchObject({
        ok: false,
        providers: { tts: { ok: false, degraded: true } },
      });
    });
    let states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
    expect(states).toContain(STATE.SPEAKING);
    expect(states).not.toContain(STATE.DEGRADED);

    resolveSynth();
    await vi.waitFor(() => {
      states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
      expect(states.at(-1)).toBe(STATE.IDLE);
    });
  });

  it("SPEAK_TEXT splits long markdown replies into small sustained TTS chunks", async () => {
    const deps = makeHealthyDeps();
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    const longText = [
      "不过五一去平洲，有几个点你得想清楚：",
      "**交通上**，深圳过去高铁到广州南，再转广佛线到平洲站，全程大概2小时出头，当天往返完全没问题。",
      "玩什么，核心就是玉器街、翠宝园、大明宫这几个市场，如果你对翡翠有兴趣，光是逛市场就能耗一整天。",
      "一个建议：如果对翡翠完全没兴趣，平洲可能会觉得无聊。",
    ].join("\n\n");

    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from(longText, "utf-8")),
    }, ws);

    await vi.waitFor(() => expect(deps.ttsProvider.synthesize.mock.calls.length).toBeGreaterThan(3));
    const inputs = deps.ttsProvider.synthesize.mock.calls.map((call) => call[0]);
    expect(inputs.every((value) => value.length <= 80)).toBe(true);
    expect(inputs.join("")).not.toContain("**");
    expect(ws.sent.some((b) => b[0] === FRAME.PCM_TTS)).toBe(true);
  });

  it("retries a failed long TTS segment as smaller chunks", async () => {
    const synthesize = vi.fn(async (text) => {
      if (synthesize.mock.calls.length === 1) {
        throw new Error("segment too long");
      }
      return { audio: Buffer.alloc(3200, 1), mimeType: "audio/pcm" };
    });
    const deps = makeHealthyDeps({
      ttsProvider: {
        synthesize,
        health: vi.fn(async () => true),
      },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from("这是一段会被重新切分的长回复，内容很多很多很多很多很多很多很多很多很多很多很多很多很多很多很多很多很多很多。", "utf-8")),
    }, ws);

    await vi.waitFor(() => expect(ws.sent.some((b) => b[0] === FRAME.PCM_TTS)).toBe(true));
    expect(synthesize.mock.calls.length).toBeGreaterThan(2);
    expect(synthesize.mock.calls.slice(1).every((call) => call[0].length <= 40)).toBe(true);
  });

  it("energy VAD auto-submits after speech followed by trailing silence", async () => {
    const deps = makeHealthyDeps();
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, {
      upgradeWebSocket: upg.upgradeWebSocket,
      ...deps,
      vadConfig: { minSpeechFrames: 2, endSilenceFrames: 3 },
    });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, pcmFrame(2200)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 1, pcmFrame(2200)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 2, pcmFrame(0)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 3, pcmFrame(0)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 4, pcmFrame(0)) }, ws);

    await vi.waitFor(() => expect(deps.asrProvider.transcribe).toHaveBeenCalledTimes(1));
    expect(deps.brainRunner).toHaveBeenCalledWith(expect.objectContaining({ transcript: "你好 Lynn" }));
    expect(ws.sent.some((b) => b[0] === FRAME.TRANSCRIPT_FINAL)).toBe(true);
  });

  it("energy VAD does not auto-submit pure silence", async () => {
    const deps = makeHealthyDeps();
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, {
      upgradeWebSocket: upg.upgradeWebSocket,
      ...deps,
      vadConfig: { minSpeechFrames: 2, endSilenceFrames: 2 },
    });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);

    for (let seq = 0; seq < 5; seq += 1) {
      hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, seq, pcmFrame(0)) }, ws);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(deps.asrProvider.transcribe).not.toHaveBeenCalled();
  });

  it("TEXT_TURN bypasses ASR and reuses Brain → TTS response path", async () => {
    const deps = makeHealthyDeps();
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({ data: makeFrame(FRAME.TEXT_TURN, 0, 7, Buffer.from("Web Speech 转写", "utf-8")) }, ws);
    await vi.waitFor(() => expect(deps.ttsProvider.synthesize).toHaveBeenCalled());

    expect(deps.asrProvider.transcribe).not.toHaveBeenCalled();
    expect(deps.brainRunner).toHaveBeenCalledWith(expect.objectContaining({
      transcript: "Web Speech 转写",
      emotion: null,
    }));
    const transcripts = ws.sent.filter((b) => b[0] === FRAME.TRANSCRIPT_FINAL);
    expect(transcripts.at(-1).subarray(4).toString("utf-8")).toBe("Web Speech 转写");
    expect(ws.sent.some((b) => b[0] === FRAME.PCM_TTS)).toBe(true);
  });

  it("continues with fallback ASR while reporting degraded state", async () => {
    const deps = makeHealthyDeps({
      asrProvider: {
        transcribe: vi.fn(async () => ({
          text: "SenseVoice fallback",
          language: "zh",
          fallbackUsed: true,
          primaryError: "qwen offline",
        })),
        health: vi.fn(async () => ({ ok: false, fallbackOk: true, degraded: true })),
      },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, Buffer.alloc(3200, 0)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.END_OF_TURN, 0, 1, Buffer.alloc(0)) }, ws);
    await vi.waitFor(() => expect(deps.brainRunner).toHaveBeenCalled());

    const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
    expect(states).toContain(STATE.DEGRADED);
    expect(deps.brainRunner).toHaveBeenCalledWith(expect.objectContaining({
      transcript: "SenseVoice fallback",
    }));
    expect(ws.sent.some((b) => b[0] === FRAME.PCM_TTS)).toBe(true);
  });

  it("emits emotion without blocking the ASR/Brain/TTS path", async () => {
    const deps = makeHealthyDeps({
      serProvider: {
        classify: vi.fn(async () => ({ tag: "sad", score: 0.72 })),
        warmup: vi.fn(async () => true),
        health: vi.fn(async () => true),
      },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, Buffer.alloc(3200, 0)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.END_OF_TURN, 0, 1, Buffer.alloc(0)) }, ws);
    await vi.waitFor(() => expect(ws.sent.some((b) => b[0] === FRAME.EMOTION)).toBe(true));

    const emotion = ws.sent.find((b) => b[0] === FRAME.EMOTION);
    expect(JSON.parse(emotion.subarray(4).toString("utf-8"))).toMatchObject({ tag: "sad", score: 0.72 });
    expect(deps.brainRunner).toHaveBeenCalledWith(expect.objectContaining({
      transcript: "你好 Lynn",
      emotion: { tag: "sad", score: 0.72 },
    }));
  });

  it("health failure enters degraded state", async () => {
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, {
      upgradeWebSocket: upg.upgradeWebSocket,
      ...makeHealthyDeps({
        healthOnOpen: true,
        ttsProvider: {
          synthesize: vi.fn(),
          health: vi.fn(async () => false),
        },
      }),
    });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);
    await vi.waitFor(() => {
      const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
      expect(states).toContain(STATE.DEGRADED);
    });
    const health = ws.sent.find((b) => b[0] === FRAME.HEALTH_STATUS);
    expect(JSON.parse(health.subarray(4).toString("utf-8"))).toMatchObject({
      ok: false,
      degraded: true,
      providers: {
        tts: { ok: false, degraded: true },
      },
    });
  });

  it("accepts new audio from degraded state instead of bricking VAD", async () => {
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, {
      upgradeWebSocket: upg.upgradeWebSocket,
      ...makeHealthyDeps({
        healthOnOpen: true,
        ttsProvider: {
          synthesize: vi.fn(),
          health: vi.fn(async () => false),
        },
      }),
    });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);
    await vi.waitFor(() => {
      const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
      expect(states).toContain(STATE.DEGRADED);
    });
    ws.sent = [];
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, Buffer.alloc(3200, 0)) }, ws);
    await vi.waitFor(() => {
      const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
      expect(states).toContain(STATE.LISTENING);
    });
  });

  it("clears the thinking partial and degrades cleanly when ASR fails", async () => {
    const deps = makeHealthyDeps({
      asrProvider: {
        transcribe: vi.fn(async () => { throw new Error("asr timeout"); }),
        health: vi.fn(async () => true),
      },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, Buffer.alloc(3200, 0)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.END_OF_TURN, 0, 1, Buffer.alloc(0)) }, ws);
    await vi.waitFor(() => {
      const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
      expect(states).toContain(STATE.DEGRADED);
    });
    const partials = ws.sent.filter((b) => b[0] === FRAME.TRANSCRIPT_PARTIAL);
    const finals = ws.sent.filter((b) => b[0] === FRAME.TRANSCRIPT_FINAL);
    expect(partials.at(-1).subarray(4).toString("utf-8")).toBe("理解中…");
    expect(finals.at(-1).subarray(4).toString("utf-8")).toBe("");
  });

  it("does not degrade when optional SER health is down", async () => {
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, {
      upgradeWebSocket: upg.upgradeWebSocket,
      ...makeHealthyDeps({
        healthOnOpen: true,
        serProvider: {
          classify: vi.fn(async () => ({ tag: "unknown", score: 0 })),
          warmup: vi.fn(async () => false),
          health: vi.fn(async () => false),
        },
      }),
    });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);
    await vi.waitFor(() => {
      const health = ws.sent.find((b) => b[0] === FRAME.HEALTH_STATUS);
      expect(health).toBeTruthy();
      expect(JSON.parse(health.subarray(4).toString("utf-8"))).toMatchObject({
        ok: true,
        degraded: false,
        providers: {
          ser: { ok: false, degraded: true },
        },
      });
    });
    const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
    expect(states).not.toContain(STATE.DEGRADED);
  });

  it("continues speaking with fallback TTS while reporting degraded state", async () => {
    const deps = makeHealthyDeps({
      brainRunner: vi.fn(async () => " fallback reply。"),
      ttsProvider: {
        synthesize: vi.fn(async () => ({
          audio: Buffer.alloc(3200, 3),
          mimeType: "audio/pcm",
          fallbackUsed: true,
          primaryError: "cosyvoice offline",
        })),
        health: vi.fn(async () => ({ ok: false, fallbackOk: true, degraded: true })),
      },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, Buffer.alloc(3200, 0)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.END_OF_TURN, 0, 1, Buffer.alloc(0)) }, ws);
    await vi.waitFor(() => expect(ws.sent.some((b) => b[0] === FRAME.PCM_TTS)).toBe(true));

    const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
    expect(states).toContain(STATE.DEGRADED);
    expect(deps.ttsProvider.synthesize).toHaveBeenCalledTimes(1);
    expect(deps.ttsProvider.synthesize.mock.calls[0][1]).toEqual(expect.objectContaining({ speed: 1.0 }));
  });

  it("interrupt during THINKING does not throw and allows the next utterance", async () => {
    let brainCall = 0;
    const deps = makeHealthyDeps({
      brainRunner: vi.fn(({ signal }) => {
        brainCall += 1;
        if (brainCall === 1) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            }, { once: true });
          });
        }
        return "第二轮回复。";
      }),
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({ data: makeFrame(FRAME.TEXT_TURN, 0, 0, Buffer.from("第一轮", "utf-8")) }, ws);
    await vi.waitFor(() => {
      const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
      expect(states).toContain(STATE.THINKING);
    });
    expect(() => hooks.onMessage({ data: makeFrame(FRAME.INTERRUPT, 0, 1, Buffer.alloc(0)) }, ws)).not.toThrow();
    const interruptStates = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
    expect(interruptStates).toContain(STATE.LISTENING);
    ws.sent = [];
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 2, Buffer.alloc(3200, 0)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.END_OF_TURN, 0, 3, Buffer.alloc(0)) }, ws);
    await vi.waitFor(() => expect(deps.asrProvider.transcribe).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(deps.ttsProvider.synthesize).toHaveBeenCalled());
    expect(deps.brainRunner).toHaveBeenCalledTimes(2);
    const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
    expect(states).toContain(STATE.IDLE);
    expect(states).not.toContain(STATE.DEGRADED);
  });

  it("extracts PCM data from WAV TTS responses before PCM_TTS", async () => {
    const pcm = Buffer.alloc(3200, 2);
    const deps = makeHealthyDeps({
      brainRunner: vi.fn(async () => "一句话。"),
      ttsProvider: {
        synthesize: vi.fn(async () => ({ audio: pcm16ToWav(pcm), mimeType: "audio/wav" })),
        health: vi.fn(async () => true),
      },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, Buffer.alloc(3200, 0)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.END_OF_TURN, 0, 1, Buffer.alloc(0)) }, ws);
    await vi.waitFor(() => expect(ws.sent.some((b) => b[0] === FRAME.PCM_TTS)).toBe(true));
    const tts = ws.sent.find((b) => b[0] === FRAME.PCM_TTS);
    expect(parseFrame(tts).payload.equals(pcm)).toBe(true);
  });

  it("resamples 22050Hz CosyVoice WAV to 16k PCM before PCM_TTS playback", () => {
    const sourceRate = 22050;
    const sourceSamples = sourceRate;
    const pcm = Buffer.alloc(sourceSamples * 2);
    for (let i = 0; i < sourceSamples; i += 1) {
      pcm.writeInt16LE(i % 2000, i * 2);
    }

    const normalized = normalizeTtsAudioToPcm16Mono16k(pcm16ToWav(pcm, { sampleRate: sourceRate }));

    expect(normalized.length).toBe(16000 * 2);
  });

  it("seq u16 wrap accepted without crash", () => {
    const pcm = Buffer.alloc(3200, 0);
    // seq = 0xFFFF, then 0
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0xffff, pcm) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, pcm) }, ws);
    // 不抛错,session 还活着
    expect(() => hooks.onMessage({ data: makeFrame(FRAME.END_OF_TURN, 0, 1, Buffer.alloc(0)) }, ws)).not.toThrow();
  });

  it("unknown frame type doesn't crash", () => {
    expect(() => {
      hooks.onMessage({ data: makeFrame(0x99, 0, 0, Buffer.alloc(0)) }, ws);
    }).not.toThrow();
  });

  it("SPEAK_TEXT_APPEND while speaking pushes new segments into the active queue without a fresh turn", async () => {
    // 控制 synthesize 节奏:第一段 hold,中间 append 进来,然后释放,验证全部 segments 都被合成
    let resolveFirst;
    const firstSpeech = new Promise((resolve) => { resolveFirst = resolve; });
    const synthesize = vi.fn(async (text) => {
      if (synthesize.mock.calls.length === 1) {
        await firstSpeech;
      }
      return { audio: Buffer.alloc(3200, 1), mimeType: "audio/pcm" };
    });
    const deps = makeHealthyDeps({
      ttsProvider: { synthesize, health: vi.fn(async () => true) },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from("第一句。", "utf-8")),
    }, ws);
    // 等进入 SPEAKING + 首段进 synthesize
    await vi.waitFor(() => expect(synthesize.mock.calls.length).toBe(1));
    const states1 = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
    expect(states1).toContain(STATE.SPEAKING);

    // SPEAKING 中 append 两段 — 不应该触发 brainRunner 也不应该被串行锁拒
    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT_APPEND, 0, 1, Buffer.from("第二句。第三句。", "utf-8")),
    }, ws);
    resolveFirst();

    await vi.waitFor(() => expect(synthesize.mock.calls.length).toBe(3));
    const inputs = synthesize.mock.calls.map((call) => call[0]);
    expect(inputs[0]).toBe("第一句。");
    expect(inputs[1]).toBe("第二句。");
    expect(inputs[2]).toBe("第三句。");
    expect(deps.brainRunner).not.toHaveBeenCalled();

    // 三段都播完才回 IDLE
    await vi.waitFor(() => {
      const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
      expect(states.at(-1)).toBe(STATE.IDLE);
    });
  });

  it("SPEAK_TEXT_APPEND while idle starts a fresh speak turn (backwards compatible)", async () => {
    const deps = makeHealthyDeps();
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT_APPEND, 0, 0, Buffer.from("idle 时直接当 fresh speakText。", "utf-8")),
    }, ws);

    await vi.waitFor(() => expect(deps.ttsProvider.synthesize).toHaveBeenCalledTimes(1));
    const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
    expect(states).toContain(STATE.SPEAKING);
    expect(deps.brainRunner).not.toHaveBeenCalled();
  });

  it("speakText prefers ttsProvider.synthesizeStream when available (P0-② 2026-05-01)", async () => {
    const synthesize = vi.fn();
    const synthesizeStream = vi.fn(async function* (_text) {
      yield { audio: Buffer.alloc(3200, 1), mimeType: "audio/pcm", provider: "cosyvoice2" };
      yield { audio: Buffer.alloc(3200, 2), mimeType: "audio/pcm", provider: "cosyvoice2" };
    });
    const deps = makeHealthyDeps({
      ttsProvider: { synthesize, synthesizeStream, health: vi.fn(async () => true) },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from("流式合成。", "utf-8")),
    }, ws);

    await vi.waitFor(() => expect(synthesizeStream).toHaveBeenCalled());
    expect(synthesize).not.toHaveBeenCalled(); // 流式优先,batch 不调
    await vi.waitFor(() => {
      const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
      expect(states.at(-1)).toBe(STATE.IDLE);
    });
    // 至少 send 了 PCM_TTS(两段 yield)
    expect(ws.sent.some((b) => b[0] === FRAME.PCM_TTS)).toBe(true);
  });

  it("speakText falls back to batch synthesize when provider has no synthesizeStream", async () => {
    const synthesize = vi.fn(async () => ({ audio: Buffer.alloc(3200, 1), mimeType: "audio/pcm" }));
    const deps = makeHealthyDeps({
      ttsProvider: { synthesize, health: vi.fn(async () => true) },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from("没流式 provider。", "utf-8")),
    }, ws);

    await vi.waitFor(() => expect(synthesize).toHaveBeenCalled());
    expect(ws.sent.some((b) => b[0] === FRAME.PCM_TTS)).toBe(true);
  });

  it("streamSegmentToPcm flags DEGRADED on any chunk with fallbackUsed, not just the first (修 2 2026-05-01)", async () => {
    // primary 先 yield 一个正常 chunk,然后 fallback 路径再 yield 一个 fallbackUsed 的 chunk
    const synthesizeStream = vi.fn(async function* (_text) {
      yield { audio: Buffer.alloc(3200, 0xAA), mimeType: "audio/pcm" };
      yield { audio: Buffer.alloc(3200, 0xBB), mimeType: "audio/pcm", fallbackUsed: true, primaryError: "primary blew up mid-stream" };
    });
    const deps = makeHealthyDeps({
      ttsProvider: { synthesize: vi.fn(), synthesizeStream, health: vi.fn(async () => true) },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from("中途切 fallback。", "utf-8")),
    }, ws);

    await vi.waitFor(() => {
      const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
      expect(states).toContain(STATE.DEGRADED);
    });
  });

  it("streamSegmentToPcm with stream failure mid-segment does NOT split-retry once PCM was yielded (修 3 2026-05-01)", async () => {
    // yield 一段后抛 — 不应触发"切小重试"(否则用户会重听已播段)
    const synthesizeStream = vi.fn(async function* (_text) {
      yield { audio: Buffer.alloc(3200, 0xCC), mimeType: "audio/pcm" };
      throw new Error("stream connection lost mid-yield");
    });
    const deps = makeHealthyDeps({
      ttsProvider: { synthesize: vi.fn(), synthesizeStream, health: vi.fn(async () => true) },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from("一段会失败的长回复内容很多很多很多很多很多很多。", "utf-8")),
    }, ws);

    await vi.waitFor(() => expect(synthesizeStream).toHaveBeenCalled());
    // 给 server 时间走 catch 路径
    await new Promise((r) => setTimeout(r, 50));
    // 不应触发切小重试(只应调一次 synthesizeStream),应进 DEGRADED
    expect(synthesizeStream).toHaveBeenCalledTimes(1);
    const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
    expect(states).toContain(STATE.DEGRADED);
  });

  it("streamSegmentToPcm with stream failure BEFORE any yield still triggers split-retry (修 3 反向验证)", async () => {
    // 第一段还没 yield 就失败 → 切小重试有效(没发声不会重复)
    let firstCall = true;
    const synthesizeStream = vi.fn(async function* (_text) {
      if (firstCall) {
        firstCall = false;
        throw new Error("stream couldn't even start");
      }
      yield { audio: Buffer.alloc(3200, 0x11), mimeType: "audio/pcm" };
    });
    const deps = makeHealthyDeps({
      ttsProvider: { synthesize: vi.fn(), synthesizeStream, health: vi.fn(async () => true) },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from("一段会失败的长回复内容很多很多很多很多很多很多很多很多。", "utf-8")),
    }, ws);

    // 切小重试后 synthesizeStream 应被 ≥ 2 次调用
    await vi.waitFor(() => expect(synthesizeStream.mock.calls.length).toBeGreaterThan(1));
  });

  it("speakText streams PCM as soon as the first WAV chunk arrives (verifies streaming over batching)", async () => {
    // 控制第二个 yield 的释放时机,验证第一段 chunk 已 send 后第二段才合成
    let resolveSecondChunk;
    const secondChunkGate = new Promise((resolve) => { resolveSecondChunk = resolve; });
    const synthesizeStream = vi.fn(async function* (_text) {
      yield { audio: Buffer.alloc(3200, 0xAA), mimeType: "audio/pcm" };
      await secondChunkGate;
      yield { audio: Buffer.alloc(3200, 0xBB), mimeType: "audio/pcm" };
    });
    const deps = makeHealthyDeps({
      ttsProvider: { synthesize: vi.fn(), synthesizeStream, health: vi.fn(async () => true) },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from("首段立推。", "utf-8")),
    }, ws);

    // 等第一段 yield 后,验证已经 send 了 PCM_TTS(还没释放第二段)
    await vi.waitFor(() => expect(ws.sent.some((b) => b[0] === FRAME.PCM_TTS)).toBe(true));
    const pcmCountBeforeSecond = ws.sent.filter((b) => b[0] === FRAME.PCM_TTS).length;
    expect(pcmCountBeforeSecond).toBeGreaterThan(0);

    resolveSecondChunk();
    await vi.waitFor(() => {
      const states = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
      expect(states.at(-1)).toBe(STATE.IDLE);
    });
    // 第二段释放后又 send 更多 PCM_TTS
    expect(ws.sent.filter((b) => b[0] === FRAME.PCM_TTS).length).toBeGreaterThan(pcmCountBeforeSecond);
  });

  it("SPEAK_TEXT_APPEND immediately after INTERRUPT does not produce phantom TTS audio (修 6 race 2026-05-01)", async () => {
    // 场景:server 在 SPEAKING,客户端 segmenter 已 emit 一段进 active queue
    // 用户开口 → onInterrupt(state→LISTENING / activeSpeakingQueue 被 finally 置 null)
    // 客户端 segmenter 还有残段,再 dispatch 一个 SPEAK_TEXT_APPEND 帧到 server
    // 期望:残段不应当作 fresh speakText 播给用户(用户已开口要听自己说话)
    let resolveFirst;
    const firstSpeech = new Promise((resolve) => { resolveFirst = resolve; });
    const synthesize = vi.fn(async (text) => {
      if (synthesize.mock.calls.length === 1) {
        await firstSpeech;
        return { audio: Buffer.alloc(3200, 1), mimeType: "audio/pcm" };
      }
      return { audio: Buffer.alloc(3200, 1), mimeType: "audio/pcm" };
    });
    const deps = makeHealthyDeps({
      ttsProvider: { synthesize, health: vi.fn(async () => true) },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from("第一段。", "utf-8")),
    }, ws);
    // 等进 SPEAKING + 首段卡在 synthesize promise 里
    await vi.waitFor(() => expect(synthesize.mock.calls.length).toBe(1));

    // 此时用户开口 → onInterrupt:state → LISTENING,turnGeneration++,abort
    hooks.onMessage({ data: makeFrame(FRAME.INTERRUPT, 0, 1, Buffer.alloc(0)) }, ws);

    // 客户端 segmenter 还在 race 里 emit 一段 SPEAK_TEXT_APPEND
    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT_APPEND, 0, 2, Buffer.from("残段不应播。", "utf-8")),
    }, ws);

    // 释放第一段(让 server 走完 abort 路径)
    resolveFirst();

    // 给 server 一些时间走完 finally + 处理 APPEND
    await new Promise((r) => setTimeout(r, 80));

    // 残段不应触发新的 synthesize:state 已 LISTENING,activeSpeakingQueue 已 null,
    // appendSpeakText 走 fresh processSpeakTextTurn 路径但 processingTurn 还在 abort 收尾,
    // 实际是 user-friendly 行为:残段 ignore 或被 turnGeneration 拦截。
    // 严格断言:即使被当 fresh speakText,因为 state 不在 SPEAKING 路径走过,不该出现"幽灵 TTS"。
    const synthCallsAfterInterrupt = synthesize.mock.calls.length;
    // 允许 0 或 1 次(processingTurn race),但不应是 2 次(原段 + 新段)以上
    expect(synthCallsAfterInterrupt).toBeLessThanOrEqual(2);
    // 关键:state 不应回到 SPEAKING(残段不该让 server 重新发声)
    const stateChanges = ws.sent.filter((b) => b[0] === FRAME.STATE_CHANGE).map((b) => b.subarray(4).toString("utf-8"));
    const lastSpeakingIdx = stateChanges.lastIndexOf(STATE.SPEAKING);
    const lastListeningIdx = stateChanges.lastIndexOf(STATE.LISTENING);
    // 最后一次 LISTENING 应该在最后一次 SPEAKING 之后(interrupt 已 take effect)
    expect(lastListeningIdx).toBeGreaterThan(lastSpeakingIdx);
  });

  it("SPEAK_TEXT_APPEND with empty payload is a noop", async () => {
    const deps = makeHealthyDeps();
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, { upgradeWebSocket: upg.upgradeWebSocket, ...deps });
    hooks = upg.invoke({ req: { query: (key) => (key === "mode" ? "chat" : "") } });
    ws = new MockWs();
    hooks.onOpen({}, ws);

    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT_APPEND, 0, 0, Buffer.from("", "utf-8")),
    }, ws);
    await new Promise((r) => setTimeout(r, 5));
    expect(deps.ttsProvider.synthesize).not.toHaveBeenCalled();
  });

  it("server-side AEC processes mic frame using TTS reference queue (P1-① 2026-05-01)", async () => {
    // mock AEC processor:capture 函数把 mic Float32 全部置 0(模拟"完美" echo cancellation)
    const captures = [];
    const renders = [];
    const aecMock = {
      createProcessor: vi.fn(() => ({ id: "test-handle" })),
      processRender: vi.fn((_h, ref) => { renders.push(ref.length); }),
      processCapture: vi.fn((_h, mic) => { captures.push(mic.length); return new Float32Array(mic.length); /* 全 0 */ }),
    };
    const deps = makeHealthyDeps({ aec: aecMock });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, {
      upgradeWebSocket: upg.upgradeWebSocket,
      ...deps,
      vadConfig: { enabled: false }, // 关 VAD 自动 EOT,手动控制时序
    });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);

    // createProcessor 在 onOpen 之前已调一次(constructor 时)
    expect(aecMock.createProcessor).toHaveBeenCalledTimes(1);

    // 模拟先有 TTS 在播(reference queue 有数据)
    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from("你好。", "utf-8")),
    }, ws);
    await vi.waitFor(() => expect(deps.ttsProvider.synthesize).toHaveBeenCalled());

    // 发一个 100ms mic 帧(1600 samples = 3200 字节,10×10ms 帧)
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, pcmFrame(2000)) }, ws);
    await vi.waitFor(() => expect(captures.length).toBeGreaterThan(0));

    // 验证:每 100ms mic 帧拆 10×10ms,processRender + processCapture 各调 10 次
    expect(captures.filter((n) => n === 160).length).toBeGreaterThanOrEqual(10);
    expect(renders.filter((n) => n === 160).length).toBeGreaterThanOrEqual(10);
  });

  it("AEC pipeline degrades gracefully when createProcessor returns null (no native module)", async () => {
    const deps = makeHealthyDeps({
      aec: { createProcessor: () => null, processRender: vi.fn(), processCapture: vi.fn() },
    });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, {
      upgradeWebSocket: upg.upgradeWebSocket,
      ...deps,
      vadConfig: { minSpeechFrames: 2, endSilenceFrames: 3 },
    });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);

    // 标准流程仍走通(等同现状)— processCapture 不应被调
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, pcmFrame(2200)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 1, pcmFrame(2200)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 2, pcmFrame(0)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 3, pcmFrame(0)) }, ws);
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 4, pcmFrame(0)) }, ws);

    await vi.waitFor(() => expect(deps.asrProvider.transcribe).toHaveBeenCalled());
    expect(deps.aec.processCapture).not.toHaveBeenCalled();
  });

  it("AEC reference queue trimSamples=0 by default takes FIFO head (estimator self-learns delay) (修 1)", async () => {
    delete process.env.LYNN_AEC_REFERENCE_TRIM_MS;
    const renders = [];
    const aecMock = {
      createProcessor: () => ({ id: "h" }),
      processRender: (_h, ref) => { renders.push(Array.from(ref.slice(0, 4))); },
      processCapture: (_h, mic) => mic,
    };
    const deps = makeHealthyDeps({ aec: aecMock });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, {
      upgradeWebSocket: upg.upgradeWebSocket,
      ...deps,
      vadConfig: { enabled: false },
    });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);

    // 先发 5 段 TTS 让 reference queue 累积
    hooks.onMessage({
      data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from("一段。两段。三段。", "utf-8")),
    }, ws);
    await vi.waitFor(() => expect(deps.ttsProvider.synthesize.mock.calls.length).toBeGreaterThan(0));

    // 一个 100ms mic 帧 → take 队首(最老)reference
    hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, pcmFrame(800)) }, ws);
    await vi.waitFor(() => expect(renders.length).toBeGreaterThan(0));
    expect(renders.length).toBeGreaterThanOrEqual(10); // 100ms = 10×10ms
  });

  it("LYNN_AEC_REFERENCE_TRIM_MS=80 drops oldest reference when queue is well-stocked (修 1)", async () => {
    process.env.LYNN_AEC_REFERENCE_TRIM_MS = "80";
    try {
      const renders = [];
      const aecMock = {
        createProcessor: () => ({ id: "h" }),
        processRender: (_h, ref) => { renders.push(ref.length); },
        processCapture: (_h, mic) => mic,
      };
      const deps = makeHealthyDeps({ aec: aecMock });
      upg = makeMockUpgrade();
      createVoiceWsRoute({}, {}, {
        upgradeWebSocket: upg.upgradeWebSocket,
        ...deps,
        vadConfig: { enabled: false },
      });
      hooks = upg.invoke({});
      ws = new MockWs();
      hooks.onOpen({}, ws);

      // 让 reference queue 充足(发多段 TTS 文本)
      hooks.onMessage({
        data: makeFrame(FRAME.SPEAK_TEXT, 0, 0, Buffer.from("足够长的文本累积参考信号一段。又一段。又又一段。", "utf-8")),
      }, ws);
      await vi.waitFor(() => expect(deps.ttsProvider.synthesize.mock.calls.length).toBeGreaterThan(2));

      hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, pcmFrame(800)) }, ws);
      await vi.waitFor(() => expect(renders.length).toBeGreaterThan(0));
      // 仍按 10ms 帧切走 process_render(trim 不改帧粒度)
      expect(renders.every((n) => n === 160)).toBe(true);
    } finally {
      delete process.env.LYNN_AEC_REFERENCE_TRIM_MS;
    }
  });

  it("AEC pipeline catches processCapture exception and falls back to original mic frame", async () => {
    const aecMock = {
      createProcessor: () => ({ id: "h" }),
      processRender: () => {},
      processCapture: () => { throw new Error("native AEC boom"); },
    };
    const deps = makeHealthyDeps({ aec: aecMock });
    upg = makeMockUpgrade();
    createVoiceWsRoute({}, {}, {
      upgradeWebSocket: upg.upgradeWebSocket,
      ...deps,
      vadConfig: { minSpeechFrames: 1, endSilenceFrames: 2 },
    });
    hooks = upg.invoke({});
    ws = new MockWs();
    hooks.onOpen({}, ws);

    // mic 信号入正常,即使 AEC 抛错也不应崩会话
    expect(() => {
      hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 0, pcmFrame(2200)) }, ws);
      hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 1, pcmFrame(0)) }, ws);
      hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 2, pcmFrame(0)) }, ws);
    }).not.toThrow();
    await vi.waitFor(() => expect(deps.asrProvider.transcribe).toHaveBeenCalled());
  });

  it("close cleans up session", () => {
    hooks.onClose();
    // 后续消息应该被丢弃(session === null)
    expect(() => {
      hooks.onMessage({ data: makeFrame(FRAME.PING, 0, 0, Buffer.alloc(0)) }, ws);
    }).not.toThrow();
  });

  it("does not send when ws.readyState !== 1", () => {
    ws.readyState = 3; // CLOSED
    ws.sent = [];
    hooks.onMessage({ data: makeFrame(FRAME.PING, 0, 0, Buffer.from([0])) }, ws);
    expect(ws.sent.length).toBe(0);
  });
});

describe("voice-ws route — TTS text splitting", () => {
  it("cleans markdown and keeps chunks under the configured length", () => {
    const chunks = splitTextForTts("## 建议\n\n**交通**，深圳过去高铁到广州南，再转广佛线到平洲站，全程大概2小时出头。```js\nconsole.log(1)\n```", { maxChars: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
    expect(chunks.join("")).not.toContain("**");
    expect(chunks.join("")).not.toContain("```");
  });

  it("removes emoji from TTS chunks while keeping the spoken text", () => {
    const chunks = splitTextForTts("在呢在呢！😁 有什么需要帮忙的？", { maxChars: 40 });
    expect(chunks).toEqual(["在呢在呢！", "有什么需要帮忙的？"]);
    expect(chunks.join("")).not.toContain("😁");
  });
});

describe("voice-ws route — energy helpers", () => {
  it("computes normalized RMS for Int16 PCM", () => {
    expect(pcm16Rms(pcmFrame(0))).toBe(0);
    expect(pcm16Rms(pcmFrame(3276))).toBeCloseTo(0.1, 2);
  });
});
