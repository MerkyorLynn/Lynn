/**
 * Voice WS — DS V4 Pro 反馈 #2 + #3 回归测试
 *   #2: emotion2vec+ 只跑 4s 短段(开头 1s + 结尾 3s)→ extractEmotionSegment
 *   #3: 打断 T1/T2 状态机 → onInterrupt + resolveInterruptedReply + isSemanticTranscript
 */
import { describe, expect, it, vi } from "vitest";
import {
  FRAME,
  STATE,
  extractEmotionSegment,
  isSemanticTranscript,
  pcm16ToWav,
  createVoiceWsRoute,
  makeFrame,
  parseFrame,
} from "../server/routes/voice-ws.js";

// ───────────────────────────── 补单 #2 · 4s 切段 ─────────────────────────────

describe("extractEmotionSegment — DS 反馈 #2", () => {
  const SR = 16000;
  // 16kHz Int16 mono 假 PCM(正弦样),每字节 2B
  function makePcm(seconds, pattern = 0x1234) {
    const samples = SR * seconds;
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) buf.writeInt16LE(pattern, i * 2);
    return buf;
  }

  it("音频 ≤ 4s 原样返回(不做切段)", () => {
    const pcm = makePcm(2);
    const wav = pcm16ToWav(pcm, { sampleRate: SR });
    const out = extractEmotionSegment(wav);
    expect(out).toBe(wav); // 引用相等 = 原样返回
  });

  it("音频 10s 被切成 4s(开头 1s + 结尾 3s)", () => {
    const pcm = makePcm(10);
    const wav = pcm16ToWav(pcm, { sampleRate: SR });
    const out = extractEmotionSegment(wav);
    // 44 字节 WAV header + 4s * 16000 * 2B = 44 + 128000 = 128044
    expect(out.length).toBe(44 + 4 * SR * 2);
    // 出来的也是合法 WAV
    expect(out.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(out.subarray(8, 12).toString("ascii")).toBe("WAVE");
  });

  it("自定义 head/tail 参数可工作", () => {
    const pcm = makePcm(20);
    const wav = pcm16ToWav(pcm, { sampleRate: SR });
    const out = extractEmotionSegment(wav, { headSeconds: 2, tailSeconds: 2 });
    expect(out.length).toBe(44 + 4 * SR * 2); // 2 + 2 = 4s
  });

  it("保留 sampleRate 信息(不默认覆盖)", () => {
    const pcm = makePcm(10);
    const wav = pcm16ToWav(pcm, { sampleRate: 8000 }); // 8kHz
    const out = extractEmotionSegment(wav);
    // WAV header byte 24-27 是 sampleRate
    expect(out.readUInt32LE(24)).toBe(8000);
  });
});

// ───────────────────────────── 补单 #3 · 语义判定 ─────────────────────────────

describe("isSemanticTranscript — DS 反馈 #3", () => {
  it("正常话语 → true", () => {
    expect(isSemanticTranscript("你好,今天天气怎么样?")).toBe(true);
    expect(isSemanticTranscript("帮我查下上海到北京的机票")).toBe(true);
    expect(isSemanticTranscript("hello world")).toBe(true);
  });

  it("纯拟声词/笑声/语气助词 → false(T2 要丢弃)", () => {
    expect(isSemanticTranscript("嗯")).toBe(false);
    expect(isSemanticTranscript("嗯嗯嗯")).toBe(false);
    expect(isSemanticTranscript("啊")).toBe(false);
    expect(isSemanticTranscript("咳咳")).toBe(false);
    expect(isSemanticTranscript("haha")).toBe(false);
    expect(isSemanticTranscript("uh huh")).toBe(false);
    expect(isSemanticTranscript("嗯,")).toBe(false);
    expect(isSemanticTranscript("哦。")).toBe(false);
  });

  it("空/过短 → false", () => {
    expect(isSemanticTranscript("")).toBe(false);
    expect(isSemanticTranscript("  ")).toBe(false);
    expect(isSemanticTranscript("a")).toBe(false);
  });

  it("拟声词 + 实际内容 → true(含信息)", () => {
    expect(isSemanticTranscript("嗯,好的,我知道了")).toBe(true);
    expect(isSemanticTranscript("哦?真的吗?")).toBe(true);
  });
});

