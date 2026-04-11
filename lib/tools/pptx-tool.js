/**
 * pptx-tool.js — PowerPoint 生成工具（create_pptx）
 *
 * Agent 调用此工具生成 PPTX 文件。接收结构化的幻灯片数据，
 * 使用 pptxgenjs 生成文件并保存到笺目录，通过 file_output 事件呈现给用户。
 */
import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { t } from "../../server/i18n.js";

/** 解析 body 文本为 pptxgenjs 文本对象数组（支持 Markdown 列表） */
function parseBody(body = "") {
  const lines = body.split("\n").filter((l) => l.trim());
  const result = [];
  for (const line of lines) {
    const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
    if (bulletMatch) {
      result.push({
        text: bulletMatch[1].trim(),
        options: { bullet: true, fontSize: 16, color: "333333", lineSpacingMultiple: 1.3 },
      });
    } else {
      result.push({
        text: line.trim(),
        options: { fontSize: 16, color: "333333", lineSpacingMultiple: 1.3 },
      });
    }
  }
  return result;
}

/** 双栏 body 解析：用 ||| 或 --- 分隔左右两栏 */
function parseTwoColumnBody(body = "") {
  const sep = body.includes("|||") ? "|||" : "---";
  const parts = body.split(sep);
  return {
    left: parseBody(parts[0] || ""),
    right: parseBody(parts[1] || ""),
  };
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

      for (const s of params.slides) {
        const layout = s.layout || "content";
        const slide = pres.addSlide();
        slide.background = { color: "FFFFFF" };

        if (layout === "title") {
          // ── 标题页 ──
          slide.background = { color: "1a1a2e" };
          slide.addText(s.title, {
            x: 0.8, y: 2.0, w: "85%", h: 1.5,
            fontSize: 40, bold: true, color: "FFFFFF",
            align: "center", fontFace: "Microsoft YaHei",
          });
          if (s.body) {
            slide.addText(s.body, {
              x: 0.8, y: 3.8, w: "85%", h: 0.8,
              fontSize: 20, color: "AAAAAA",
              align: "center", fontFace: "Microsoft YaHei",
            });
          }
        } else if (layout === "section") {
          // ── 章节过渡页 ──
          slide.background = { color: "16213e" };
          slide.addText(s.title, {
            x: 0.8, y: 2.5, w: "85%", h: 1.2,
            fontSize: 36, bold: true, color: "e94560",
            align: "center", fontFace: "Microsoft YaHei",
          });
          if (s.body) {
            slide.addText(s.body, {
              x: 0.8, y: 3.8, w: "85%", h: 0.6,
              fontSize: 18, color: "CCCCCC",
              align: "center", fontFace: "Microsoft YaHei",
            });
          }
        } else if (layout === "two_column") {
          // ── 双栏页 ──
          slide.addText(s.title, {
            x: 0.5, y: 0.3, w: "90%", h: 0.7,
            fontSize: 28, bold: true, color: "1a1a2e",
            fontFace: "Microsoft YaHei",
          });
          slide.addShape("rect", {
            x: 0.5, y: 1.0, w: "90%", h: 0.02,
            fill: { color: "e94560" },
          });
          const cols = parseTwoColumnBody(s.body || "");
          if (cols.left.length > 0) {
            slide.addText(cols.left, {
              x: 0.5, y: 1.3, w: "43%", h: 4.5,
              valign: "top", fontFace: "Microsoft YaHei",
            });
          }
          if (cols.right.length > 0) {
            slide.addText(cols.right, {
              x: 6.2, y: 1.3, w: "43%", h: 4.5,
              valign: "top", fontFace: "Microsoft YaHei",
            });
          }
        } else {
          // ── 内容页（默认） ──
          slide.addText(s.title, {
            x: 0.5, y: 0.3, w: "90%", h: 0.7,
            fontSize: 28, bold: true, color: "1a1a2e",
            fontFace: "Microsoft YaHei",
          });
          slide.addShape("rect", {
            x: 0.5, y: 1.0, w: "90%", h: 0.02,
            fill: { color: "e94560" },
          });
          if (s.body) {
            const bodyItems = parseBody(s.body);
            slide.addText(bodyItems, {
              x: 0.5, y: 1.3, w: "90%", h: 4.5,
              valign: "top", fontFace: "Microsoft YaHei",
            });
          }
        }

        if (s.notes) {
          slide.addNotes(s.notes);
        }
      }

      // 生成文件
      const buffer = await pres.write({ outputType: "nodebuffer" });
      const filename = `${safeFilename(params.title)}.pptx`;

      // 优先保存到笺目录，否则 tmpdir
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
