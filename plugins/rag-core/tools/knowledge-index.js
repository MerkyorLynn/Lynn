/**
 * knowledge-index.js — 知识库索引工具（v0.77 真实实现）
 */
import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import { indexDocument } from "../lib/rag-engine.js";

export const name = "knowledge_index";
export const description =
  "将本地文件或文件夹加入知识库索引。支持 Markdown、TXT、HTML、Word（.docx）、PDF（需 pdftotext）。" +
  "自动分块、向量化存储，供 knowledge_query 检索。";
export const parameters = Type.Object({
  file_path: Type.String({ description: "要索引的文件或文件夹的绝对路径。" }),
  collection: Type.String({ description: "目标知识库集合名称，默认 'default'。", default: "default" }),
  recursive: Type.Boolean({ description: "若 file_path 是文件夹，是否递归索引子目录。", default: false }),
});

function collectFiles(dir, recursive) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isFile()) {
      results.push(full);
    } else if (recursive && e.isDirectory()) {
      results.push(...collectFiles(full, recursive));
    }
  }
  return results;
}

export async function execute(params, ctx) {
  const { file_path, collection = "default", recursive = false } = params;
  const { log, config } = ctx;
  log.info("knowledge_index", file_path, "collection:", collection);

  const dataDir = ctx.dataDir || path.join(ctx.pluginDir, "..", "..", ".data", "rag-core");
  fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(file_path)) {
    return {
      content: [{ type: "text", text: `错误：路径不存在 ${file_path}` }],
      details: { ok: false, error: "path_not_found" },
    };
  }

  const chunkSize = config?.get?.("chunk_size") || 800;
  const overlap = config?.get?.("chunk_overlap") || 100;
  const stat = fs.statSync(file_path);

  if (stat.isDirectory()) {
    const files = collectFiles(file_path, recursive);
    let totalChunks = 0;
    let indexedFiles = 0;
    let failedFiles = 0;
    for (const f of files) {
      try {
        const r = await indexDocument({ filePath: f, collection, dataDir, chunkSize, overlap });
        totalChunks += r.chunkCount;
        indexedFiles++;
      } catch (err) {
        failedFiles++;
        log.warn("索引失败:", f, err.message);
      }
    }
    return {
      content: [{
        type: "text",
        text: `已索引文件夹 ${path.basename(file_path)}：${indexedFiles} 个文件成功，${failedFiles} 个失败，共 ${totalChunks} 个文本块 → 集合「${collection}」。` +
          (recursive ? `（含子目录递归）` : ""),
      }],
      details: { ok: true, path: file_path, collection, indexedFiles, failedFiles, totalChunks, recursive },
    };
  }

  const r = await indexDocument({ filePath: file_path, collection, dataDir, chunkSize, overlap });
  return {
    content: [{ type: "text", text: `已索引 ${path.basename(file_path)}，拆分为 ${r.chunkCount} 个文本块 → 集合「${collection}」。` }],
    details: { ok: true, path: file_path, collection, chunkCount: r.chunkCount, ids: r.indexedIds },
  };
}