// ─────────────────────── 补单 #3 · T1/T2 状态机集成 ───────────────────────

class MockWs {
  constructor() { this.readyState = 1; this.sent = []; }
  send(buf) { this.sent.push(buf); }
}

function makeUpgrade() {
  let captured;
  return {
    upgradeWebSocket: (h) => { captured = h; return () => undefined; },
    invoke: (c = {}) => captured(c),
  };
}

/**
 * 驱动一个 VoiceSession 走完 THINKING/SPEAKING → INTERRUPT → EOT 再转写 →
 * 根据 transcript 语义验证 saveInterruptedTurn 是否被调/是否被跳过。
 *
 * Timing 说明:
 *   - mock TTS 立即返回 100ms 静音(小,让 speakText for-loop 快速进入 push)
 *   - 第一轮 THINK→SPEAK 预热 250ms,确保至少 1 个 segment 推完(push 到 playedSegments)
 *   - INTERRUPT 后再给 50ms 让 turnAbort 传播
 *   - EOT 之后给 80ms 让 processTurn 走完 resolveInterruptedReply
 */
async function driveInterruptScenario({ asrText, saveImpl }) {
  const saveInterruptedTurn = vi.fn(saveImpl || (() => Promise.resolve()));
  const asrProvider = {
    name: "mock-asr",
    async transcribe() { return { text: asrText }; },
    async health() { return true; },
  };
  const serProvider = {
    name: "mock-ser",
    async classify() { return { tag: "neutral", score: 0.9 }; },
    async health() { return true; },
    async warmup() { return true; },
  };
  // TTS mock: 每段 synth 100ms 延迟(模拟真实 CosyVoice 生成耗时),
  // 给 INTERRUPT 一个进入第二段 synth 期间的窗口,确保:
  //   - 第一段 synth 完 + PCM 推完 + push 到 playedSegments
  //   - 第二段 synth 中被 abort,break 出 for 循环
  //   - currentReplyPlayed.playedSegments = ["第一段。"]
  const ttsProvider = {
    name: "mock-tts",
    async synthesize(_segment, opts) {
      await new Promise((r) => setTimeout(r, 100));
      if (opts?.signal?.aborted) throw new Error("aborted");
      const pcm = Buffer.alloc(Math.floor(16000 * 0.1) * 2);
      return { audio: pcm16ToWav(pcm) };
    },
    async health() { return true; },
  };
  const brainRunner = vi.fn(async () => "第一段。第二段。第三段。");

  const upg = makeUpgrade();
  createVoiceWsRoute({}, {}, {
    upgradeWebSocket: upg.upgradeWebSocket,
    asrProvider, serProvider, ttsProvider, brainRunner, saveInterruptedTurn,
    healthOnOpen: false,
    vadConfig: { enabled: false },
  });
  const hooks = upg.invoke();
  const ws = new MockWs();
  hooks.onOpen({}, ws);

  // 1) 触发一轮 TEXT_TURN → brainRunner → speakText
  await hooks.onMessage({ data: makeFrame(FRAME.TEXT_TURN, 0, 1, Buffer.from("你好", "utf-8")) }, ws);
  // 等第一段 synth(100ms)+ 推完,但还没到第二段 synth 完
  await new Promise((r) => setTimeout(r, 150));

  // 2) T1 · INTERRUPT(此时第二段正在 synth,打断后 T1 快照会拿到 playedSegments=1)
  await hooks.onMessage({ data: makeFrame(FRAME.INTERRUPT, 0, 2, Buffer.alloc(0)) }, ws);
  await new Promise((r) => setTimeout(r, 80));

  // 3) T2 · 送 PCM + EOT → processTurn → resolveInterruptedReply
  await hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 3, Buffer.alloc(1600 * 2)) }, ws);
  await hooks.onMessage({ data: makeFrame(FRAME.END_OF_TURN, 0, 4, Buffer.alloc(0)) }, ws);
  await new Promise((r) => setTimeout(r, 200));

  return { saveInterruptedTurn, ws };
}

