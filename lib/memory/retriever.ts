/**
 * retriever.js — 混合检索器（HybridRetriever）
 *
 * 统一检索入口，合并标签匹配 + FTS5 全文搜索 + 向量搜索，
 * 使用简单的加权评分和时间衰减排序。
 */

import { createVectorRetriever } from "./vector-interface.js";
import { isMemoryOutcomeFeedbackEnabled } from "./outcome-feedback.js";

const HALF_LIFE_DAYS = 30;
const DEFAULT_CATEGORY_BOOSTS = Object.freeze({
  pitfall: 2.4,
  task: 1.8,
  project_decision: 1.5,
  model_benchmark: 1.4,
  procedure: 1.2,
});

interface FactRow {
  id: string | number;
  fact: string;
  tags?: string[];
  category?: string;
  time?: string;
  created_at?: string;
  last_accessed_at?: string | null;
  importance_score?: number;
  hit_count?: number;
  harmful_count?: number;
  matchCount?: number;
  project_path?: string | null;
  [key: string]: unknown;
}

interface FactStoreLike {
  size: number;
  getAll: () => FactRow[];
  getById: (id: string | number) => FactRow | null | undefined;
  searchByTags: (keywords: string[], range?: unknown, limit?: number) => FactRow[];
  searchFullText: (query: string, limit?: number) => FactRow[];
  markAccessed: (ids: Array<string | number>) => void;
  registerChangeListener?: (listener: (event: FactStoreEvent) => void) => () => void;
}

interface FactStoreEvent {
  type: "add" | "delete" | "clear" | string;
  row?: FactRow;
  id?: string | number;
}

interface VectorSearchResult {
  id: string | number;
  score: number;
}

interface VectorRetrieverLike {
  available: boolean;
  search: (query: string, limit: number) => Promise<VectorSearchResult[]>;
  index: (id: string | number, text: string, tags: string[]) => Promise<unknown>;
  remove?: (id: string | number | undefined) => Promise<unknown>;
  clear?: () => Promise<void>;
  rebuildIndex?: (rows: Array<{ id: string | number; text: string; tags: string[] }>) => Promise<unknown>;
  close?: () => void;
}

interface HybridRetrieverWeights {
  tag: number;
  fts: number;
  vector: number;
  recency: number;
  importance: number;
  category: number;
}

interface HybridRetrieverOptions {
  factStore?: FactStoreLike;
  vectorRetriever?: VectorRetrieverLike;
  vectorConfig?: Record<string, unknown>;
  weights?: Partial<HybridRetrieverWeights>;
  categoryBoosts?: Record<string, number>;
}

interface HybridSearchOptions {
  preferredCategories?: string[];
  categoryBoosts?: Record<string, number>;
  projectPath?: string;
}

interface ScoredFact extends FactRow {
  tagScore: number;
  ftsScore: number;
  vectorScore: number;
  categoryBoost: number;
  harmfulPenalty: number;
  score: number;
}

interface ScoreEntry {
  row: FactRow;
  tagScore: number;
  ftsScore: number;
  vectorScore: number;
}

function timeDecay(createdAt: unknown): number {
  if (!createdAt) return 0.5;

  try {
    const ageMs = Date.now() - new Date(String(createdAt)).getTime();
    const ageDays = Math.max(0, ageMs / (24 * 60 * 60 * 1000));
    return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  } catch {
    return 0.5;
  }
}

function normalizeCategory(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function computeCategoryBoost(
  row: FactRow,
  preferredCategories: Set<string>,
  categoryBoosts: Record<string, number>,
): number {
  const category = normalizeCategory(row.category);
  let boost = categoryBoosts[category] || 0;
  if (preferredCategories.has(category)) boost += 1.2;
  return boost;
}

function computeHarmfulPenalty(row: FactRow): number {
  const count = Math.max(0, Number(row.harmful_count || 0));
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(3, Math.log1p(count) * 1.25);
}

function harmfulHideThreshold(): number {
  const value = Number(process.env.LYNN_MEMORY_HARMFUL_HIDE_THRESHOLD || 6);
  return Number.isFinite(value) ? Math.max(1, value) : 6;
}

export class HybridRetriever {
  private _factStore?: FactStoreLike;
  private _vectorRetriever: VectorRetrieverLike;
  private _categoryBoosts: Record<string, number>;
  private _weights: HybridRetrieverWeights;
  private _unsubscribeFactStore?: () => void;

  /**
   * @param {object} opts
   * @param {import('./fact-store.js').FactStore} opts.factStore
   * @param {object} [opts.vectorRetriever]
   * @param {object} [opts.vectorConfig]
   * @param {object} [opts.weights]
   * @param {Record<string, number>} [opts.categoryBoosts]
   */
  constructor({
    factStore,
    vectorRetriever,
    vectorConfig,
    weights,
    categoryBoosts,
  }: HybridRetrieverOptions = {}) {
    this._factStore = factStore;
    this._vectorRetriever = vectorRetriever || createVectorRetriever(vectorConfig || {}) as VectorRetrieverLike;
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
          void this._vectorRetriever.clear?.();
        }
      });
    }
  }

  async rebuildIndex(): Promise<void> {
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

  async search(keywords: string[], limit = 5, opts: HybridSearchOptions = {}): Promise<ScoredFact[]> {
    if (!keywords || keywords.length === 0) return [];
    if (!this._factStore || this._factStore.size === 0) return [];

    const scoreMap = new Map<string | number, ScoreEntry>();

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

    const results: ScoredFact[] = [];
    const feedbackEnabled = isMemoryOutcomeFeedbackEnabled();
    const w = this._weights;
    const preferredCategories = new Set((opts.preferredCategories || []).map(normalizeCategory));
    const categoryBoosts = {
      ...this._categoryBoosts,
      ...(opts.categoryBoosts || {}),
    };

    for (const [, { row, tagScore, ftsScore, vectorScore }] of scoreMap) {
      const harmfulCount = Math.max(0, Number(row.harmful_count || 0));
      if (feedbackEnabled && harmfulCount >= harmfulHideThreshold()) continue;

      const decay = timeDecay(row.last_accessed_at || row.created_at || row.time);
      const categoryBoost = computeCategoryBoost(row, preferredCategories, categoryBoosts);
      const harmfulPenalty = feedbackEnabled ? computeHarmfulPenalty(row) : 0;
      const score =
        tagScore * w.tag +
        ftsScore * w.fts +
        vectorScore * w.vector +
        decay * w.recency +
        (row.importance_score || 0) * w.importance +
        categoryBoost * w.category -
        harmfulPenalty;

      results.push({ ...row, tagScore, ftsScore, vectorScore, categoryBoost, harmfulPenalty, score });
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
    if (!feedbackEnabled && sliced.length > 0) {
      this._factStore.markAccessed(sliced.map((row) => row.id));
    }
    return sliced;
  }

  close() {
    this._unsubscribeFactStore?.();
    this._vectorRetriever?.close?.();
  }
}
