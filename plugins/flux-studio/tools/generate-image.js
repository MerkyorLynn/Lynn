/**
 * generate-image.js — 图像生成工具（v0.77 真实实现）
 */
import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import { generateImage } from "../lib/flux-engine.js";

export const name = "generate_image";
export const description =
  "根据文本提示词生成图像。支持选择尺寸、风格和种子值。" +
  "生成结果保存到书桌 gallery/ 目录，可在画廊视图中浏览。";
export const parameters = Type.Object({
  prompt: Type.String({ description: "图像描述的英文提示词。若用户用中文描述，请先翻译为高质量英文 prompt。" }),
  width: Type.Number({ description: "图像宽度", default: 1024 }),
  height: Type.Number({ description: "图像高度", default: 1024 }),
  style: Type.String({ description: "风格修饰词，如 'anime', 'photorealistic', 'watercolor'", default: "" }),
  seed: Type.Number({ description: "随机种子，相同种子可复现结果。默认随机。", default: -1 }),
  filename: Type.String({ description: "保存文件名（不含扩展名）", default: "" }),
});

export async function execute(params, ctx) {
  const { prompt, width, height, style, seed, filename } = params;
  const { log, config } = ctx;
  log.info("generate_image:", prompt.slice(0, 40), `${width}x${height}`);

  const galleryDir = path.join(ctx.dataDir || "", "gallery");
  fs.mkdirSync(galleryDir, { recursive: true });
  const baseName = filename || `img_${Date.now()}`;
  const outPath = path.join(galleryDir, `${baseName}.png`);

  const cfg = {
    provider: config?.get?.("provider") || "siliconflow",
    api_key: config?.get?.("api_key") || "",
    endpoint: config?.get?.("endpoint") || "",
  };

  try {
    const buffer = await generateImage({ prompt, width, height, style, seed, config: cfg });
    fs.writeFileSync(outPath, buffer);
    return {
      content: [{
        type: "text",
        text: `图像已生成：${path.basename(outPath)}\n尺寸: ${width}x${height}\nPrompt: ${prompt}`,
      }],
      details: { ok: true, path: outPath, prompt, width, height, style, seed },
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `图像生成失败: ${err.message}` }],
      details: { ok: false, error: err.message },
    };
  }
}
