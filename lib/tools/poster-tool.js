/**
 * poster-tool.js — 海报生成工具（create_poster）
 *
 * Agent 调用此工具生成精美 HTML 海报。模型提供内容和布局参数，
 * 工具使用内置模板渲染海报并保存为 HTML 文件，可在浏览器中打开。
 */
import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { t } from "../../server/i18n.js";

let _counter = 0;

function safeFilename(title) {
  return title.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "poster";
}

export function createPosterTool({ getDeskDir } = {}) {
  return {
    name: "create_poster",
    label: t("toolDef.poster.label"),
    description: t("toolDef.poster.description"),
    parameters: Type.Object({
      title: Type.String({ description: t("toolDef.poster.titleDesc") }),
      subtitle: Type.Optional(Type.String({ description: t("toolDef.poster.subtitleDesc") })),
      theme: Type.Optional(StringEnum(["dark", "light", "gradient", "minimal"], {
        description: "Poster theme: dark (default), light (white bg), gradient (colorful), minimal (clean)",
      })),
      content: Type.String({ description: t("toolDef.poster.contentDesc") }),
      footer: Type.Optional(Type.String({ description: t("toolDef.poster.footerDesc") })),
      size: Type.Optional(StringEnum(["a4", "wide", "square", "phone"], {
        description: "Poster size: a4 (portrait), wide (16:9), square (1:1), phone (9:16)",
      })),
    }),
    execute: async (_toolCallId, params) => {
      const theme = params.theme || "dark";
      const size = params.size || "a4";

      const SIZES = {
        a4: { w: "794px", h: "1123px" },
        wide: { w: "1920px", h: "1080px" },
        square: { w: "1080px", h: "1080px" },
        phone: { w: "1080px", h: "1920px" },
      };

      const THEMES = {
        dark: { bg: "#0a0e1a", text: "#e2e8f0", accent: "#f59e0b", sub: "#94a3b8", gradient: "linear-gradient(135deg, #0a0e1a, #1a1a2e)" },
        light: { bg: "#ffffff", text: "#1e293b", accent: "#2563eb", sub: "#64748b", gradient: "linear-gradient(135deg, #f8fafc, #e2e8f0)" },
        gradient: { bg: "#0f172a", text: "#ffffff", accent: "#f472b6", sub: "#c4b5fd", gradient: "linear-gradient(135deg, #667eea, #764ba2, #f093fb)" },
        minimal: { bg: "#fafafa", text: "#18181b", accent: "#dc2626", sub: "#71717a", gradient: "linear-gradient(180deg, #fafafa, #f4f4f5)" },
      };

      const T = THEMES[theme] || THEMES.dark;
      const S = SIZES[size] || SIZES.a4;

      const contentHtml = (params.content || "")
        .split("\n")
        .filter((l) => l.trim())
        .map((line) => {
          if (line.startsWith("# ")) return `<h2 style="font-size:28px;font-weight:800;margin:24px 0 12px;color:${T.accent}">${line.slice(2)}</h2>`;
          if (line.startsWith("## ")) return `<h3 style="font-size:22px;font-weight:700;margin:20px 0 8px;color:${T.text}">${line.slice(3)}</h3>`;
          if (line.startsWith("- ")) return `<p style="font-size:18px;margin:6px 0;padding-left:20px;color:${T.text}">• ${line.slice(2)}</p>`;
          return `<p style="font-size:18px;line-height:1.8;margin:8px 0;color:${T.text}">${line}</p>`;
        })
        .join("\n");

      const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${params.title}</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;700;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:${T.bg};display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:'Noto Sans SC',system-ui,sans-serif}
.poster{width:${S.w};min-height:${S.h};background:${T.gradient};padding:60px;display:flex;flex-direction:column;justify-content:center;position:relative;overflow:hidden}
.poster::before{content:'';position:absolute;top:-50%;right:-30%;width:600px;height:600px;background:radial-gradient(circle,${T.accent}15,transparent 70%);border-radius:50%}
.poster::after{content:'';position:absolute;bottom:-40%;left:-20%;width:500px;height:500px;background:radial-gradient(circle,${T.accent}10,transparent 70%);border-radius:50%}
.inner{position:relative;z-index:1}
.title{font-size:48px;font-weight:900;color:${T.text};line-height:1.2;margin-bottom:16px;background:linear-gradient(135deg,${T.text},${T.accent});-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.subtitle{font-size:20px;color:${T.sub};margin-bottom:40px;letter-spacing:2px}
.content{margin-bottom:40px}
.divider{width:80px;height:3px;background:${T.accent};margin:32px 0;border-radius:2px}
.footer{font-size:14px;color:${T.sub};margin-top:auto;padding-top:40px;border-top:1px solid ${T.accent}30}
</style></head>
<body><div class="poster"><div class="inner">
<h1 class="title">${params.title}</h1>
${params.subtitle ? `<p class="subtitle">${params.subtitle}</p>` : ""}
<div class="divider"></div>
<div class="content">${contentHtml}</div>
${params.footer ? `<div class="footer">${params.footer}</div>` : ""}
</div></div></body></html>`;

      const filename = `${safeFilename(params.title)}.html`;
      let outDir = getDeskDir?.();
      if (!outDir) outDir = (await import("os")).tmpdir();
      fs.mkdirSync(outDir, { recursive: true });
      const filePath = path.join(outDir, filename);
      fs.writeFileSync(filePath, html, "utf-8");

      const artifactId = `poster-${Date.now()}-${++_counter}`;

      return {
        content: [{ type: "text", text: t("toolDef.poster.created", { title: params.title, path: filePath }) }],
        details: {
          artifactId,
          type: "html",
          title: params.title,
          content: html,
          files: [{ filePath, label: filename, ext: "html" }],
        },
      };
    },
  };
}
