/**
 * OpenAI Whisper API Provider · v0.77
 *
 * BYOK 模式：用户填 OpenAI API Key，按量付费。
 * 配置项：apiKey, baseUrl（可选，默认 https://api.openai.com/v1）
 */

export function createOpenAIWhisperProvider(config) {
  const apiKey = config?.apiKey || config?.api_key || "";
  const baseUrl = (config?.baseUrl || config?.base_url || "https://api.openai.com/v1").replace(/\/+$/, "");

  return {
    name: "openai-whisper",
    label: "OpenAI Whisper API",

    async transcribe(audioBuffer, { language = "zh", filename = "audio.webm" } = {}) {
      if (!apiKey) throw new Error("OpenAI API Key is not configured");

      const form = new FormData();
      form.append("file", new Blob([audioBuffer], { type: "audio/webm" }), filename);
      form.append("model", "whisper-1");
      if (language && language !== "auto") {
        form.append("language", language);
      }
      form.append("response_format", "json");

      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI Whisper failed: HTTP ${res.status} ${err}`);
      }
      const data = await res.json(); // { text }
      return { text: data.text || "", language, duration: 0 };
    },

    async health() {
      if (!apiKey) return false;
      try {
        const r = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        return r.ok;
      } catch { return false; }
    },
  };
}
