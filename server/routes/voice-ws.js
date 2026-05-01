/**
 * voice-ws.js — Lynn V0.79 Jarvis Runtime WebSocket
 *
 * Voice WS hub:client ↔ server ↔ ASR/Brain/TTS 双向 PCM 管道。
 *
 * 协议(每帧 4 字节 header + payload):
 *   [type:u8] [flags:u8] [seq:u16 BE] [payload:variable]
 *
 * Types:
 *   0x01 PCM_AUDIO           client → server  mic PCM 16kHz Int16,100ms/chunk
 *   0x02 PCM_TTS             server → client  TTS PCM 16kHz Int16 mono
 *   0x10 PING                client → server  RTT 测量
 *   0x11 PONG                server → client  RTT 回包
 *   0x12 TRANSCRIPT_PARTIAL  server → client  ASR 增量(Phase 2B+)
 *   0x13 TRANSCRIPT_FINAL    server → client  ASR 最终文本
 *   0x14 EMOTION             server → client  emotion2vec+ JSON
 *   0x15 STATE_CHANGE        server → client  idle/listening/thinking/speaking/degraded
 *   0x16 HEALTH_STATUS       server → client  provider health/fallback JSON
 *   0x17 ASSISTANT_REPLY     server → client  Lynn 文字回复
 *   0x20 INTERRUPT           client → server  用户开口/打断
 *   0x30 END_OF_TURN         client → server  一轮结束
 *   0x31 TEXT_TURN           client → server  降级 ASR 已得出的转写文本
 *   0x32 SPEAK_TEXT          client → server  播放已有聊天回复文本
 *
 * Phase 2A:PCM → ASR → Brain → CosyVoice2 → PCM_TTS 最小闭环。
 * Phase 2B:server-side energy VAD fallback for auto end-of-turn.
 * Phase 2D:Silero/TEN VAD interrupt arbitration / AEC reference signal coordination.
 */
import { Hono } from "hono";
import fs from "fs";
import { debugLog } from "../../lib/debug-log.js";
import { stripEmojiForTts } from "../../shared/tts-text-normalizer.js";
import { createASRFallbackProvider } from "../clients/asr/index.js";
import { createSERProvider, EMOTION_LLM_HINT } from "../clients/ser/index.js";
import { createTTSFallbackProvider } from "../clients/tts/index.js";
import { enrichHealthWithTier } from "../chat/voice-fallback-orchestrator.js";

// 协议常量
export const FRAME = {
  PCM_AUDIO: 0x01,
  PCM_TTS: 0x02,
  PING: 0x10,
  PONG: 0x11,
  TRANSCRIPT_PARTIAL: 0x12,
  TRANSCRIPT_FINAL: 0x13,
  EMOTION: 0x14,
  STATE_CHANGE: 0x15,
  HEALTH_STATUS: 0x16,
  ASSISTANT_REPLY: 0x17,
  INTERRUPT: 0x20,
  END_OF_TURN: 0x30,
  TEXT_TURN: 0x31,
  SPEAK_TEXT: 0x32,
};

export const STATE = {
  IDLE: "idle",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking",
  DEGRADED: "degraded",
};

const PCM_SAMPLE_RATE = 16000;
const PCM_TTS_CHUNK_BYTES = 3200; // 100ms @ 16kHz Int16 mono
const TTS_MAX_SEGMENT_CHARS = 80;
const TTS_RETRY_MIN_SEGMENT_CHARS = 24;
const TTS_SEGMENT_TIMEOUT_MS = 45000;
const EMOTION_CURRENT_TURN_WAIT_MS = 250;
const DEFAULT_VAD_CONFIG = Object.freeze({
  enabled: true,
  speechRms: 0.012,
  silenceRms: 0.006,
  minSpeechFrames: 2, // 200ms speech before auto-EOT is armed
  endSilenceFrames: 8, // 800ms trailing silence
});

/**
 * 解析二进制帧
 * @param {Buffer|ArrayBuffer} data
 * @returns {{type:number,flags:number,seq:number,payload:Buffer}|null}
 */
export function parseFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 4) return null;
  return {
    type: buf.readUInt8(0),
    flags: buf.readUInt8(1),
    seq: buf.readUInt16BE(2),
    payload: buf.subarray(4),
  };
}

/**
 * 构造二进制帧
 * @param {number} type
 * @param {number} flags
 * @param {number} seq
 * @param {Buffer|Uint8Array} payload
 * @returns {Buffer}
 */
