/**
 * Edge TTS Provider · 免费在线,免登录
 *
 * 实测注意(2026-05-28):
 *   edge-tts npm 包(v1.0.1)main 字段是 "index.ts"(TS 源),Node.js runtime
 *   import("edge-tts") 直接报 ERR_MODULE_NOT_FOUND / Unknown file extension。
 *   实际可用的 compiled JS 在 edge-tts/out/index.js(导出 `tts()` 函数式 API,
 *   不是 class EdgeTTS)。先前 await tts.ttsPromise() / toBuffer() 这条路径
 *   假设的是另一个 API shape,实际跑不通。改为函数式调用,失败时多路径 fallback。
 */
import fs from "fs";
import path from "path";

let _edgeTtsModule = null;
async function getEdgeTts() {
  if (_edgeTtsModule !== null) return _edgeTtsModule;
  // 多路径尝试:compiled JS 优先,fallback 到 .ts main(在 Electron + TS loader 下可能 work)
  const candidates = ["edge-tts/out/index.js", "edge-tts"];
  for (const c of candidates) {
    try {
      _edgeTtsModule = await import(c);
      return _edgeTtsModule;
    } catch (_e) { /* try next */ }
  }
  _edgeTtsModule = false;
  return null;
}

export function createEdgeTTSProvider(_config) {
  return {
    name: "edge",
    label: "Edge TTS (免费在线)",

    async synthesize({ text, voice, speed, outPath }) {
      const dir = path.dirname(outPath);
      fs.mkdirSync(dir, { recursive: true });
      const edge = await getEdgeTts();
      if (!edge) throw new Error("edge-tts module is not installed (run `npm install edge-tts` in plugins/tts-bridge)");

      const rate = (typeof speed === "number" && speed !== 1)
        ? `${speed >= 1 ? "+" : ""}${Math.round((speed - 1) * 100)}%`
        : "+0%";
      const v = voice || "zh-CN-XiaoxiaoNeural";

      // 函数式 API:edge.tts(text, { voice, rate, volume }) → Buffer
      // 也兼容老 class API(EdgeTTS().ttsPromise() / toBuffer())
      let buffer;
      if (typeof edge.tts === "function") {
        const result = await edge.tts(text, { voice: v, rate, volume: "+0%" });
        // 结果可能是 Buffer / Uint8Array / { audioData } / { audio }
        if (Buffer.isBuffer(result)) buffer = result;
        else if (result?.audioData) buffer = Buffer.from(result.audioData);
        else if (result?.audio) buffer = Buffer.from(result.audio);
        else if (result instanceof Uint8Array) buffer = Buffer.from(result);
        else throw new Error(`edge-tts unexpected result shape: ${typeof result}`);
      } else if (edge.EdgeTTS) {
        const tts = new edge.EdgeTTS();
        await tts.ttsPromise(text, v, { rate, volume: "+0%" });
        buffer = await tts.toBuffer();
      } else {
        throw new Error("edge-tts module loaded but no recognized API (tts() or EdgeTTS class)");
      }

      fs.writeFileSync(outPath, buffer);
      return { ok: true, provider: "edge-tts", path: outPath };
    },
  };
}
