/**
 * CosyVoice 2 TTS client for Lynn V0.79 Jarvis Runtime.
 *
 * This path returns audio bytes directly for Voice WS, unlike the plugin tool
 * that writes generated speech to desk files.
 */

import { normalizeChineseTtsText } from "../../../shared/tts-text-normalizer.js";

const DEFAULT_TTS_URL = process.env.LYNN_COSYVOICE_URL || "http://localhost:18021";
const DEFAULT_TIMEOUT_MS = 45000;

function requestSignal(parentSignal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const timeout = Number(timeoutMs || DEFAULT_TIMEOUT_MS);
  if (parentSignal?.aborted) return { signal: parentSignal, cleanup: () => {} };
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  let timer = null;
  if (parentSignal) parentSignal.addEventListener("abort", abort, { once: true });
  if (Number.isFinite(timeout) && timeout > 0) {
    timer = setTimeout(() => controller.abort(new Error(`cosyvoice2 synthesize timed out after ${timeout}ms`)), timeout);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener("abort", abort);
    },
  };
}

export function createCosyVoice2TtsProvider(config = {}) {
  const baseUrl = String(config.base_url || config.baseUrl || DEFAULT_TTS_URL).replace(/\/+$/, "");
  const defaultVoice = config.default_voice || config.voice || "中文女";

  return {
    name: "cosyvoice2",
    label: "CosyVoice 2 (V0.79 Jarvis Runtime TTS)",

    async synthesize(text, { voice = defaultVoice, speed = 1.0, signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      const input = normalizeChineseTtsText(text);
      if (!input) throw new Error("cosyvoice2: empty text");

      const req = requestSignal(signal, timeoutMs);
      let res;
      try {
        res = await fetch(`${baseUrl}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: req.signal,
          body: JSON.stringify({
            model: "cosyvoice2",
            input,
            voice: voice || defaultVoice,
            response_format: "wav",
            speed: Number(speed || 1.0),
          }),
        });
      } finally {
        req.cleanup();
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`cosyvoice2 synthesize failed: HTTP ${res.status} ${errText.slice(0, 120)}`);
      }
      return {
        ok: true,
        provider: "cosyvoice2",
        mimeType: res.headers.get("content-type") || "audio/wav",
        audio: Buffer.from(await res.arrayBuffer()),
      };
    },

    /**
     * 2026-05-01 P0-② — CosyVoice 2 流式合成。
     *
     * DGX 侧 /v1/audio/speech/stream 走 inference_sft(stream=True),每次 yield
     * 一个独立完整 WAV 块(token_hop_len=25 控制粒度),首块 ~150-300ms 出。
     * 我们这边按 RIFF header 边界把 chunked transfer 重组成多个 WAV buffer,
     * 每个作为 AsyncIterable 的一个 element 吐出。
     *
     * 调用方(voice-ws speakText)收到第一段 WAV 立刻解码 + chunk + send PCM_TTS,
     * 而不等整段渲染完。首音节延迟从 ~400-1200ms 砍到 ~200-300ms。
     *
     * 协议契约(2026-05-01 实证 DGX cosyvoice_server.py:133-143):
     *   - 每个 yield 是独立合法 WAV(soundfile.write 整段 buffer)
     *   - 多块串接,通过 RIFF header `"RIFF" + size_le32 + "WAVE"` 切分
     *
     * yields:{ audio: Buffer, mimeType: 'audio/wav' } per WAV chunk
     */
    async *synthesizeStream(text, { voice = defaultVoice, speed = 1.0, signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      const input = normalizeChineseTtsText(text);
      if (!input) throw new Error("cosyvoice2: empty text");

      const req = requestSignal(signal, timeoutMs);
      let res;
      try {
        res = await fetch(`${baseUrl}/v1/audio/speech/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: req.signal,
          body: JSON.stringify({
            model: "cosyvoice2",
            input,
            voice: voice || defaultVoice,
            response_format: "wav",
            speed: Number(speed || 1.0),
          }),
        });
      } catch (err) {
        req.cleanup();
        throw err;
      }
      if (!res.ok) {
        req.cleanup();
        const errText = await res.text().catch(() => "");
        throw new Error(`cosyvoice2 synthesizeStream failed: HTTP ${res.status} ${errText.slice(0, 120)}`);
      }
      if (!res.body) {
        req.cleanup();
        throw new Error("cosyvoice2 synthesizeStream: empty response body");
      }

      const reader = res.body.getReader();
      let buffer = Buffer.alloc(0);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (value && value.byteLength) {
            buffer = Buffer.concat([buffer, Buffer.from(value)]);
          }
          // 从 buffer 里切出所有完整 WAV(RIFF size_le32 标记总字节)
          while (true) {
            if (buffer.length < 12) break;
            if (buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WAVE") {
              throw new Error("cosyvoice2 synthesizeStream: corrupt RIFF stream");
            }
            const wavSize = buffer.readUInt32LE(4) + 8; // RIFF chunk + 8-byte header
            if (buffer.length < wavSize) break;
            const wavBuf = buffer.subarray(0, wavSize);
            buffer = buffer.subarray(wavSize);
            yield { audio: Buffer.from(wavBuf), mimeType: "audio/wav", provider: "cosyvoice2" };
          }
          if (done) break;
        }
        if (buffer.length > 0) {
          throw new Error(`cosyvoice2 synthesizeStream: trailing ${buffer.length} bytes outside RIFF boundary`);
        }
      } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
        req.cleanup();
      }
    },

    async health() {
      try {
        const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
      } catch {
        return false;
      }
    },
  };
}
