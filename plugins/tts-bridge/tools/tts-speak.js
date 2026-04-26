/**
 * tts-speak.js — 文本转语音工具（v0.77 真实实现）
 */
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
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

function voiceForProvider(provider, requestedVoice, defaultVoice) {
  if (provider === "say") return "";
  if (provider === "edge") {
    if (String(requestedVoice || defaultVoice || "").startsWith("zh-")) return requestedVoice || defaultVoice;
    return "zh-CN-XiaoxiaoNeural";
  }
  return requestedVoice || defaultVoice;
}

function normalizeTextForSpeech(value) {
  return String(value || "")
    // Weather and market answers often contain compact machine-readable units.
    // Expand them before TTS so Chinese voices don't switch into English.
    .replace(/(\d+(?:\.\d+)?)\s*[~～]\s*(\d+(?:\.\d+)?)\s*(?:°\s*C|℃|摄氏度)/gi, "$1 到 $2 摄氏度")
    .replace(/(\d+(?:\.\d+)?)\s*(?:°\s*C|℃)/gi, "$1 摄氏度")
    .replace(/(\d+(?:\.\d+)?)\s*%/g, "百分之 $1")
    .replace(/(\d+(?:\.\d+)?)\s*(?:km\/h|公里\/小时)/gi, "$1 公里每小时")
    .replace(/(\d+(?:\.\d+)?)\s*mm\b/gi, "$1 毫米")
    .replace(/(\d+(?:\.\d+)?)\s*(?:元\/克|元\/g)/gi, "$1 元每克")
    .replace(/\bXAU\/USD\b/gi, "国际现货黄金")
    .replace(/\bXAG\/USD\b/gi, "国际现货白银")
    .replace(/\bHKD\b/g, "港元")
    .replace(/\bUSD\b/g, "美元")
    .replace(/\bCNY\b/g, "人民币")
    .replace(/\bRMB\b/g, "人民币")
    .replace(/\s+/g, " ")
    .trim();
}

function hashSpeechRequest(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function execute(params, ctx = {}) {
  const { text, voice, speed, filename } = params;
  const { log = console, config } = ctx;
  if (!text || !String(text).trim()) {
    throw new Error("tts_speak: empty text");
  }
  const speechText = normalizeTextForSpeech(text);
  log.info?.("tts_speak:", speechText.slice(0, 40) + "...", "voice:", voice || "default");

  // ctx.dataDir 可能未注入或相对路径 → fallback 到 ~/.lynn/audio
  const baseDir = ctx.dataDir && path.isAbsolute(ctx.dataDir)
    ? ctx.dataDir
    : path.join(os.homedir(), ".lynn");
  const outDir = path.join(baseDir, "audio");
  fs.mkdirSync(outDir, { recursive: true });

  // Lazy cleanup:删 7 天前 + 总数 > 50 时删最老(防 1GB/月 累积)
  try {
    const SEVEN_DAYS = 7 * 24 * 3600 * 1000;
    const now = Date.now();
    const files = fs.readdirSync(outDir)
      .map((name) => {
        const fp = path.join(outDir, name);
        try {
          const stat = fs.statSync(fp);
          return { fp, mtime: stat.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    files.forEach((f, i) => {
      if (i >= 50 || (now - f.mtime) > SEVEN_DAYS) {
        try { fs.unlinkSync(f.fp); } catch {}
      }
    });
  } catch {} // cleanup 失败不阻塞 TTS 生成

  const baseName = filename || `tts_${Date.now()}`;
  // 当前 cosyvoice/say provider 输出 wav,edge/openai 输出 mp3 — 由 provider 内部决定真正写入格式
  // 用 .wav 扩展名让 macOS afplay/QuickLook 直接识别(magic bytes 检测 RIFF 头)
  const outPath = path.join(outDir, `${baseName}.wav`);
  const metaPath = path.join(outDir, `${baseName}.json`);

  const engineConfig = ctx.engine?.config || {};
  const voiceConfig = engineConfig.voice?.tts || {};
  const cfg = {
    provider: voiceConfig.provider || config?.get?.("provider") || "cosyvoice",
    default_voice: voiceConfig.default_voice || config?.get?.("default_voice") || "中文女",
  };

  const providers = [
    cfg.provider,
    process.platform === "darwin" ? "say" : "",
    "edge",
  ].filter(Boolean).filter((item, index, arr) => arr.indexOf(item) === index);

  const requestHash = hashSpeechRequest({
    text: speechText,
    requestedVoice: voice || "",
    speed: Number(speed || 1),
    provider: cfg.provider,
    defaultVoice: cfg.default_voice,
    providers,
  });

  try {
    if (fs.existsSync(outPath) && fs.existsSync(metaPath)) {
      const cachedMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (cachedMeta?.requestHash === requestHash) {
        log.info?.("tts_speak cache hit:", path.basename(outPath));
        return {
          content: [{
            type: "text",
            text: `语音已缓存：${path.basename(outPath)}（provider: ${cachedMeta.provider || "cached"}）`,
          }],
          details: {
            ok: true,
            path: outPath,
            provider: cachedMeta.provider || cfg.provider,
            fallbackFrom: cachedMeta.fallbackFrom || "",
            cached: true,
            errors: [],
            textLength: speechText.length,
          },
        };
      }
    }
  } catch {
    // Cache metadata is best-effort. A bad sidecar should never block TTS.
  }

  let result = null;
  const errors = [];
  for (const provider of providers) {
    try {
      result = await synthesize({
        text: speechText,
        voice: voiceForProvider(provider, voice, cfg.default_voice),
        speed,
        outPath,
        provider,
      });
      result.fallbackFrom = provider === cfg.provider ? "" : cfg.provider;
      break;
    } catch (err) {
      errors.push(`${provider}: ${err.message || err}`);
    }
  }
  if (!result) {
    throw new Error(`TTS 生成失败：${errors.join(" | ")}`);
  }

  try {
    fs.writeFileSync(metaPath, JSON.stringify({
      requestHash,
      provider: result.provider,
      fallbackFrom: result.fallbackFrom || "",
      textLength: speechText.length,
      createdAt: new Date().toISOString(),
    }, null, 2));
  } catch {}

  return {
    content: [{
      type: "text",
      text: `语音已生成：${path.basename(result.path)}（provider: ${result.provider}${result.fallbackFrom ? `，fallback from ${result.fallbackFrom}` : ""}）`,
    }],
    details: {
      ok: true,
      path: result.path,
      provider: result.provider,
      fallbackFrom: result.fallbackFrom || "",
      cached: false,
      errors,
      textLength: speechText.length,
    },
  };
}
