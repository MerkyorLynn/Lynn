/**
 * audio.js — ASR 音频转文字路由（v0.77）
 *
 * POST /api/v1/audio/transcribe
 * Body: multipart/form-data { file: audio/webm }
 * Query: ?language=zh|en|ja|ko|auto (default: auto → zh)
 *
 * Response: { text, language, duration_ms }
 *
 * 设计选择（方案 B）:
 * - 前端一次性上传完整音频，后端通过 ASR Provider 调度不同引擎，返回 JSON。
 * - 不实现 SSE stream，因为 faster-whisper / OpenAI 均为同步接口。
 */
import { Hono } from "hono";
import { createASRProvider } from "../clients/asr/index.js";

export function createAudioRoute(engine) {
  const route = new Hono();

  route.post("/transcribe", async (c) => {
    try {
      const body = await c.req.parseBody();
      const file = body.file;
      if (!file || !(file instanceof File)) {
        return c.json({ error: "Missing audio file" }, 400);
      }

      const language = c.req.query("language") || "auto";
      const buffer = Buffer.from(await file.arrayBuffer());

      // 从 engine.config 读取 ASR Provider 配置
      const asrConfig = engine?.config?.voice?.asr || {};
      const provider = createASRProvider(asrConfig);

      const result = await provider.transcribe(buffer, {
        language: language === "auto" ? "zh" : language,
        filename: file.name || "audio.webm",
      });

      return c.json({
        text: result.text || "",
        language: result.language || language,
        duration_ms: result.duration ? Math.round(result.duration * 1000) : undefined,
      });
    } catch (err) {
      return c.json({ error: err?.message || "Transcription failed" }, 500);
    }
  });

  return route;
}
