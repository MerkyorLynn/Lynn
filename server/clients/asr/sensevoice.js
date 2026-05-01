/**
 * SenseVoice ASR Provider · v0.77 / 0.78
 *
 * 阿里达摩院 SenseVoice 流式 ASR(中文 50ms,WER 业界领先)
 * 部署在 Spark,brain 走 frp 反向 :18020 → DGX :8004
 *
 * 协议:OpenAI 兼容 /v1/audio/transcriptions(跟 Whisper 一致,响应也一样)
 * 环境变量:LYNN_SENSEVOICE_URL(默认 http://localhost:18020)
 */

const DEFAULT_ASR_URL = process.env.LYNN_SENSEVOICE_URL || "http://localhost:18020";

export function createSenseVoiceProvider(config = {}) {
  const baseUrl = String(config.base_url || config.baseUrl || DEFAULT_ASR_URL).replace(/\/+$/, "");
  return {
    name: "sensevoice",
    label: "SenseVoice (达摩院・推荐)",

    async transcribe(audioBuffer, { language = "zh", filename = "audio.webm" } = {}) {
      const form = new FormData();
      form.append("file", new Blob([audioBuffer], { type: "audio/webm" }), filename);
      form.append("language", language);
      form.append("response_format", "json");

      const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`sensevoice transcribe failed: HTTP ${res.status} ${errText.slice(0, 120)}`);
      }
      return await res.json(); // { text, language, duration }
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