describe("voice-ws interrupted T1/T2 state machine — DS 反馈 #3", () => {
  it("T1+T2: 打断后真实 transcript → 调用 saveInterruptedTurn(interrupted=true)", async () => {
    const { saveInterruptedTurn } = await driveInterruptScenario({
      asrText: "等等,我想问另一个问题",
      expectSaved: true,
    });
    expect(saveInterruptedTurn).toHaveBeenCalledTimes(1);
    const arg = saveInterruptedTurn.mock.calls[0][0];
    expect(arg.interrupted).toBe(true);
    expect(typeof arg.text).toBe("string");
    expect(arg.segmentsPlayed).toBeGreaterThanOrEqual(1);
    expect(arg.totalSegments).toBe(3);
    expect(arg.interruptedAt).toBeGreaterThanOrEqual(arg.startedAt);
  });

  it("T1+T2: 打断后只有咳嗽/拟声 → 回滚,不保存", async () => {
    const { saveInterruptedTurn } = await driveInterruptScenario({
      asrText: "咳咳",
      expectSaved: false,
    });
    expect(saveInterruptedTurn).not.toHaveBeenCalled();
  });

  it("T1+T2: saveInterruptedTurn 抛错也不崩会话", async () => {
    const { saveInterruptedTurn } = await driveInterruptScenario({
      asrText: "帮我打开浏览器",
      saveImpl: () => Promise.reject(new Error("db down")),
    });
    expect(saveInterruptedTurn).toHaveBeenCalledTimes(1);
    // 没有抛到外层即可
  });

  it("T1+T2: 无 saveInterruptedTurn 钩子也不崩(向后兼容)", async () => {
    // 重新构造一个 session,不传 saveInterruptedTurn
    const asrProvider = { name: "a", transcribe: async () => ({ text: "真问题" }), health: async () => true };
    const serProvider = { name: "s", classify: async () => ({ tag: "neutral", score: 0.5 }), health: async () => true, warmup: async () => true };
    const ttsProvider = {
      name: "t",
      async synthesize(_s, opts) {
        await new Promise((r) => setTimeout(r, 100));
        if (opts?.signal?.aborted) throw new Error("aborted");
        return { audio: pcm16ToWav(Buffer.alloc(Math.floor(16000 * 0.1) * 2)) };
      },
      health: async () => true,
    };
    const brainRunner = async () => "A。B。C。";
    const upg = makeUpgrade();
    createVoiceWsRoute({}, {}, {
      upgradeWebSocket: upg.upgradeWebSocket,
      asrProvider, serProvider, ttsProvider, brainRunner,
      healthOnOpen: false,
      vadConfig: { enabled: false },
      // 注意:这里故意不传 saveInterruptedTurn
    });
    const hooks = upg.invoke();
    const ws = new MockWs();
    hooks.onOpen({}, ws);
    await hooks.onMessage({ data: makeFrame(FRAME.TEXT_TURN, 0, 1, Buffer.from("hi", "utf-8")) }, ws);
    await new Promise((r) => setTimeout(r, 150));
    await hooks.onMessage({ data: makeFrame(FRAME.INTERRUPT, 0, 2, Buffer.alloc(0)) }, ws);
    await hooks.onMessage({ data: makeFrame(FRAME.PCM_AUDIO, 0, 3, Buffer.alloc(1600 * 2)) }, ws);
    await hooks.onMessage({ data: makeFrame(FRAME.END_OF_TURN, 0, 4, Buffer.alloc(0)) }, ws);
    await new Promise((r) => setTimeout(r, 200));
    // 跑到这里没抛就通过
    expect(true).toBe(true);
  });
});
