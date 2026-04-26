/**
 * audio.js — TTS 音频文件 HTTP 路由
 *
 * 提供 /audio/:filename 端点供前端播放已生成的语音文件。
 */
import { Hono } from "hono";
import fs from "fs";
import path from "path";
import os from "os";

export default function registerAudioRoutes(app, ctx) {
  const audioDirs = [
    path.join(os.homedir(), ".lynn", "audio"),
    path.join(ctx.dataDir || "", "audio"),
  ].filter(Boolean);
  for (const dir of audioDirs) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
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
}
