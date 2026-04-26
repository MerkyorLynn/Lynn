/**
 * CosyVoice 2 TTS Provider · v0.78
 *
 * 阿里 CosyVoice 2(中文流式 TTS 顶级,语音克隆能力)
 * 部署在 Spark,brain 走 frp 反向 :18021 → DGX :8005
 *
 * 协议:OpenAI 兼容 /v1/audio/speech(POST text → wav bytes)
 * 环境变量:LYNN_COSYVOICE_URL(默认 http://localhost:18021)
 */
import fs from "fs";

const TTS_URL = process.env.LYNN_COSYVOICE_URL || "http://localhost:18021";

export function createCosyVoiceProvider(_config) {
  return {
    name: "cosyvoice",
    label: "CosyVoice 2 (阿里・推荐)",

    async synthesize({ text, voice, speed, outPath }) {
      if (!text || !text.trim()) {
        throw new Error("cosyvoice: empty text");
      }
      const dir = outPath.substring(0, outPath.lastIndexOf("/"));
      if (dir) fs.mkdirSync(dir, { recursive: true });

      const res = await fetch(`${TTS_URL}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "cosyvoice2",
          input: text,
          voice: voice || "中文女",
          response_format: "wav",
          speed: speed || 1.0,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`cosyvoice synthesize failed: HTTP ${res.status} ${errText.slice(0, 120)}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      fs.writeFileSync(outPath, Buffer.from(arrayBuffer));
      return { ok: true, provider: "cosyvoice", path: outPath };
    },
  };
}
