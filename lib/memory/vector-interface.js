/**
 * vector-interface.js — 本地向量检索接口
 *
 * 当前支持两类本地 sidecar：
 * - local-file / sqlite-local: 旧版确定性 hash 词袋向量
 * - tfidf-local: 基于 TF-IDF 的本地语义近似向量（更适合记忆检索）
 */

import fs from "fs";
import path from "path";

const DEFAULT_DIMENSION = 128;
const DEFAULT_TFIDF_DIMENSION = 256;
const TOKEN_RE = /[A-Za-z][\w.-]*|[\u4e00-\u9fff]{2,8}/g;

function tokenize(text) {
  const matches = String(text || "").toLowerCase().match(TOKEN_RE) || [];
  return matches.filter((token) => token.length >= 2);
}

function normalizeTags(tags) {
  return Array.isArray(tags) ? tags.filter(Boolean) : [];
}

function tokensForEntry(text, tags = []) {
  return [
    ...tokenize(text),
    ...normalizeTags(tags).flatMap((tag) => tokenize(tag)),
  ];
}

function hashToken(token, dims) {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % dims;
}

function normalizeVector(vector) {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= norm;
    }
  }
  return Array.from(vector);
}

function buildHashedVector(text, tags, dims) {
  const vector = new Float32Array(dims);
  const tokens = tokensForEntry(text, tags);

  for (const token of tokens) {
    const index = hashToken(token, dims);
    const weight = token.length > 6 ? 1.35 : token.length > 3 ? 1.1 : 1;
    vector[index] += weight;
  }

  return normalizeVector(vector);
}

function buildTfIdfVector(tokens, dims, idfMap, docCount) {
  const vector = new Float32Array(dims);
  if (!tokens || tokens.length === 0) return Array.from(vector);

  const tf = new Map();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }

  for (const [token, count] of tf.entries()) {
    const idf = idfMap.get(token) ?? Math.log(docCount + 1);
    const tfidf = (1 + Math.log(count)) * Math.max(idf, 0.05);
    const index = hashToken(token, dims);
    vector[index] += tfidf;
  }

  return normalizeVector(vector);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function isValidId(value) {
  return Number.isInteger(Number(value));
}

function toNormalizedId(value) {
  return Number(value);
}

export class NullVectorRetriever {
  get available() { return false; }

  async search(_query, _limit) {
    return [];
  }

  async index(_id, _text, _tags) {
    // no-op
  }

  async remove(_id) {
    // no-op
  }

  async clear() {
    // no-op
  }

  async rebuildIndex(_rows = []) {
    // no-op
  }

  close() {
    // no-op
  }
}

export class LocalVectorRetriever {
  constructor(dbPath, opts = {}) {
    this._dbPath = dbPath;
    this._dims = Number.isInteger(opts.dimensions) && opts.dimensions > 0
      ? opts.dimensions
      : DEFAULT_DIMENSION;
    this._rows = new Map();

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this._load();
  }

