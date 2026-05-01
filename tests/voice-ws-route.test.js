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