export function makeFrame(type, flags, seq, payload) {
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  const buf = Buffer.alloc(4 + payloadBuf.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt8(flags, 1);
  buf.writeUInt16BE(seq & 0xffff, 2);
  payloadBuf.copy(buf, 4);
  return buf;
}

function makeStateFrame(seq, state) {
  return makeFrame(FRAME.STATE_CHANGE, 0, seq, Buffer.from(state, "utf-8"));
}

function makeTranscriptFrame(type, seq, text) {
  return makeFrame(type, 0, seq, Buffer.from(text, "utf-8"));
}

function makeJsonFrame(type, seq, value) {
  return makeFrame(type, 0, seq, Buffer.from(JSON.stringify(value ?? {}), "utf-8"));
}

export function pcm16Rms(pcmBuffer) {
  const buf = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
  const samples = Math.floor(buf.length / 2);
  if (!samples) return 0;
  let sumSq = 0;
  for (let offset = 0; offset + 1 < buf.length; offset += 2) {
    const s = buf.readInt16LE(offset) / 32768;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples);
}

function normalizeVadConfig(config = {}) {
  return {
    ...DEFAULT_VAD_CONFIG,
    ...config,
    enabled: config.enabled !== false,
  };
}

export function pcm16ToWav(pcmBuffer, { sampleRate = PCM_SAMPLE_RATE, channels = 1 } = {}) {
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function extractPcm16FromWav(audioBuffer) {
  return decodePcm16Audio(audioBuffer).pcm;
}

export function decodePcm16Audio(audioBuffer) {
  const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer || []);
  if (buf.length < 12 || buf.subarray(0, 4).toString("ascii") !== "RIFF" || buf.subarray(8, 12).toString("ascii") !== "WAVE") {
    return { pcm: buf, sampleRate: PCM_SAMPLE_RATE, channels: 1, bitsPerSample: 16 };
  }
  let sampleRate = PCM_SAMPLE_RATE;
  let channels = 1;
  let bitsPerSample = 16;
  let pcm = Buffer.alloc(0);
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = Math.min(dataStart + chunkSize, buf.length);
    if (chunkId === "fmt " && chunkSize >= 16) {
      channels = Math.max(1, buf.readUInt16LE(dataStart + 2));
      sampleRate = buf.readUInt32LE(dataStart + 4) || PCM_SAMPLE_RATE;
      bitsPerSample = buf.readUInt16LE(dataStart + 14) || 16;
    } else if (chunkId === "data") {
      pcm = buf.subarray(dataStart, dataEnd);
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  return { pcm: pcm.length ? pcm : buf, sampleRate, channels, bitsPerSample };
}

function downmixPcm16ToMono(pcmBuffer, channels = 1) {
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
  if (channels <= 1) return pcm;
  const frames = Math.floor(pcm.length / 2 / channels);
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      sum += pcm.readInt16LE((i * channels + ch) * 2);
    }
    mono.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / channels))), i * 2);
  }
  return mono;
}

function resamplePcm16Mono(pcmBuffer, fromRate, toRate = PCM_SAMPLE_RATE) {
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
  if (!pcm.length || !fromRate || fromRate === toRate) return pcm;
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.max(1, Math.round(inSamples * toRate / fromRate));
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i += 1) {
    const src = i * fromRate / toRate;
    const i0 = Math.min(inSamples - 1, Math.floor(src));
    const i1 = Math.min(inSamples - 1, i0 + 1);
    const t = src - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * t))), i * 2);
  }
  return out;
}

export function normalizeTtsAudioToPcm16Mono16k(audioBuffer) {
  const decoded = decodePcm16Audio(audioBuffer);
  if (decoded.bitsPerSample !== 16) {
    throw new Error(`unsupported TTS WAV bit depth: ${decoded.bitsPerSample}`);
  }
  const mono = downmixPcm16ToMono(decoded.pcm, decoded.channels);
  return resamplePcm16Mono(mono, decoded.sampleRate, PCM_SAMPLE_RATE);
}

/**
 * DS V4 Pro 反馈 #2 落地:emotion 只跑 4s 短段 = 开头 1s + 结尾 3s
 * 原因:整段喂 emotion2vec+ 时,长音频(>10s)会让 top1 偏 neutral,
 *      且 P99 从 < 100ms 拉到 > 300ms,失去"当前轮注入"时间窗口。
 *
 * 入参:16kHz mono WAV buffer(pcm16ToWav 产物)
 * 出参:同格式 WAV buffer,长度 ≤ 4s;如果原长 ≤ 4s 原样返回
 */
export function extractEmotionSegment(wavBuffer, {
  headSeconds = 1,
  tailSeconds = 3,
} = {}) {
  const targetSeconds = headSeconds + tailSeconds;
  const decoded = decodePcm16Audio(wavBuffer);
  const sampleRate = decoded.sampleRate || PCM_SAMPLE_RATE;
  const bytesPerSecond = sampleRate * 2; // Int16 mono
  const totalSeconds = decoded.pcm.length / bytesPerSecond;
  if (totalSeconds <= targetSeconds) {
    return wavBuffer; // 短段直接原样给,emotion server 也能 handle
  }
  const headBytes = Math.min(decoded.pcm.length, headSeconds * bytesPerSecond);
  const tailBytes = Math.min(decoded.pcm.length - headBytes, tailSeconds * bytesPerSecond);
  const head = decoded.pcm.subarray(0, headBytes);
  const tail = decoded.pcm.subarray(decoded.pcm.length - tailBytes);
  const merged = Buffer.concat([head, tail]);
  return pcm16ToWav(merged, { sampleRate });
}

