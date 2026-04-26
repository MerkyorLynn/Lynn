/**
 * tts-speak.js — 文本转语音工具（v0.77 真实实现）
 */
import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import { synthesize } from "../lib/tts-engine.js";

export const name = "tts_speak";
export const description =
  "将指定文本转为语音音频文件，保存到书桌。支持 Edge TTS（免费在线）和 macOS say（本地）。" +
  "适合有声书、长文朗读、定时播报等场景。";
export const parameters = Type.Object({
  text: Type.String({ description: "要朗读的文本内容。建议不超过 3000 字；更长文本请分段调用。" }),
  voice: Type.String({ description: "音色 ID，默认使用插件配置中的 default_voice。", default: "" }),
  speed: Type.Number({ description: "语速倍率，0.5-2.0，默认 1.0。", default: 1.0, minimum: 0.5, maximum: 2.0 }),
  filename: Type.String({ description: "保存文件名（不含扩展名），默认自动生成。", default: "" }),
});

export async function execute(params, ctx) {
  const { text, voice, speed, filename } = params;
  const { log, config } = ctx;
  log.info("tts_speak:", text.slice(0, 40) + "...", "voice:", voice || "default");

  const outDir = path.join(ctx.dataDir || "", "audio");
  fs.mkdirSync(outDir, { recursive: true });
  const baseName = filename || `tts_${Date.now()}`;
  const outPath = path.join(outDir, `${baseName}.mp3`);

  const engineConfig = ctx.engine?.config || {};
  const voiceConfig = engineConfig.voice?.tts || {};
  const cfg = {
    provider: voiceConfig.provider || config?.get?.("provider") || "edge",
    default_voice: voiceConfig.default_voice || config?.get?.("default_voice") || "zh-CN-XiaoxiaoNeural",
  };

  const result = await synthesize({
    text,
    voice: voice || cfg.default_voice,
    speed,
    outPath,
    provider: cfg.provider,
  });

  return {
    content: [{
      type: "text",
      text: `语音已生成：${path.basename(result.path)}（provider: ${result.provider}）`,
    }],
    details: { ok: true, path: result.path, provider: result.provider, textLength: text.length },
  };
}
