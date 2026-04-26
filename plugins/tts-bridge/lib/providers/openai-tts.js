/**
 * OpenAI TTS Provider · v0.77
 *
 * BYOK 模式：用户填 OpenAI API Key，按量付费。
 * 配置项：apiKey, baseUrl（可选，默认 https://api.openai.com/v1）, voice（默认 alloy）
 */
import fs from "fs";

export function createOpenAITTSProvider(config) {
  const apiKey = config?.apiKey || config?.api_key || "";
  const baseUrl = (config?.baseUrl || config?.base_url || "https://api.openai.com/v1").replace(/\/+$/, "");
  const defaultVoice = config?.voice || "alloy";

  return {
    name: "openai",
    label: "OpenAI TTS API",

    async synthesize({ text, voice, speed, outPath }) {
      if (!apiKey) throw new Error("OpenAI API Key is not configured");

      const res = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          input: text,
          voice: voice || defaultVoice,
          speed: speed || 1.0,
          response_format: "mp3",
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI TTS failed: HTTP ${res.status} ${err}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(outPath, buffer);
      return { ok: true, provider: "openai-tts", path: outPath };
    },
  };
}
