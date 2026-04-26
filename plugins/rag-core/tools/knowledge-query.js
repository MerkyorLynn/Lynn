/**
 * knowledge-query.js — 知识库查询工具（v0.77 真实实现）
 */
import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import { searchCollection } from "../lib/rag-engine.js";

export const name = "knowledge_query";
export const description =
  "查询本地知识库，返回与用户问题最相关的文本片段。每个片段附带来源文件路径。";
export const parameters = Type.Object({
  query: Type.String({ description: "用户的问题或检索关键词。" }),
  collection: Type.String({ description: "目标知识库集合名称，默认 'default'。", default: "default" }),
  top_k: Type.Number({ description: "返回最相关片段的数量（1-10）。", default: 5, minimum: 1, maximum: 10 }),
});

export async function execute(params, ctx) {
  const { query, collection = "default", top_k = 5 } = params;
  const { log } = ctx;
  log.info("knowledge_query:", query, "collection:", collection, "top_k:", top_k);

  const dataDir = ctx.dataDir || path.join(ctx.pluginDir, "..", "..", ".data", "rag-core");
  const results = await searchCollection({ query, collection, dataDir, topK: top_k });

  if (results.length === 0) {
    return {
      content: [{ type: "text", text: `知识库「${collection}」中未找到与「${query}」相关的内容。` }],
      details: { ok: true, query, collection, results: [] },
    };
  }

  const lines = results.map((r, i) =>
    `--- 片段 ${i + 1}（相似度 ${(r.score * 100).toFixed(1)}%）---\n${r.text}\n📄 来源: ${r.source}`
  );

  return {
    content: [{ type: "text", text: lines.join("\n\n") }],
    details: { ok: true, query, collection, results },
  };
}