  get available() {
    return true;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._dbPath, "utf8"));
      if (!Array.isArray(raw?.rows)) return;
      for (const row of raw.rows) {
        if (!row || !isValidId(row.id) || !Array.isArray(row.vector)) continue;
        this._rows.set(toNormalizedId(row.id), row.vector.map((value) => Number(value) || 0));
      }
    } catch {
      // file missing or invalid -> start empty
    }
  }

  _persist() {
    const rows = Array.from(this._rows.entries()).map(([id, vector]) => ({ id, vector }));
    atomicWriteJson(this._dbPath, {
      version: 1,
      dimensions: this._dims,
      updatedAt: new Date().toISOString(),
      rows,
    });
  }

  async index(id, text, tags = []) {
    if (!isValidId(id)) return;
    this._rows.set(toNormalizedId(id), buildHashedVector(text, tags, this._dims));
    this._persist();
  }

  async rebuildIndex(rows = []) {
    this._rows.clear();
    for (const row of rows) {
      if (!isValidId(row?.id)) continue;
      this._rows.set(
        toNormalizedId(row.id),
        buildHashedVector(row.text || row.fact || "", row.tags || [], this._dims),
      );
    }
    this._persist();
  }

  async remove(id) {
    this._rows.delete(toNormalizedId(id));
    this._persist();
  }

  async clear() {
    this._rows.clear();
    this._persist();
  }

  async search(query, limit = 5) {
    const queryVector = buildHashedVector(query, [], this._dims);
    const scored = Array.from(this._rows.entries())
      .map(([id, vector]) => ({ id, score: cosineSimilarity(queryVector, vector) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
  }

  close() {
    // no-op
  }
}

export class TfIdfVectorRetriever {
  constructor(dbPath, opts = {}) {
    this._dbPath = dbPath;
    this._dims = Number.isInteger(opts.dimensions) && opts.dimensions > 0
      ? opts.dimensions
      : DEFAULT_TFIDF_DIMENSION;
    this._rows = new Map();
    this._idf = new Map();
    this._docCount = 0;

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this._load();
  }

  get available() {
    return true;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._dbPath, "utf8"));
      if (!Array.isArray(raw?.rows)) return;
      for (const row of raw.rows) {
        if (!row || !isValidId(row.id)) continue;
        this._rows.set(toNormalizedId(row.id), {
          text: String(row.text || ""),
          tags: normalizeTags(row.tags),
          vector: Array.isArray(row.vector) ? row.vector.map((value) => Number(value) || 0) : [],
        });
      }
      this._rebuildIdf();
    } catch {
      // file missing or invalid -> start empty
    }
  }

  _persist() {
    const rows = Array.from(this._rows.entries()).map(([id, row]) => ({
      id,
      text: row.text,
      tags: row.tags,
      vector: row.vector,
    }));
    atomicWriteJson(this._dbPath, {
      version: 2,
      algorithm: "tfidf-local",
      dimensions: this._dims,
      updatedAt: new Date().toISOString(),
      rows,
    });
  }

  _rebuildIdf() {
    const docFreq = new Map();
    this._docCount = this._rows.size;
    for (const row of this._rows.values()) {
      const uniqueTokens = new Set(tokensForEntry(row.text, row.tags));
      for (const token of uniqueTokens) {
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
      }
    }
    this._idf.clear();
    for (const [token, freq] of docFreq.entries()) {
      this._idf.set(token, Math.log((this._docCount + 1) / (freq + 1)));
    }
  }

  _rebuildVectors() {
    for (const row of this._rows.values()) {
      row.vector = buildTfIdfVector(
        tokensForEntry(row.text, row.tags),
        this._dims,
        this._idf,
        this._docCount,
      );
    }
  }

  async rebuildIndex(rows = null) {
    if (Array.isArray(rows)) {
      this._rows.clear();
      for (const row of rows) {
        if (!isValidId(row?.id)) continue;
        this._rows.set(toNormalizedId(row.id), {
          text: String(row.text || row.fact || ""),
          tags: normalizeTags(row.tags),
          vector: [],
        });
      }
    }
    this._rebuildIdf();
    this._rebuildVectors();
    this._persist();
  }

  async index(id, text, tags = []) {
    if (!isValidId(id)) return;
    this._rows.set(toNormalizedId(id), {
      text: String(text || ""),
      tags: normalizeTags(tags),
      vector: [],
    });
    await this.rebuildIndex();
  }

  async remove(id) {
    this._rows.delete(toNormalizedId(id));
    await this.rebuildIndex();
  }

  async clear() {
    this._rows.clear();
    this._idf.clear();
    this._docCount = 0;
    this._persist();
  }

  async search(query, limit = 5) {
    const queryVector = buildTfIdfVector(
      tokenize(query),
      this._dims,
      this._idf,
      Math.max(this._docCount, 1),
    );
    const scored = Array.from(this._rows.entries())
      .map(([id, row]) => ({ id, score: cosineSimilarity(queryVector, row.vector) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
  }

  close() {
    // no-op
  }
}

export { LocalVectorRetriever as SqliteVectorRetriever };

/**
 * 工厂函数 — 根据配置创建向量检索器。
 *
 * @param {object} [config]
 * @param {string} [config.type] - "null" | "local-file" | "sqlite-local" | "tfidf-local"
 * @param {string} [config.dbPath] - 向量 sidecar 路径
 * @param {number} [config.dimensions] - 向量维度
 * @returns {NullVectorRetriever|LocalVectorRetriever|TfIdfVectorRetriever}
 */
export function createVectorRetriever(config = {}) {
  const type = config.type || (config.dbPath ? "local-file" : "null");
  if (type === "tfidf-local" && config.dbPath) {
    return new TfIdfVectorRetriever(config.dbPath, {
      dimensions: config.dimensions,
    });
  }
  if ((type === "local-file" || type === "sqlite-local") && config.dbPath) {
    return new LocalVectorRetriever(config.dbPath, {
      dimensions: config.dimensions,
    });
  }
  return new NullVectorRetriever();
}
