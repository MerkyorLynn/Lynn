/**
 * Edge TTS Provider · 免费在线，免登录
 */
import fs from "fs";

let _edgeTtsModule = null;
async function getEdgeTts() {
  if (_edgeTtsModule) return _edgeTtsModule;
  try {
    _edgeTtsModule = await import("edge-tts");
    return _edgeTtsModule;
  } catch {
    return null;
  }
}

export function createEdgeTTSProvider(_config) {
  return {
    name: "edge",
    label: "Edge TTS (免费在线)",

    async synthesize({ text, voice, speed, outPath }) {
      fs.mkdirSync(outPath.substring(0, outPath.lastIndexOf("/")), { recursive: true });
      const edge = await getEdgeTts();
      if (edge && edge.EdgeTTS) {
        const tts = new edge.EdgeTTS();
        const rate = speed ? `${speed >= 1 ? "+" : ""}${Math.round((speed - 1) * 100)}%` : "+0%";
        await tts.ttsPromise(text, voice || "zh-CN-XiaoxiaoNeural", { rate, volume: "+0%" });
        const buffer = await tts.toBuffer();
        fs.writeFileSync(outPath, buffer);
        return { ok: true, provider: "edge-tts", path: outPath };
      }
      throw new Error("edge-tts module is not installed");
    },
  };
}
