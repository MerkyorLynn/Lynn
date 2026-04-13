/**
 * pptx-tool.js — PowerPoint 生成工具（create_pptx）
 *
 * Agent 调用此工具生成 PPTX 文件。接收结构化的幻灯片数据，
 * 使用 pptxgenjs 生成文件并保存到笺目录，通过 file_output 事件呈现给用户。
 *
 * 深色专业主题，与 HTML 报告风格一致。
 */
import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { t } from "../../server/i18n.js";

const THEMES = {
  dark: {
    bg: "0B1120", bgLight: "111B2E", accent: "EF4444", accent2: "F87171",
    green: "10B981", amber: "F59E0B", blue: "3B82F6", purple: "A78BFA",
    text: "E2E8F0", textDim: "7B8CA5", border: "1C2640",
  },
  business: {
    bg: "1E3A5F", bgLight: "254B7A", accent: "F59E0B", accent2: "FBBF24",
    green: "10B981", amber: "F59E0B", blue: "60A5FA", purple: "A78BFA",
    text: "F1F5F9", textDim: "94A3B8", border: "2D5F8A",
  },
  minimal: {
    bg: "FFFFFF", bgLight: "F8FAFC", accent: "2563EB", accent2: "3B82F6",
    green: "16A34A", amber: "D97706", blue: "2563EB", purple: "7C3AED",
    text: "1E293B", textDim: "64748B", border: "E2E8F0",
  },
  tech: {
    bg: "0F172A", bgLight: "1E293B", accent: "22D3EE", accent2: "06B6D4",
    green: "34D399", amber: "FBBF24", blue: "38BDF8", purple: "C084FC",
    text: "E2E8F0", textDim: "94A3B8", border: "334155",
  },
};
const THEME = THEMES.dark; // default

function parseBody(body = "") {
  return body.split("\n").filter((l) => l.trim()).map((line) => {
    const m = line.match(/^\s*[-*]\s+(.+)/);
    return m
      ? { text: m[1].trim(), options: { bullet: { code: "2022" }, fontSize: 15, color: T.text, lineSpacingMultiple: 1.5, paraSpaceBefore: 4 } }
      : { text: line.trim(), options: { fontSize: 15, color: T.text, lineSpacingMultiple: 1.5, paraSpaceBefore: 4 } };
  });
}

function parseTwoColumnBody(body = "") {
  const sep = body.includes("|||") ? "|||" : "---";
  const parts = body.split(sep);
  return { left: parseBody(parts[0] || ""), right: parseBody(parts[1] || "") };
}

function addFooter(slide, num, total) {
  slide.addText(`${num} / ${total}`, { x: 11.5, y: 6.9, w: 1.5, h: 0.3, fontSize: 9, color: T.textDim, align: "right" });
}

function safeFilename(title) {
  return title.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "presentation";
}

