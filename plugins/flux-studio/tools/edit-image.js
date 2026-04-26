/**
 * edit-image.js — 图像编辑工具（局部重绘 / 扩图）
 */
import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";

export const name = "edit_image";
export const description =
  "对已有图像进行编辑：局部重绘（inpaint）、扩图（outpaint）、风格迁移。" +
  "需要指定原图路径和编辑指令。";
export const parameters = Type.Object({
  image_path: Type.String({ description: "原图绝对路径。" }),
  instruction: Type.String({ description: "编辑指令，如 '把背景换成星空'、'扩展右侧 200px'。" }),
  mask_path: Type.String({ description: "遮罩图路径（白色区域为编辑区），可选。", default: "" }),
  filename: Type.String({ description: "保存文件名（不含扩展名）", default: "" }),
});

export async function execute(params, ctx) {
  const { image_path, instruction, mask_path, filename } = params;
  const { log } = ctx;
  log.info("edit_image:", image_path, instruction.slice(0, 40));

  if (!fs.existsSync(image_path)) {
    return {
      content: [{ type: "text", text: `错误：原图不存在 ${image_path}` }],
      details: { ok: false, error: "image_not_found" },
    };
  }

  const galleryDir = path.join(ctx.dataDir || "", "gallery");
  fs.mkdirSync(galleryDir, { recursive: true });
  const baseName = filename || `img_edit_${Date.now()}`;
  const outPath = path.join(galleryDir, `${baseName}.png`);
  fs.copyFileSync(image_path, outPath);

  return {
    content: [{
      type: "text",
      text: `图像编辑已排队（PoC 占位）：${outPath}\n指令：${instruction}\n实际 v0.77 将接入 inpaint/outpaint provider。`,
    }],
    details: { ok: true, path: outPath, instruction, note: "skeleton" },
  };
}
