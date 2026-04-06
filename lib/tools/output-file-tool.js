/**
 * output-file-tool.js — 文件呈现工具（present_files）
 *
 * 兼容 Claude.ai 的 present_files 接口：接收文件路径数组，
 * 服务端拦截并通过 WebSocket 推送 file_output 事件给前端。
 *
 * 参数：{ filepaths: string[] }
 * 同时向下兼容旧的单文件调用：{ filePath: string, label?: string }
 */
import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

/** 修正 LLM 常见的路径问题：转义空格、URL 编码、多余引号 */
function sanitizePath(p) {
  p = p.trim().replace(/^["']|["']$/g, "");
  p = p.replace(/\\ /g, " ");
  if (p.includes("%20")) {
    try { p = decodeURIComponent(p); } catch {}
  }
  return p;
}

export function createPresentFilesTool() {
  return {
    name: "present_files",
    label: t("toolDef.outputFile.label"),
    description: t("toolDef.outputFile.description"),
    parameters: Type.Object({
      filepaths: Type.Optional(Type.Array(Type.String(), {
        minItems: 1,
        description: t("toolDef.outputFile.filepathsDesc"),
      })),
      // 向下兼容旧接口
      filePath: Type.Optional(Type.String({ description: t("toolDef.outputFile.filePathDesc") })),
      label: Type.Optional(Type.String({ description: t("toolDef.outputFile.labelDesc") })),
    }),
    execute: async (_toolCallId, params) => {
      // 统一为路径数组：优先使用 filepaths，兼容 filePath
      let paths = params.filepaths;
      if (!paths || paths.length === 0) {
        if (params.filePath) {
          paths = [params.filePath];
        } else {
          return {
            content: [{ type: "text", text: t("error.outputFileNeedPaths") }],
            details: {},
          };
        }
      }

      const results = [];
      const errors = [];

      for (const raw of paths) {
        const fp = sanitizePath(raw);

        if (!path.isAbsolute(fp)) {
          errors.push(t("error.outputFileNotAbsolute", { path: fp }));
          continue;
        }
        if (!fs.existsSync(fp)) {
          errors.push(t("error.outputFileNotFound", { path: fp }));
          continue;
        }

        const displayLabel = path.basename(fp);
        const ext = path.extname(fp).toLowerCase().replace(".", "");
        results.push({ filePath: fp, label: params.label || displayLabel, ext });
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: errors.join("\n") }],
          details: {},
        };
      }

      const summary = results.map(r => r.label).join(", ");
      return {
        content: [{ type: "text", text: t("error.outputFilePresented", { summary }) }],
        details: { files: results },
      };
    },
  };
}

// 向下兼容旧导出名
export const createOutputFileTool = createPresentFilesTool;
