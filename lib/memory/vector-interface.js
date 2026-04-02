/**
 * vector-interface.js — 本地向量检索接口
 *
 * MVP 使用纯文件 sidecar 持久化确定性 token 向量，避免引入新的原生依赖。
 * 为了兼容先前的 sqlite-local 配置名，这里保留别名映射，但底层实现是同一个本地文件检索器。
 */

import fs from "fs";
import path from "path";

const DEFAULT_DIMENSION = 128;
const TOKEN_RE = /[A-Za-z][\w.-]*|[\u4e00-\u9fff]{2,8}/g;

function tokenize(text) {
  const matches = String(text || "").toLowerCase().match(TOKEN_RE) || [];
  return matches.filter((token) => token.length >= 2);
}

function hashToken(token, dims) {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % dims;
}

function buildVector(text, tags, dims) {
  const vector = new Float32Array(dims);
  const tokens = [
    ...tokenize(text),
    ...(Array.isArray(tags) ? tags.flatMap((tag) => tokenize(tag)) : []),
  ];

  for (const token of tokens) {
    const index = hashToken(token, dims);
    const weight = token.length > 6 ? 1.35 : token.length > 3 ? 1.1 : 1;
    vector[index] += weight;
  }

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
        if (!row || !Number.isInteger(Number(row.id)) || !Array.isArray(row.vector)) continue;
        this._rows.set(Number(row.id), row.vector.map((value) => Number(value) || 0));
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
    if (!Number.isInteger(Number(id))) return;
    this._rows.set(Number(id), buildVector(text, tags, this._dims));
    this._persist();
  }

  async remove(id) {
    this._rows.delete(Number(id));
    this._persist();
  }

  async clear() {
    this._rows.clear();
    this._persist();
  }

  async search(query, limit = 5) {
    const queryVector = buildVector(query, [], this._dims);
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

export { LocalVectorRetriever as SqliteVectorRetriever };

/**
 * 工厂函数 — 根据配置创建向量检索器。
 *
 * @param {object} [config]
 * @param {string} [config.type] - "null" | "local-file" | "sqlite-local"
 * @param {string} [config.dbPath] - 向量 sidecar 路径
 * @param {number} [config.dimensions] - 向量维度
 * @returns {NullVectorRetriever|LocalVectorRetriever}
 */
export function createVectorRetriever(config = {}) {
  const type = config.type || (config.dbPath ? "local-file" : "null");
  if ((type === "local-file" || type === "sqlite-local") && config.dbPath) {
    return new LocalVectorRetriever(config.dbPath, {
      dimensions: config.dimensions,
    });
  }
  return new NullVectorRetriever();
}
