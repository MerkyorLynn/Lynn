/**
 * CosyVoice 2 TTS Provider · v0.78 (streaming added 2026-05-28)
 *
 * 阿里 CosyVoice 2(中文流式 TTS 顶级,语音克隆能力)
 * 部署在 Spark,brain 走 frp 反向 :18021 → DGX :8005
 *
 * 协议:OpenAI 兼容
 *   POST /v1/audio/speech         同步,返回完整 wav bytes(老路径)
 *   POST /v1/audio/speech/stream  chunked transfer,边合成边发(P1 新路径)
 *
 * 环境变量:LYNN_COSYVOICE_URL(默认 http://localhost:18021)
 *
 * 2026-05-28 修复 + 增强:
 *   - 之前生产容器漏 --gpus all → cuBLAS_STATUS_EXECUTION_FAILED,已用 systemd unit 锁住
 *   - synthesizeStream() 新增,返回 Web Streams API ReadableStream,
 *     上层可以 proxy 到 HTTP chunked Response → UI 用 MediaSource 边收边播
 *   - 实测短文本 RT 1.87x,长文本 ~1.9x,/health + sm_121 capability OK
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

    /**
     * 流式合成:返回 { stream: ReadableStream<Uint8Array>, contentType }
     * upstream cosyvoice /v1/audio/speech/stream chunked WAV(22050Hz mono PCM16)
     * 调用方:可以 fs.createWriteStream pipe / 也可以直接 proxy 给 HTTP Response
     */
    async synthesizeStream({ text, voice, speed, signal }) {
      if (!text || !text.trim()) {
        throw new Error("cosyvoice: empty text");
      }
      const res = await fetch(`${TTS_URL}/v1/audio/speech/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "cosyvoice2",
          input: text,
          voice: voice || "中文女",
          response_format: "wav",
          speed: speed || 1.0,
        }),
        signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`cosyvoice stream failed: HTTP ${res.status} ${errText.slice(0, 120)}`);
      }
      if (!res.body) {
        throw new Error("cosyvoice stream: response.body is null (Node fetch streaming not supported?)");
      }
      return {
        stream: res.body,                           // ReadableStream<Uint8Array>
        contentType: res.headers.get("content-type") || "audio/wav",
        provider: "cosyvoice",
      };
    },

    /** capability advertisement(给 tts-engine 路由判断) */
    supportsStreaming: true,
  };
}