export function cleanTextForTts(text) {
  return stripEmojiForTts(String(text || "")
    .replace(/```[\s\S]*?```/g, "代码块略过。")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)、]\s+/gm, "")
    .replace(/\n{2,}/g, "。")
    .replace(/\s+/g, " ")
    .trim());
}

function splitSegmentByLength(text, maxChars = TTS_MAX_SEGMENT_CHARS) {
  const value = String(text || "").trim();
  if (!value) return [];
  const out = [];
  let remaining = value;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    let splitAt = -1;
    for (const sep of ["，", ",", "、", "：", ":", " "]) {
      const pos = window.lastIndexOf(sep);
      if (pos >= Math.floor(maxChars * 0.45)) {
        splitAt = pos + 1;
        break;
      }
    }
    if (splitAt <= 0) splitAt = maxChars;
    out.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) out.push(remaining);
  return out.filter(Boolean);
}

export function splitTextForTts(text, { maxChars = TTS_MAX_SEGMENT_CHARS } = {}) {
  const value = cleanTextForTts(text);
  if (!value) return [];
  const parts = value.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [value];
  const out = [];
  for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
    if (part.length <= maxChars) {
      out.push(part);
      continue;
    }
    out.push(...splitSegmentByLength(part, maxChars));
  }
  return out;
}

function chunkBuffer(buf, chunkBytes = PCM_TTS_CHUNK_BYTES) {
  const chunks = [];
  for (let i = 0; i < buf.length; i += chunkBytes) {
    chunks.push(buf.subarray(i, Math.min(i + chunkBytes, buf.length)));
  }
  return chunks;
}

function normalizeProviderHealth(provider, value) {
  const name = provider?.name || "unknown";
  if (value === undefined || value === null) return { name, ok: true, fallbackOk: false, degraded: false };
  if (typeof value === "boolean") return { name, ok: value, fallbackOk: false, degraded: !value };
  if (typeof value === "object") {
    const ok = "ok" in value ? !!value.ok : !!value;
    const fallbackOk = !!value.fallbackOk;
    return {
      name,
      ok,
      fallbackOk,
      degraded: !!value.degraded || (!ok && fallbackOk),
      error: typeof value.error === "string" ? value.error : undefined,
    };
  }
  return { name, ok: !!value, fallbackOk: false, degraded: !value };
}

async function providerHealthStatus(provider) {
  if (!provider || typeof provider.health !== "function") {
    return normalizeProviderHealth(provider, true);
  }
  try {
    return normalizeProviderHealth(provider, await provider.health());
  } catch (err) {
    return {
      name: provider?.name || "unknown",
      ok: false,
      fallbackOk: false,
      degraded: true,
      error: err?.message || String(err),
    };
  }
}

function buildVoicePrompt(transcript, emotion = null) {
  const emotionHint = emotion?.tag ? EMOTION_LLM_HINT[emotion.tag] : null;
  return [
    "你正在用语音和用户对话。请用自然、简短、口语化的中文回答。",
    "除非用户明确要求,不要输出长列表。需要工具时可以正常使用 Lynn 的工具能力。",
    emotionHint ? `用户当前语气提示:${emotionHint}` : "",
    "",
    `用户刚才说:${transcript}`,
  ].filter(Boolean).join("\n");
}

export function resolveVoiceRuntimeAsrConfig(config = {}) {
  const provider = String(config.provider || "").trim();
  if (!provider || provider === "sensevoice") {
    return {
      ...config,
      provider: "qwen3-asr",
      fallback_provider: config.fallback_provider || config.fallbackProvider || "sensevoice",
    };
  }
  return config;
}

/**
 * DS V4 Pro 反馈 #3 落地:判定 transcript 是否"有意义"
 * 用于 interrupted T2 阶段:如果打断后用户只发出咳嗽/笑声/拟声词,
 * 则回滚 interrupt,不污染对话历史。
 */
