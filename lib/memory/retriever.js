/**
 * retriever.js — 混合检索器（HybridRetriever）
 *
 * 统一检索入口，合并标签匹配 + FTS5 全文搜索 + 向量搜索，
 * 使用简单的加权评分和时间衰减排序。
 */

import { createVectorRetriever } from "./vector-interface.js";

const HALF_LIFE_DAYS = 30;
const DEFAULT_CATEGORY_BOOSTS = Object.freeze({
  pitfall: 2.4,
  task: 1.8,
  project_decision: 1.5,
  model_benchmark: 1.4,
  procedure: 1.2,
});

function timeDecay(createdAt) {
  if (!createdAt) return 0.5;

  try {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    const ageDays = Math.max(0, ageMs / (24 * 60 * 60 * 1000));
    return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  } catch {
    return 0.5;
  }
}

function normalizeCategory(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function computeCategoryBoost(row, preferredCategories, categoryBoosts) {
  const category = normalizeCategory(row.category);
  let boost = categoryBoosts[category] || 0;
  if (preferredCategories.has(category)) boost += 1.2;
  return boost;
}

export class HybridRetriever {
  /**
   * @param {object} opts
   * @param {import('./fact-store.js').FactStore} opts.factStore
   * @param {object} [opts.vectorRetriever]
   * @param {object} [opts.vectorConfig]
   * @param {object} [opts.weights]
   * @param {Record<string, number>} [opts.categoryBoosts]
   */
  constructor({ factStore, vectorRetriever, vectorConfig, weights, categoryBoosts } = {}) {
    this._factStore = factStore;
    this._vectorRetriever = vectorRetriever || createVectorRetriever(vectorConfig || {});
    this._categoryBoosts = {
      ...DEFAULT_CATEGORY_BOOSTS,
      ...(categoryBoosts || {}),
    };
    this._weights = {
      tag: 2.0,
      fts: 1.0,
      vector: 1.5,
      recency: 0.5,
      importance: 0.2,
      category: 1.0,
      ...weights,
    };

    if (this._factStore?.registerChangeListener && this._vectorRetriever.available) {
      this._unsubscribeFactStore = this._factStore.registerChangeListener((event) => {
        if (event.type === "add" && event.row) {
          void this._vectorRetriever.index(event.row.id, event.row.fact, event.row.tags || []);
        } else if (event.type === "delete") {
          void this._vectorRetriever.remove?.(event.id);
        } else if (event.type === "clear") {
          // Simpler MVP: keep stale rows only if clearAll wasn't used heavily; callers can rebuild.
          // Clear all is rare and memory db is local. We still try to remove by reopening db when needed.
        }
      });
    }
  }

  async rebuildIndex() {
    if (!this._vectorRetriever.available || !this._factStore) return;
    const rows = this._factStore.getAll();
    if (typeof this._vectorRetriever.rebuildIndex === "function") {
      await this._vectorRetriever.rebuildIndex(rows.map((row) => ({
        id: row.id,
        text: row.fact,
        tags: row.tags || [],
      })));
      return;
    }
    for (const row of rows) {
      await this._vectorRetriever.index(row.id, row.fact, row.tags || []);
    }
  }

  async search(keywords, limit = 5, opts = {}) {
    if (!keywords || keywords.length === 0) return [];
    if (!this._factStore || this._factStore.size === 0) return [];

    const scoreMap = new Map();

    try {
      const tagResults = this._factStore.searchByTags(keywords, undefined, limit * 3);
      for (const r of tagResults) {
        scoreMap.set(r.id, {
          row: r,
          tagScore: (r.matchCount || 1) / keywords.length,
          ftsScore: 0,
          vectorScore: 0,
        });
      }
    } catch {}

    try {
      const ftsQuery = keywords.join(" ");
      const ftsResults = this._factStore.searchFullText(ftsQuery, limit * 3);
      for (let i = 0; i < ftsResults.length; i++) {
        const r = ftsResults[i];
        const existing = scoreMap.get(r.id);
        const ftsScore = 1.0 / (1 + i * 0.3);
        if (existing) {
          existing.ftsScore = Math.max(existing.ftsScore, ftsScore);
        } else {
          scoreMap.set(r.id, {
            row: r,
            tagScore: 0,
            ftsScore,
            vectorScore: 0,
          });
        }
      }
    } catch {}

    if (this._vectorRetriever.available) {
      try {
        const query = keywords.join(" ");
        const vecResults = await this._vectorRetriever.search(query, limit * 3);
        for (const { id, score } of vecResults) {
          const existing = scoreMap.get(id);
          if (existing) {
            existing.vectorScore = Math.max(existing.vectorScore, score);
          } else {
            const row = this._factStore.getById(id);
            if (row) {
              scoreMap.set(id, {
                row,
                tagScore: 0,
                ftsScore: 0,
                vectorScore: score,
              });
            }
          }
        }
      } catch {}
    }

    const results = [];
    const w = this._weights;
    const preferredCategories = new Set((opts.preferredCategories || []).map(normalizeCategory));
    const categoryBoosts = {
      ...this._categoryBoosts,
      ...(opts.categoryBoosts || {}),
    };

    for (const [, { row, tagScore, ftsScore, vectorScore }] of scoreMap) {
      const decay = timeDecay(row.last_accessed_at || row.created_at || row.time);
      const categoryBoost = computeCategoryBoost(row, preferredCategories, categoryBoosts);
      const score =
        tagScore * w.tag +
        ftsScore * w.fts +
        vectorScore * w.vector +
        decay * w.recency +
        (row.importance_score || 0) * w.importance +
        categoryBoost * w.category;

      results.push({ ...row, tagScore, ftsScore, vectorScore, categoryBoost, score });
    }

    results.sort((a, b) => b.score - a.score);

    let finalResults = results;
    if (opts.projectPath) {
      const filtered = results.filter((r) => !r.project_path || r.project_path === opts.projectPath);
      if (filtered.length >= Math.min(limit, 2)) {
        finalResults = filtered;
      }
    }

    const sliced = finalResults.slice(0, limit);
    if (sliced.length > 0) {
      this._factStore.markAccessed(sliced.map((row) => row.id));
    }
    return sliced;
  }

  close() {
    this._unsubscribeFactStore?.();
    this._vectorRetriever?.close?.();
  }
}