export function createPptxTool({ getDeskDir } = {}) {
  return {
    name: "create_pptx",
    label: t("toolDef.pptx.label"),
    description: t("toolDef.pptx.description"),
    parameters: Type.Object({
      title: Type.String({ description: t("toolDef.pptx.titleDesc") }),
      theme: Type.Optional(StringEnum(["dark", "business", "minimal", "tech"], {
        description: "PPT theme: dark (default), business (blue-gold), minimal (white), tech (cyan-dark)",
      })),
      author: Type.Optional(Type.String({ description: t("toolDef.pptx.authorDesc") })),
      slides: Type.Array(
        Type.Object({
          layout: Type.Optional(
            StringEnum(["title", "content", "section", "two_column"], {
              description: t("toolDef.pptx.layoutDesc"),
            }),
          ),
          title: Type.String({ description: t("toolDef.pptx.slideTitleDesc") }),
          body: Type.Optional(Type.String({ description: t("toolDef.pptx.bodyDesc") })),
          notes: Type.Optional(Type.String({ description: t("toolDef.pptx.notesDesc") })),
        }),
        { minItems: 1, description: t("toolDef.pptx.slidesDesc") },
      ),
    }),
    execute: async (_toolCallId, params) => {
      const PptxGenJS = (await import("pptxgenjs")).default;
      const pres = new PptxGenJS();

      pres.layout = "LAYOUT_WIDE";
      pres.title = params.title;
      if (params.author) pres.author = params.author;

      // Select theme
      const T = THEMES[params.theme] || THEMES.dark;
      const total = params.slides.length;

      for (let i = 0; i < total; i++) {
        const s = params.slides[i];
        const layout = s.layout || "content";
        const slide = pres.addSlide();

        if (layout === "title") {
          slide.background = { fill: { type: "solid", color: T.bg } };
          slide.addShape("rect", { x: 3.5, y: 1.6, w: 6, h: 0.04, fill: { color: T.accent } });
          slide.addText(s.title, {
            x: 1.0, y: 1.8, w: 11, h: 1.6,
            fontSize: 38, bold: true, color: "FFFFFF", align: "center", fontFace: "Microsoft YaHei",
          });
          if (s.body) {
            slide.addText(s.body, {
              x: 1.5, y: 3.6, w: 10, h: 0.8,
              fontSize: 18, color: T.textDim, align: "center", fontFace: "Microsoft YaHei",
            });
          }
          slide.addShape("rect", { x: 3.5, y: 4.6, w: 6, h: 0.04, fill: { color: T.accent } });
        } else if (layout === "section") {
          slide.background = { fill: { type: "solid", color: "0D1526" } };
          slide.addShape("rect", { x: 4.5, y: 3.0, w: 4, h: 0.03, fill: { color: T.accent } });
          slide.addText(s.title, {
            x: 1.0, y: 3.2, w: 11, h: 1.2,
            fontSize: 32, bold: true, color: T.accent2, align: "center", fontFace: "Microsoft YaHei",
          });
          if (s.body) {
            slide.addText(s.body, {
              x: 2.0, y: 4.5, w: 9, h: 0.6,
              fontSize: 16, color: T.textDim, align: "center", fontFace: "Microsoft YaHei",
            });
          }
        } else if (layout === "two_column") {
          slide.background = { fill: { type: "solid", color: T.bg } };
          slide.addShape("rect", { x: 0, y: 0, w: "100%", h: 0.9, fill: { color: T.bgLight } });
          slide.addText(s.title, {
            x: 0.6, y: 0.15, w: 11.5, h: 0.6,
            fontSize: 22, bold: true, color: "FFFFFF", fontFace: "Microsoft YaHei",
          });
          slide.addShape("rect", { x: 0.6, y: 0.9, w: 11.8, h: 0.025, fill: { color: T.accent } });
          slide.addShape("line", { x: 6.5, y: 1.2, w: 0, h: 5.0, line: { color: T.border, width: 1 } });
          const cols = parseTwoColumnBody(s.body || "");
          if (cols.left.length > 0) {
            slide.addText(cols.left, { x: 0.6, y: 1.3, w: 5.5, h: 5.0, valign: "top", fontFace: "Microsoft YaHei" });
          }
          if (cols.right.length > 0) {
            slide.addText(cols.right, { x: 6.9, y: 1.3, w: 5.5, h: 5.0, valign: "top", fontFace: "Microsoft YaHei" });
          }
        } else {
          // ── 内容页（默认）──
          slide.background = { fill: { type: "solid", color: T.bg } };
          slide.addShape("rect", { x: 0, y: 0, w: "100%", h: 0.9, fill: { color: T.bgLight } });
          slide.addText(s.title, {
            x: 0.6, y: 0.15, w: 11.5, h: 0.6,
            fontSize: 22, bold: true, color: "FFFFFF", fontFace: "Microsoft YaHei",
          });
          slide.addShape("rect", { x: 0.6, y: 0.9, w: 11.8, h: 0.025, fill: { color: T.accent } });
          if (s.body) {
            slide.addText(parseBody(s.body), {
              x: 0.6, y: 1.3, w: 11.8, h: 5.2, valign: "top", fontFace: "Microsoft YaHei",
            });
          }
        }

        if (s.notes) slide.addNotes(s.notes);
        addFooter(slide, i + 1, total);
      }

      const buffer = await pres.write({ outputType: "nodebuffer" });
      const filename = `${safeFilename(params.title)}.pptx`;
      let outDir = getDeskDir?.();
      if (!outDir) outDir = (await import("os")).tmpdir();
      fs.mkdirSync(outDir, { recursive: true });
      const filePath = path.join(outDir, filename);
      fs.writeFileSync(filePath, buffer);

      return {
        content: [{ type: "text", text: t("toolDef.pptx.created", { title: params.title, path: filePath, count: params.slides.length }) }],
        details: { files: [{ filePath, label: filename, ext: "pptx" }] },
      };
    },
  };
}
