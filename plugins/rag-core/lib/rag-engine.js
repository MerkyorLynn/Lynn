/**
 * rag-engine.js — RAG 本地知识库引擎
 *
 * 复用 Lynn 内置 TfIdfVectorRetriever 做语义检索，
 * 物理存储与 Lynn 记忆系统隔离（插件私有 dataDir）。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const vectorInterfacePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../lib/memory/vector-interface.js");
const { createVectorRetriever } = await import(vectorInterfacePath);

function chunkText(text, chunkSize = 800, overlap = 100) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length < chunkSize) {
      current += (current ? "\n\n" : "") + para;
    } else {
      if (current) chunks.push(current.trim());
      current = para;
    }
  }
  if (current) chunks.push(current.trim());

  // overlap stitch
  if (overlap > 0 && chunks.length > 1) {
    const stitched = [];
    for (let i = 0; i < chunks.length; i++) {
      let text = chunks[i];
      if (i > 0) {
        const prevTail = chunks[i - 1].slice(-overlap);
        text = prevTail + "\n" + text;
      }
      stitched.push(text);
    }
    return stitched;
  }
  return chunks;
}

async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);

  if (ext === ".md" || ext === ".txt" || ext === ".html" || ext === ".htm") {
    return buf.toString("utf-8");
  }

  if (ext === ".docx") {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: buf });
      return result.value;
    } catch (err) {
      return `[DOCX parse error: ${err.message}]`;
    }
  }

  // PDF / 其他：尝试用 pdftotext 或退化为文件名占位
  if (ext === ".pdf") {
    try {
      const { execSync } = await import("child_process");
      const text = execSync(`pdftotext "${filePath}" -`, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      return text;
    } catch {
      return `[PDF file: ${path.basename(filePath)} — 未安装 pdftotext，仅索引文件名]`;
    }
  }

  return `[Binary file: ${path.basename(filePath)}]`;
}

function getCollectionMetaPath(dataDir, collection) {
  return path.join(dataDir, `${collection}-chunks.json`);
}

function getCollectionDbPath(dataDir, collection) {
  return path.join(dataDir, `${collection}-vectors.json`);
}

function loadChunkMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return { nextId: 1, chunks: [] };
  }
}

function saveChunkMeta(metaPath, meta) {
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * 索引文件到指定集合
 */
export async function indexDocument({ filePath, collection, dataDir, chunkSize = 800, overlap = 100 }) {
  const rawText = await parseFile(filePath);
  const chunks = chunkText(rawText, chunkSize, overlap);

  const metaPath = getCollectionMetaPath(dataDir, collection);
  const dbPath = getCollectionDbPath(dataDir, collection);
  const meta = loadChunkMeta(metaPath);
  const retriever = createVectorRetriever({ type: "tfidf-local", dbPath });

  const indexedIds = [];
  for (const chunk of chunks) {
    const id = meta.nextId++;
    meta.chunks.push({
      id,
      text: chunk.slice(0, 2000),
      source: filePath,
      indexedAt: new Date().toISOString(),
    });
    await retriever.index(id, chunk, []);
    indexedIds.push(id);
  }

  saveChunkMeta(metaPath, meta);
  return { indexedIds, chunkCount: chunks.length };
}

/**
 * 查询集合
 */
export async function searchCollection({ query, collection, dataDir, topK = 5 }) {
  const metaPath = getCollectionMetaPath(dataDir, collection);
  const dbPath = getCollectionDbPath(dataDir, collection);
  const meta = loadChunkMeta(metaPath);
  const retriever = createVectorRetriever({ type: "tfidf-local", dbPath });

  const results = await retriever.search(query, topK);
  return results.map((r) => {
    const chunk = meta.chunks.find((c) => c.id === r.id);
    return {
      id: r.id,
      score: r.score,
      text: chunk?.text || "",
      source: chunk?.source || "",
    };
  });
}
