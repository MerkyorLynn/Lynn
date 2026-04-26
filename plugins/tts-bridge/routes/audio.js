/**
 * audio.js — TTS 音频文件 HTTP 路由
 *
 * 提供 /audio/:filename 端点供前端播放已生成的语音文件。
 */
import { Hono } from "hono";
import fs from "fs";
import path from "path";

export default function registerAudioRoutes(app, ctx) {
  const audioDir = path.join(ctx.dataDir || "", "audio");
  fs.mkdirSync(audioDir, { recursive: true });

  app.get("/audio/:filename", async (c) => {
    const filename = c.req.param("filename");
    const filePath = path.join(audioDir, filename);
    if (!fs.existsSync(filePath)) {
      return c.json({ error: "not_found" }, 404);
    }
    const stat = fs.statSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === ".mp3" ? "audio/mpeg" : ext === ".wav" ? "audio/wav" : "application/octet-stream";
    c.header("Content-Type", mime);
    c.header("Content-Length", String(stat.size));
    return c.body(fs.createReadStream(filePath));
  });
}
