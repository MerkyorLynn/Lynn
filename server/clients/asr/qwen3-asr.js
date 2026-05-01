/**
 * Qwen3-ASR-0.6B Provider · Lynn V0.79 Jarvis Runtime
 *
 * 阿里 Qwen3-ASR-0.6B,中英双语,SM121 / aarch64 实测稳态:
 *   - P50: 146 ms (4s 音频)
 *   - RTF: 0.036 (28x 实时)
 *   - VRAM: 1.5 GB
 *   - transformers backend(避开 vLLM SM121 已知问题)
 *
 * 部署方式:
 *   - 不用官方 amd64 Docker(DGX aarch64 不兼容,2026-04-30 实测)
 *   - 走 pip install qwen-asr 0.0.6 + transformers 在 DGX venv
 *   - 实际部署一个 Python HTTP server 包装 Qwen3ASRModel,Lynn 通过 HTTP 调用
 *
 * Phase 1 范围:整段 transcribe(模拟 SenseVoice 接口)
 * Phase 2 加:streaming partial(包装 init_streaming_state + streaming_transcribe)
 *
 * 协议(Phase 1):
 *   POST /transcribe  multipart/form-data { file: audio/* }
 *   Response: { text, language, duration_ms }
 *
 * 环境变量:LYNN_QWEN3_ASR_URL(默认 http://localhost:18007)
 */

const DEFAULT_ASR_URL = process.env.LYNN_QWEN3_ASR_URL || "http://localhost:18007";
const DEFAULT_TRANSCRIBE_TIMEOUT_MS = Number(process.env.LYNN_QWEN3_ASR_TIMEOUT_MS || 15000);

function normalizeLanguage(language) {
  const value = String(language || "auto").trim();
  if (!value || value.toLowerCase() === "auto") return "";
  const key = value.toLowerCase().replace(/_/g, "-");
  if (["zh", "zh-cn", "zh-hans", "cn", "chinese", "mandarin"].includes(key)) return "Chinese";
  if (["en", "en-us", "en-gb", "english"].includes(key)) return "English";
  return value;
}

function inferAudioMimeType(filename) {
  const value = String(filename || "").toLowerCase();
  if (value.endsWith(".wav")) return "audio/wav";
  if (value.endsWith(".mp3")) return "audio/mpeg";
  if (value.endsWith(".m4a")) return "audio/mp4";
  if (value.endsWith(".ogg")) return "audio/ogg";
  if (value.endsWith(".webm")) return "audio/webm";
  return "audio/wav";
}

export function createQwen3AsrProvider(config = {}) {
  const baseUrl = String(config.base_url || config.baseUrl || DEFAULT_ASR_URL).replace(/\/+$/, "");
  const timeoutMs = Number(config.timeout_ms || config.timeoutMs || DEFAULT_TRANSCRIBE_TIMEOUT_MS);
  return {
    name: "qwen3-asr",
    label: "Qwen3-ASR-0.6B (V0.79 主转写,SM121 实测稳态)",

    async transcribe(audioBuffer, { language = "auto", filename = "audio.wav" } = {}) {
      const form = new FormData();
      form.append("file", new Blob([audioBuffer], { type: inferAudioMimeType(filename) }), filename);
      // 2026-05-01 实测:qwen-asr 0.0.6 只接受完整英文名 (Chinese/English/...),不接 ISO
      // server 端已做归一化,但客户端也给友好默认,避免日志错误刷屏
      const normalizedLanguage = normalizeLanguage(language);
      if (normalizedLanguage) {
        form.append("language", normalizedLanguage);
      }

      const res = await fetch(`${baseUrl}/transcribe`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`qwen3-asr transcribe failed: HTTP ${res.status} ${errText.slice(0, 120)}`);
      }
      return await res.json(); // { text, language, duration_ms }
    },

    async health() {
      try {
        const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
      } catch {
        return false;
      }
    },

    /**
     * Phase 2 placeholder:streaming partial transcript
     * 真实接口会接 Python 包装的 Qwen3ASRModel.streaming_transcribe()
     */
    async transcribeStreaming(_audioStream, _opts = {}) {
      throw new Error("qwen3-asr streaming: Phase 2 实装,Phase 1 stub");
    },
  };
}
