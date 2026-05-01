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
