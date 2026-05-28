/**
 * audio.js — TTS 音频 HTTP 路由
 *
 * Endpoints(挂在 /api/plugins/tts-bridge/):
 *   GET  /audio/:filename     已生成音频文件回放
 *   POST /audio/stream        P1 [2026-05-28] 流式合成,chunked WAV proxy
 *                             body: { text, voice?, speed? }
 *                             response: Transfer-Encoding: chunked, Content-Type: audio/wav
 *                             仅当 provider supportsStreaming(cosyvoice)真流式
 */
import fs from "fs";
import path from "path";
import os from "os";
import { createTTSProvider } from "../lib/tts-registry.js";

export default function registerAudioRoutes(app, ctx) {
  const audioDirs = [
    path.join(os.homedir(), ".lynn", "audio"),
    path.join(ctx.dataDir || "", "audio"),
  ].filter(Boolean);
  for (const dir of audioDirs) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }

  app.get("/audio/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!filename || path.basename(filename) !== filename) {
      return c.json({ error: "invalid_filename" }, 400);
    }
    const filePath = audioDirs
      .map((dir) => path.join(dir, filename))
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!filePath) {
      return c.json({ error: "not_found" }, 404);
    }
    const stat = fs.statSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === ".mp3" ? "audio/mpeg" : ext === ".wav" ? "audio/wav" : "application/octet-stream";
    c.header("Content-Type", mime);
    c.header("Content-Length", String(stat.size));
    c.header("Accept-Ranges", "bytes");
    c.header("Cache-Control", "private, max-age=3600");
    return c.body(fs.createReadStream(filePath));
  });

  // P1 [2026-05-28] streaming TTS proxy → CosyVoice /v1/audio/speech/stream
  // UI 用 fetch + MediaSource / AudioContext 边收边播,TTFB ~200-500ms
  app.post("/audio/stream", async (c) => {
    let body = {};
    try { body = await c.req.json(); } catch { /* fall through, validated below */ }
    const text = String(body?.text || "").trim();
    if (!text) return c.json({ error: "empty text" }, 400);
    const voice = body?.voice || "";
    const speed = typeof body?.speed === "number" ? body.speed : 1.0;

    const cfg = ctx?.config || {};
    // 强制走 cosyvoice(唯一支持 streaming 的 provider);用户配 cosyvoice 才能走流式
    const provider = createTTSProvider({ ...cfg, provider: cfg.provider || "cosyvoice" });
    if (typeof provider.synthesizeStream !== "function") {
      return c.json({
        error: `provider "${provider.name}" does not support streaming`,
        hint: "switch provider to cosyvoice, or call /api/tools/tts-bridge.tts_speak for sync path",
      }, 400);
    }

    try {
      const { stream, contentType } = await provider.synthesizeStream({ text, voice, speed });
      c.header("Content-Type", contentType || "audio/wav");
      c.header("Cache-Control", "no-store");
      c.header("X-Tts-Provider", provider.name || "unknown");
      // Hono 接受 ReadableStream<Uint8Array>,自动 chunked transfer
      return c.body(stream);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg.slice(0, 300) }, 502);
    }
  });
}