export function isSemanticTranscript(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (value.length < 2) return false;
  // 过滤:仅由拟声词/笑声/语气助词构成的转写
  const nonSemantic = /^[\s]*((嗯|啊|哦|哈|喂|呃|嗨|咳|hm|uh|ah|oh|huh|haha|mhm)[\s,，。.!?！？]*)+$/i;
  if (nonSemantic.test(value)) return false;
  return true;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeVoiceTranscript(text) {
  let value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  value = value.replace(/^(?:嗯|呃|啊|那个|就是)[，,。.\s]*/g, "");
  const spokenRestartMarkers = [
    "我要查的是",
    "我想查的是",
    "我要问的是",
    "我想问的是",
    "我问的是",
    "我查的是",
    "要查的是",
    "想查的是",
    "查的是",
    "问的是",
  ];
  for (const marker of spokenRestartMarkers) {
    const escaped = escapeRegExp(marker);
    value = value.replace(new RegExp(`${escaped}[\\u4e00-\\u9fa5]{0,2}${escaped}`, "g"), marker);
  }
  return value.trim();
}

async function defaultBrainRunner({ transcript, emotion, engine, signal }) {
  if (typeof engine?.executeIsolated === "function") {
    const result = await engine.executeIsolated(buildVoicePrompt(transcript, emotion), { signal });
    if (result?.error) throw new Error(result.error);
    return result?.replyText || "";
  }
  if (typeof engine?.voiceReply === "function") {
    return await engine.voiceReply(transcript, { signal });
  }
  return "";
}

async function waitForCurrentTurnEmotion(emotionPromise, timeoutMs = EMOTION_CURRENT_TURN_WAIT_MS) {
  if (!emotionPromise) return null;
  let timer = null;
  try {
    return await Promise.race([
      emotionPromise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Voice session — 单条 WS 连接的状态封装
 */
class VoiceSession {
  constructor(ws, { engine, hub, asrProvider, serProvider, ttsProvider, brainRunner, healthOnOpen = true, vadConfig = {}, mode = "direct", saveInterruptedTurn = null }) {
    this.ws = ws;
    this.engine = engine;
    this.hub = hub;
    this.asrProvider = asrProvider || createASRFallbackProvider(resolveVoiceRuntimeAsrConfig(engine?.config?.voice?.asr || {}));
    this.serProvider = serProvider || createSERProvider(engine?.config?.voice?.ser || {});
    this.ttsProvider = ttsProvider || createTTSFallbackProvider(engine?.config?.voice?.tts || {});
    this.brainRunner = brainRunner || defaultBrainRunner;
    this.saveInterruptedTurn = saveInterruptedTurn; // DS 反馈 #3 T2 阶段的可注入钩子
    this.mode = mode === "chat" ? "chat" : "direct";
    this.healthOnOpen = healthOnOpen;
    this.state = STATE.IDLE;
    this.outSeq = 0;
    this.lastInSeq = -1;
    this.utteranceBuffer = []; // 累积当前 utterance 的 PCM (Int16Array[])
    this.totalBufferedSamples = 0;
    this.maxBufferedSamples = 16000 * 30; // 30s 上限
    this.transcriptPartial = "";
    this.startTs = Date.now();
    this.pcmFramesIn = 0;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.processingTurn = null;
    this.turnAbort = null;
    this.turnGeneration = 0;
    // DS V4 Pro 反馈 #3 — 打断 T1/T2 状态机:
    //   T1 (onInterrupt):截断 TTS/Brain,把已播放 segments 暂存到 pendingInterruptedReply
    //   T2 (processTurn 内 ASR final 后):
    //     有意义 transcript  → 保存已播放部分到历史 interrupted: true
    //     咳嗽/拟声/笑声     → 回滚,pendingInterruptedReply 直接丢弃(不污染上下文)
    this.pendingInterruptedReply = null;
    this.currentReplyPlayed = null; // 当前 TTS 正在播放的已完成 segments 文本
    this.vadConfig = normalizeVadConfig(vadConfig);
    this.vadSpeechFrames = 0;
    this.vadSilenceFrames = 0;
    this.vadArmed = false;

    // ERLE debug 双轨录制(Phase 2 Spike 5 用):
    //   设 LYNN_ERLE_RECORD_DIR=/path/to/dir 即启用
    //   session 结束(或 onClose)时产出 <session-id>-mic.wav + <session-id>-tts.wav
    //   时间对齐:同一 AudioContext 时序,不需额外 sync
    const erleDir = process.env.LYNN_ERLE_RECORD_DIR;
    this.erleRecord = erleDir ? {
      dir: erleDir,
      sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      micChunks: [], // Buffer[]
      ttsChunks: [], // Buffer[]
      startTs: Date.now(),
    } : null;
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.send(makeStateFrame(this.outSeq++, state));
    debugLog()?.log("voice-ws", `state → ${state}`);
  }

  send(buf) {
    if (this.ws.readyState !== 1) return;
    this.ws.send(buf);
    this.bytesOut += buf.length;
  }

  async checkHealth() {
    const [asr, ser, tts] = await Promise.all([
      providerHealthStatus(this.asrProvider),
      providerHealthStatus(this.serProvider),
      providerHealthStatus(this.ttsProvider),
    ]);
    // SER is an optional side chain: emotion failure must not block the voice
    // turn or make Lynn look degraded when ASR/TTS are healthy.
    const ok = asr.ok && tts.ok;
    const rawHealth = {
      ok,
      degraded: !ok || asr.degraded || tts.degraded,
      providers: { asr, ser, tts },
    };
    // DS V4 Pro 反馈 #5 · Phase 2.5 降级编排:附加 tier + Orb 颜色 + 文案
    const health = enrichHealthWithTier(rawHealth);
    this.send(makeJsonFrame(FRAME.HEALTH_STATUS, this.outSeq++, health));
    if (!ok) {
      // Health probes can race with an active turn. In particular, CosyVoice
      // may be busy synthesizing while the on-open health check is still
      // pending; don't let that late probe visually interrupt a valid
      // speaking/thinking state. The explicit HEALTH_STATUS frame still carries
      // the degraded detail for diagnostics.
      if (![STATE.SPEAKING, STATE.THINKING].includes(this.state)) {
        this.setState(STATE.DEGRADED);
      }
      debugLog()?.warn("voice-ws", `provider health degraded · tier=${health.tier} asr=${asr.ok}/${asr.fallbackOk} ser=${ser.ok}/${ser.fallbackOk} tts=${tts.ok}/${tts.fallbackOk}`);
    }
    return ok;
  }

  onOpen() {
    if (this.healthOnOpen) {
      void this.checkHealth();
      void this.serProvider?.warmup?.();
    }
  }

  async onAudio(frame) {
    // 计 seq 顺序
    const expectedSeq = (this.lastInSeq + 1) & 0xffff;
    if (this.lastInSeq !== -1 && frame.seq !== expectedSeq) {
      debugLog()?.log("voice-ws", `seq out of order: expected ${expectedSeq}, got ${frame.seq}`);
    }
    this.lastInSeq = frame.seq;
    this.pcmFramesIn++;
    this.bytesIn += frame.payload.length;

    // Phase 2B:client-side Silero/TEN 未接入前,server 侧先做保守 energy VAD 兜底。
    if (this.state === STATE.IDLE || this.state === STATE.DEGRADED) {
      this.setState(STATE.LISTENING);
    }

    // Buffer 累积
    if (this.totalBufferedSamples < this.maxBufferedSamples) {
      this.utteranceBuffer.push(frame.payload);
      this.totalBufferedSamples += frame.payload.length / 2; // Int16 = 2 bytes/sample
    } else {
      // 30s 上限,强制 EOT
      void this.endOfTurn();
      return;
    }

    // ERLE 双轨:mic 入侧即录(无论是否进 VAD 判决)
    if (this.erleRecord) {
      this.erleRecord.micChunks.push(Buffer.from(frame.payload));
    }

    this.updateEnergyVad(frame.payload);
  }

  updateEnergyVad(pcmPayload) {
    const cfg = this.vadConfig;
    if (!cfg.enabled || this.processingTurn || this.state !== STATE.LISTENING) return;

    const rms = pcm16Rms(pcmPayload);
    if (rms >= cfg.speechRms) {
      this.vadSpeechFrames += 1;
      this.vadSilenceFrames = 0;
      if (this.vadSpeechFrames >= cfg.minSpeechFrames) {
        this.vadArmed = true;
      }
      return;
    }

    if (!this.vadArmed) return;
    if (rms <= cfg.silenceRms) {
      this.vadSilenceFrames += 1;
    } else {
      this.vadSilenceFrames = 0;
    }

    if (this.vadSilenceFrames >= cfg.endSilenceFrames) {
      debugLog()?.log("voice-ws", `energy VAD auto end-of-turn rms=${rms.toFixed(4)}`);
      void this.endOfTurn();
    }
  }

  async endOfTurn() {
    if (this.processingTurn) return this.processingTurn;
    if (this.state === STATE.IDLE) return;
    if (this.utteranceBuffer.length === 0) {
      this.setState(STATE.IDLE);
      return;
    }

    const combinedPcm = Buffer.concat(this.utteranceBuffer);
    const wavAudio = pcm16ToWav(combinedPcm);
    this.utteranceBuffer = [];
    this.totalBufferedSamples = 0;
    this.resetVad();

    const generation = ++this.turnGeneration;
    this.processingTurn = this.processTurn(wavAudio)
      .catch((err) => {
        if (this.isStaleTurn(generation) || this.isIntentionalAbort(err)) {
          debugLog()?.log("voice-ws", `turn aborted: ${err?.message || err || "stale turn"}`);
          return;
        }
        debugLog()?.error("voice-ws", `turn failed: ${err?.message || err}`);
        this.send(makeTranscriptFrame(FRAME.TRANSCRIPT_FINAL, this.outSeq++, ""));
        this.setState(STATE.DEGRADED);
      })
      .finally(() => {
        if (!this.isStaleTurn(generation)) {
          this.turnAbort = null;
          this.processingTurn = null;
        }
      });
    return this.processingTurn;
  }

  async processTurn(wavAudio) {
    this.turnAbort = new AbortController();
    const signal = this.turnAbort.signal;

    await this.checkHealth();
    if (signal?.aborted) return;

    this.setState(STATE.THINKING);

    // 方案 C 微交互(2026-05-01 决策):因为 final ASR 需要整段等收敛(~0.8-1.2s),
    // 用户会感到"说完一拍停顿"。立刻推一个 PARTIAL "理解中…" 让 Overlay 能显,
    // 这是零成本心理补偿。Overlay 看到 partial 会显示为灰色占位,收到 final 时替换。
    this.send(makeTranscriptFrame(FRAME.TRANSCRIPT_PARTIAL, this.outSeq++, "理解中…"));

    const emotionPromise = this.serProvider?.classify
      ? this.serProvider.classify(extractEmotionSegment(wavAudio), { filename: "voice.wav" })
        .then((emotion) => {
          if (!signal.aborted) this.send(makeJsonFrame(FRAME.EMOTION, this.outSeq++, emotion));
          return emotion;
        })
        .catch((err) => {
          debugLog()?.warn("voice-ws", `emotion classify failed: ${err?.message || err}`);
          return null;
        })
      : Promise.resolve(null);

    const asrResult = await this.asrProvider.transcribe(wavAudio, { language: "zh", filename: "voice.wav" });
    if (signal.aborted) return;
    if (asrResult?.fallbackUsed) {
      this.setState(STATE.DEGRADED);
      debugLog()?.warn("voice-ws", `asr fallback used: ${asrResult.primaryError || "primary failed"}`);
    }
    const transcript = normalizeVoiceTranscript(asrResult?.text);
    this.send(makeTranscriptFrame(FRAME.TRANSCRIPT_FINAL, this.outSeq++, transcript));

    // DS V4 Pro 反馈 #3 · T2 阶段:根据 transcript 语义决定被打断 AI 回复的归宿
    await this.resolveInterruptedReply(transcript);

    if (this.mode === "chat") {
      this.setState(STATE.IDLE);
      return;
    }
    const currentTurnEmotion = await waitForCurrentTurnEmotion(emotionPromise);

    await this.respondToTranscript(transcript, { emotion: currentTurnEmotion, signal });
  }

  /**
   * T2 阶段核心:
   *   pendingInterruptedReply 存在 →
   *     transcript 有意义       → 保存(interrupted: true)到对话历史
   *     transcript 咳嗽/无意义  → 回滚丢弃,不污染上下文
   *   pendingInterruptedReply 不存在 → no-op
   */
  async resolveInterruptedReply(transcript) {
    const pending = this.pendingInterruptedReply;
    if (!pending) return;
    this.pendingInterruptedReply = null;
    if (!isSemanticTranscript(transcript)) {
      debugLog()?.log("voice-ws", `T2 rollback: interrupted reply discarded (non-semantic transcript: ${JSON.stringify(transcript)})`);
      return;
    }
    if (typeof this.saveInterruptedTurn !== "function") {
      // engine 未注入钩子不是致命错误,只记日志
      debugLog()?.log("voice-ws", `T2 pending: saveInterruptedTurn hook absent, reply not persisted (text len=${pending.text.length})`);
      return;
    }
    try {
      await this.saveInterruptedTurn({
        text: pending.text,
        interrupted: true,
        segmentsPlayed: pending.segmentsPlayed,
        totalSegments: pending.totalSegments,
        startedAt: pending.startedAt,
        interruptedAt: pending.interruptedAt,
        engine: this.engine,
      });
      debugLog()?.log("voice-ws", `T2 saved: interrupted reply persisted (played ${pending.segmentsPlayed}/${pending.totalSegments})`);
    } catch (err) {
      debugLog()?.warn("voice-ws", `T2 save failed: ${err?.message || err}`);
    }
  }

  async processTextTurn(text) {
    if (this.processingTurn) return this.processingTurn;
    const transcript = normalizeVoiceTranscript(text);
    if (!transcript) {
      this.setState(STATE.IDLE);
      return;
    }
    const generation = ++this.turnGeneration;
    this.processingTurn = this.processDirectTranscript(transcript)
      .catch((err) => {
        if (this.isStaleTurn(generation) || this.isIntentionalAbort(err)) {
          debugLog()?.log("voice-ws", `text turn aborted: ${err?.message || err || "stale turn"}`);
          return;
        }
        debugLog()?.error("voice-ws", `text turn failed: ${err?.message || err}`);
        this.setState(STATE.DEGRADED);
      })
      .finally(() => {
        if (!this.isStaleTurn(generation)) {
          this.turnAbort = null;
          this.processingTurn = null;
        }
      });
    return this.processingTurn;
  }

  async processDirectTranscript(transcript) {
    this.turnAbort = new AbortController();
    const signal = this.turnAbort.signal;
    await this.checkHealth();
    if (signal.aborted) return;
    this.setState(STATE.THINKING);
    this.send(makeTranscriptFrame(FRAME.TRANSCRIPT_FINAL, this.outSeq++, transcript));
    if (this.mode === "chat") {
      this.setState(STATE.IDLE);
      return;
    }
    await this.respondToTranscript(transcript, { emotion: null, signal });
  }

  async processSpeakTextTurn(text) {
    if (this.processingTurn) return this.processingTurn;
    const value = String(text || "").trim();
    if (!value) {
      this.setState(STATE.IDLE);
      return;
    }
    const generation = ++this.turnGeneration;
    this.turnAbort = new AbortController();
    const signal = this.turnAbort.signal;
    this.processingTurn = this.speakText(value, { signal, emitAssistantReply: true })
      .catch((err) => {
        if (this.isStaleTurn(generation) || this.isIntentionalAbort(err)) {
          debugLog()?.log("voice-ws", `speak text aborted: ${err?.message || err || "stale turn"}`);
          return;
        }
        debugLog()?.error("voice-ws", `speak text failed: ${err?.message || err}`);
        this.setState(STATE.DEGRADED);
      })
      .finally(() => {
        if (!this.isStaleTurn(generation)) {
          this.turnAbort = null;
          this.processingTurn = null;
        }
      });
    return this.processingTurn;
  }

  async respondToTranscript(transcript, { emotion = null, signal } = {}) {
    if (!transcript) {
      this.setState(STATE.IDLE);
      return;
    }
    const replyText = String(await this.brainRunner({
      transcript,
      emotion,
      engine: this.engine,
      hub: this.hub,
      signal,
    }) || "").trim();
    if (signal.aborted) return;
    const segments = splitTextForTts(replyText);
    if (segments.length === 0) {
      this.setState(STATE.IDLE);
      return;
    }
    await this.speakText(replyText, { signal, emitAssistantReply: true });
  }

  async speakText(text, { signal = null, emitAssistantReply = true } = {}) {
    const replyText = String(text || "").trim();
    if (!replyText) {
      this.setState(STATE.IDLE);
      return;
    }
    const segments = splitTextForTts(replyText);
    if (segments.length === 0) {
      this.setState(STATE.IDLE);
      return;
    }
    if (emitAssistantReply) this.send(makeTranscriptFrame(FRAME.ASSISTANT_REPLY, this.outSeq++, replyText));
    this.setState(STATE.SPEAKING);
    // DS 反馈 #3 · 追踪已播放进度,onInterrupt T1 时快照
    this.currentReplyPlayed = {
      fullText: replyText,
      segments,
      playedSegments: [],
      startedAt: Date.now(),
    };
    const queue = [...segments];
    for (let i = 0; i < queue.length; i += 1) {
      if (signal?.aborted) break;
      const segment = queue[i];
      let speech;
      try {
        speech = await this.ttsProvider.synthesize(segment, {
          speed: 1.0,
          signal,
          timeoutMs: TTS_SEGMENT_TIMEOUT_MS,
        });
      } catch (err) {
        const smallerMax = Math.max(TTS_RETRY_MIN_SEGMENT_CHARS, Math.ceil(segment.length / 2));
        const smaller = segment.length > TTS_RETRY_MIN_SEGMENT_CHARS
          ? splitTextForTts(segment, { maxChars: smallerMax }).filter((s) => s && s !== segment)
          : [];
        if (smaller.length > 1) {
          debugLog()?.warn("voice-ws", `tts segment failed, retrying as ${smaller.length} smaller chunks: ${err?.message || err}`);
          queue.splice(i, 1, ...smaller);
          i -= 1;
          continue;
        }
        throw err;
      }
      if (speech?.fallbackUsed) {
        this.setState(STATE.DEGRADED);
        debugLog()?.warn("voice-ws", `tts fallback used: ${speech.primaryError || "primary failed"}`);
      }
      const audio = speech?.audio || speech?.audioBuffer || speech?.buffer
        || (speech?.path ? fs.readFileSync(speech.path) : null);
      const pcm = normalizeTtsAudioToPcm16Mono16k(audio);
      for (const chunk of chunkBuffer(pcm)) {
        if (signal?.aborted) break;
        this.send(makeFrame(FRAME.PCM_TTS, 0, this.outSeq++, chunk));
        // ERLE 双轨:TTS 推客户端的同一帧也写进磁盘侧的 tts.wav
        if (this.erleRecord) {
          this.erleRecord.ttsChunks.push(Buffer.from(chunk));
        }
      }
      // 推完此 segment 的全部 PCM 且未被打断 → 标记已完整播放
      if (!signal?.aborted) {
        this.currentReplyPlayed.playedSegments.push(segment);
      }
    }
    if (!signal?.aborted) {
      // 正常播完 → 清空跟踪,不触发 T2
      this.currentReplyPlayed = null;
      this.setState(STATE.IDLE);
    }
  }

  onPing(frame) {
    // 原 payload 直接回(含 client_send_ts,client 计算 RTT)
    this.send(makeFrame(FRAME.PONG, 0, frame.seq, frame.payload));
  }

  /**
   * DS V4 Pro 反馈 #3 · T1 阶段(VAD 检测到用户开口):
   *   仅执行截断 + 快照已播放部分到 pendingInterruptedReply
   *   不写对话历史 — 等 ASR final 后由 resolveInterruptedReply 决策
   */
  onInterrupt() {
    if (this.state === STATE.SPEAKING || this.state === STATE.THINKING) {
      // 快照已播放 segments(仅 SPEAKING 态有意义;THINKING 态 currentReplyPlayed=null)
      if (this.currentReplyPlayed && Array.isArray(this.currentReplyPlayed.playedSegments) && this.currentReplyPlayed.playedSegments.length > 0) {
        const played = this.currentReplyPlayed;
        this.pendingInterruptedReply = {
          text: played.playedSegments.join(""),
          segmentsPlayed: played.playedSegments.length,
          totalSegments: Array.isArray(played.segments) ? played.segments.length : played.playedSegments.length,
          startedAt: played.startedAt,
          interruptedAt: Date.now(),
        };
        debugLog()?.log("voice-ws", `T1 snapshot: interrupted at ${played.playedSegments.length}/${Array.isArray(played.segments) ? played.segments.length : "?"} segments`);
      }
      this.currentReplyPlayed = null;
      this.turnGeneration += 1;
      this.turnAbort?.abort();
      this.turnAbort = null;
      this.processingTurn = null;
      this.utteranceBuffer = [];
      this.totalBufferedSamples = 0;
      this.resetVad();
      debugLog()?.log("voice-ws", "interrupt received");
      this.setState(STATE.LISTENING);
    }
  }

  isStaleTurn(generation) {
    return generation !== this.turnGeneration;
  }

  isIntentionalAbort(err) {
    return err?.name === "AbortError";
  }

  resetVad() {
    this.vadSpeechFrames = 0;
    this.vadSilenceFrames = 0;
    this.vadArmed = false;
  }

  onClose() {
    const elapsed = (Date.now() - this.startTs) / 1000;
    debugLog()?.log("voice-ws",
      `session closed after ${elapsed.toFixed(1)}s, ` +
      `pcm_frames_in=${this.pcmFramesIn} bytes_in/out=${this.bytesIn}/${this.bytesOut}`,
    );
    // ERLE 双轨:session 结束落盘 mic.wav + tts.wav
    if (this.erleRecord) {
      try {
        if (!fs.existsSync(this.erleRecord.dir)) {
          fs.mkdirSync(this.erleRecord.dir, { recursive: true });
        }
        const micPath = `${this.erleRecord.dir}/${this.erleRecord.sessionId}-mic.wav`;
        const ttsPath = `${this.erleRecord.dir}/${this.erleRecord.sessionId}-tts.wav`;
        const micPcm = Buffer.concat(this.erleRecord.micChunks);
        const ttsPcm = Buffer.concat(this.erleRecord.ttsChunks);
        if (micPcm.length) fs.writeFileSync(micPath, pcm16ToWav(micPcm));
        if (ttsPcm.length) fs.writeFileSync(ttsPath, pcm16ToWav(ttsPcm));
        debugLog()?.log("voice-ws",
          `ERLE recorded: mic ${(micPcm.length / 32000).toFixed(1)}s → ${micPath}, ` +
          `tts ${(ttsPcm.length / 32000).toFixed(1)}s → ${ttsPath}`,
        );
      } catch (err) {
        debugLog()?.warn("voice-ws", `ERLE record write failed: ${err?.message || err}`);
      }
    }
  }
}

/**
 * 创建 Voice WS 路由
 *
 * @param {object} engine - Lynn engine 实例
 * @param {object} hub - WebSocket hub
 * @param {object} ctx - { upgradeWebSocket, asrProvider?, serProvider?, ttsProvider?, brainRunner? }
 * @returns {{wsRoute: Hono}}
 */
export function createVoiceWsRoute(engine, hub, { upgradeWebSocket, ...deps }) {
  const wsRoute = new Hono();

  wsRoute.get("/voice-ws", upgradeWebSocket((_c) => {
    let session = null;
    const mode = _c?.req?.query?.("mode") || deps.mode || "direct";

    return {
      onOpen(_event, ws) {
        session = new VoiceSession(ws, { engine, hub, ...deps, mode });
        session.onOpen();
        debugLog()?.log("voice-ws", "client connected");
      },

      onMessage(event, _ws) {
        if (!session) return;

        // 二进制帧
        if (event.data instanceof ArrayBuffer || Buffer.isBuffer(event.data)) {
          const frame = parseFrame(event.data);
          if (!frame) return;

          switch (frame.type) {
            case FRAME.PCM_AUDIO:
              session.onAudio(frame);
              break;
            case FRAME.PING:
              session.onPing(frame);
              break;
            case FRAME.INTERRUPT:
              session.onInterrupt();
              break;
            case FRAME.END_OF_TURN:
              session.endOfTurn();
              break;
            case FRAME.TEXT_TURN:
              session.processTextTurn(frame.payload.toString("utf-8"));
              break;
            case FRAME.SPEAK_TEXT:
              session.processSpeakTextTurn(frame.payload.toString("utf-8"));
              break;
            default:
              debugLog()?.log("voice-ws", `unknown frame type: 0x${frame.type.toString(16)}`);
          }
          return;
        }

        // 文本帧(future:用于 client → server 控制消息)
        debugLog()?.log("voice-ws", `text frame: ${String(event.data).slice(0, 100)}`);
      },

      onClose() {
        if (session) {
          session.onClose();
          session = null;
        }
      },

      onError(event) {
        debugLog()?.log("voice-ws", `error: ${event?.message || event}`);
      },
    };
  }));

  return { wsRoute };
}
