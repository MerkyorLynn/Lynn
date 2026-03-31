/**
 * retriever.js — 混合检索器（HybridRetriever）
 *
 * 统一检索入口，合并标签匹配 + FTS5 全文搜索 + 向量搜索（预留），
 * 使用 TF-IDF 风格评分 + 时间衰减排序。
 *
 * 评分公式：
 *   score = tagScore × 2 + ftsScore × 1 + vectorScore × 1.5 + recencyBoost × timeDecay
 *
 * 时间衰减：
 *   timeDecay(age) = 0.5 ^ (age_days / 30)  — 30 天半衰期
 */

import { createVectorRetriever } from "./vector-interface.js";

/** 时间衰减半衰期（天） */
const HALF_LIFE_DAYS = 30;

/**
 * 计算时间衰减系数
 *
 * @param {string|null} createdAt - ISO 时间字符串
 * @returns {number} - 0 ~ 1 之间的衰减系数
 */
function timeDecay(createdAt) {
  if (!createdAt) return 0.5; // 无时间信息给中等权重

  try {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    const ageDays = Math.max(0, ageMs / (24 * 60 * 60 * 1000));
    return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  } catch {
    return 0.5;
  }
}

export class HybridRetriever {
  /**
   * @param {object} opts
   * @param {import('./fact-store.js').FactStore} opts.factStore
   * @param {object} [opts.vectorRetriever] - 可选向量检索器（默认 NullVectorRetriever）
   * @param {object} [opts.weights] - 自定义权重
   */
  constructor({ factStore, vectorRetriever, weights } = {}) {
    this._factStore = factStore;
    this._vectorRetriever = vectorRetriever || createVectorRetriever();
    this._weights = {
      tag: 2.0,
      fts: 1.0,
      vector: 1.5,
      recency: 0.5,
      ...weights,
    };
  }

  /**
   * 统一搜索入口
   *
   * @param {string[]} keywords - 搜索关键词
   * @param {number} [limit=5] - 最大返回数
   * @param {object} [opts] - 可选参数
   * @param {string} [opts.projectPath] - 项目路径过滤
   * @returns {Promise<Array<{ id, fact, tags, time, score }>>}
   */
  async search(keywords, limit = 5, opts = {}) {
    if (!keywords || keywords.length === 0) return [];
    if (!this._factStore || this._factStore.size === 0) return [];

    const scoreMap = new Map(); // id → { row, scores }

    // 1. 标签搜索
    try {
      const tagResults = this._factStore.searchByTags(keywords, undefined, limit * 3);
      for (const r of tagResults) {
        scoreMap.set(r.id, {
          row: r,
          tagScore: (r.matchCount || 1) / keywords.length, // 归一化
          ftsScore: 0,
          vectorScore: 0,
        });
      }
    } catch {}

    // 2. FTS 全文搜索
    try {
      const ftsQuery = keywords.join(" ");
      const ftsResults = this._factStore.searchFullText(ftsQuery, limit * 3);
      for (let i = 0; i < ftsResults.length; i++) {
        const r = ftsResults[i];
        const existing = scoreMap.get(r.id);
        // FTS 分数：基于排名位置的简单衰减
        const ftsScore = 1.0 / (1 + i * 0.3);
        if (existing) {
          existing.ftsScore = ftsScore;
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

    // 3. 向量搜索（如果可用）
    if (this._vectorRetriever.available) {
      try {
        const query = keywords.join(" ");
        const vecResults = await this._vectorRetriever.search(query, limit * 2);
        for (const { id, score } of vecResults) {
          const existing = scoreMap.get(id);
          if (existing) {
            existing.vectorScore = score;
          } else {
            // 需要从 factStore 获取完整行
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

    // 4. 计算综合分数
    const results = [];
    const w = this._weights;

    for (const [id, { row, tagScore, ftsScore, vectorScore }] of scoreMap) {
      const decay = timeDecay(row.created_at || row.time);
      const score =
        tagScore * w.tag +
        ftsScore * w.fts +
        vectorScore * w.vector +
        decay * w.recency;

      results.push({ ...row, score });
    }

    // 5. 按分数排序，取 top-N
    results.sort((a, b) => b.score - a.score);

    // 6. 项目路径过滤（如果支持）
    if (opts.projectPath) {
      const filtered = results.filter(r =>
        !r.project_path || r.project_path === opts.projectPath
      );
      // 如果过滤后结果不足，回退到全部结果
      if (filtered.length >= Math.min(limit, 2)) {
        return filtered.slice(0, limit);
      }
    }

    return results.slice(0, limit);
  }
}
