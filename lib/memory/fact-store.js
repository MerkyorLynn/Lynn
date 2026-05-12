/**
 * fact-store.js — 深度记忆存储（元事实 + 标签）
 *
 * v2 记忆系统的 archival 层。每条记忆是一个"元事实"，
 * 附带标签和时间，通过标签匹配 + FTS5 全文搜索检索。
 *
 * Phase 4: 增加 importance / hit_count / project_path / source 元数据，
 * 为混合检索与增量保留提供基础。
 *
 * Phase 5: 增加 category / confidence / evidence，
 * 为结构化记忆与可解释展示提供基础。
 */

import Database from "better-sqlite3";
import { scrubPII } from "../pii-guard.js";

/**
 * 当前 schema 版本。每次改表结构时递增，
 * 并在 _migrate() 里添加对应的迁移逻辑。
 */
const SCHEMA_VERSION = 5;
export const DEFAULT_MEMORY_CATEGORY = "other";
export const MEMORY_CATEGORIES = Object.freeze([
  "person",
  "project",
  "preference",
  "tech",
  "event",
  "task",
  "pitfall",
  "model_benchmark",
  "project_decision",
  "procedure",
  DEFAULT_MEMORY_CATEGORY,
]);
export const HIGH_PRIORITY_MEMORY_CATEGORIES = Object.freeze([
  "pitfall",
  "task",
  "project_decision",
  "model_benchmark",
  "procedure",
]);

const DEFAULT_CATEGORY = DEFAULT_MEMORY_CATEGORY;
const ALLOWED_CATEGORIES = new Set(MEMORY_CATEGORIES);
const CATEGORY_ALIASES = new Map([
  ["bug", "pitfall"],
  ["failure", "pitfall"],
  ["lesson", "pitfall"],
  ["lessons", "pitfall"],
  ["gotcha", "pitfall"],
  ["benchmark", "model_benchmark"],
  ["model", "model_benchmark"],
  ["perf", "model_benchmark"],
  ["performance", "model_benchmark"],
  ["decision", "project_decision"],
  ["adr", "project_decision"],
  ["runbook", "procedure"],
  ["playbook", "procedure"],
  ["workflow", "procedure"],
  ["todo", "task"],
]);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clampConfidence(value) {
  if (!isFiniteNumber(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function normalizeCategory(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  const aliased = CATEGORY_ALIASES.get(normalized) || normalized;
  return ALLOWED_CATEGORIES.has(aliased) ? aliased : DEFAULT_CATEGORY;
}

function inferCategoryFromContent(fact, tags = []) {
  const haystack = `${fact || ""} ${(tags || []).join(" ")}`.toLowerCase();
  if (/(踩坑|坑点|教训|误区|bug|故障|失败|回归|超时|卡死|崩溃|不兼容|timeout|regression|failure|failed|broken|hang|stuck)/.test(haystack)) return "pitfall";
  if (/(当前任务|下一步|待办|进行中|阻塞|计划|收尾|todo|next step|in progress|blocked|active task)/.test(haystack)) return "task";
  if (/(吞吐|门禁|基准|测速|压测|并发|tok\/s|tokens\/s|t\/s|benchmark|v8|mtp|nvfp4|fp4|fp8|qwen|deepseek|spark|dgx)/.test(haystack)) return "model_benchmark";
  if (/(决定|决策|取舍|采用|弃用|保留|迁移|改成|架构选择|adr|decision)/.test(haystack)) return "project_decision";
  if (/(流程|步骤|操作手册|排障|复现|命令|runbook|playbook|procedure|workflow)/.test(haystack)) return "procedure";
  if (/(用户|名字|姓名|朋友|家人|人物|person|name|user)/.test(haystack)) return "person";
  if (/(项目|仓库|repo|lynn|openhanako|roadmap|milestone|交付|project)/.test(haystack)) return "project";
  if (/(喜欢|偏好|习惯|讨厌|风格|颜色|warm|theme|prefer|preference)/.test(haystack)) return "preference";
  if (/(react|typescript|node|sqlite|electron|模型|工具|技能|技术|tech|api|llm)/.test(haystack)) return "tech";
  if (/(决定|改成|迁移|上线|发布|修复|发生|事件|决策|event|decision)/.test(haystack)) return "event";
  return DEFAULT_CATEGORY;
}

function normalizeRelation(value) {
  const normalized = String(value || "related_to")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (["related_to", "uses", "belongs_to", "caused_by"].includes(normalized)) {
    return normalized;
  }
  return "related_to";
}

export class FactStore {
  /**
   * @param {string} dbPath - facts.db 的路径
   * @param {{ baseImportance?: number, hitBonus?: number, compileThreshold?: number }} [opts]
   */
  constructor(dbPath, opts = {}) {
    this.dbPath = dbPath;
    this.baseImportance = isFiniteNumber(opts.baseImportance) ? opts.baseImportance : 10;
    this.hitBonus = isFiniteNumber(opts.hitBonus) ? opts.hitBonus : 1;
    this.compileThreshold = isFiniteNumber(opts.compileThreshold) ? opts.compileThreshold : 4.5;
    this._changeListeners = new Set();

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -16000");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("mmap_size = 30000000");
    this._initSchema();
    this._migrate();
    this._ensureDerivedIndexes();
    this._prepareStatements();
    this._tagSearchCache = new Map();

    // Periodic WAL checkpoint to prevent unbounded WAL growth.
    this._walTimer = setInterval(() => {
      try { this.db.pragma("wal_checkpoint(PASSIVE)"); } catch {}
    }, 3600_000);
    if (this._walTimer.unref) this._walTimer.unref();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        fact             TEXT NOT NULL,
        tags             TEXT NOT NULL DEFAULT '[]',
        time             TEXT,
        session_id       TEXT,
        created_at       TEXT NOT NULL,
        source           TEXT,
        project_path     TEXT,
        importance_score REAL NOT NULL DEFAULT 0,
        hit_count        INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT,
        category         TEXT NOT NULL DEFAULT 'other',
        confidence       REAL NOT NULL DEFAULT 0.5,
        evidence         TEXT
      );
    `);
    this._ensureBaseIndexes();

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fact_links (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id    INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        to_id      INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        relation   TEXT NOT NULL DEFAULT 'related_to',
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_links_unique ON fact_links(from_id, to_id, relation);
      CREATE INDEX IF NOT EXISTS idx_fact_links_from ON fact_links(from_id);
      CREATE INDEX IF NOT EXISTS idx_fact_links_to ON fact_links(to_id);
    `);

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE facts_fts USING fts5(
          fact,
          content=facts,
          content_rowid=id,
          tokenize='unicode61'
        );
      `);
    } catch {
      // 表已存在
    }

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, fact) VALUES (new.id, new.fact);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
        INSERT INTO facts_fts(rowid, fact) VALUES (new.id, new.fact);
      END;
    `);
  }

  _ensureBaseIndexes() {
    if (this._hasColumn("facts", "time")) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_time ON facts(time)");
    }
    if (this._hasColumn("facts", "session_id")) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id)");
    }
    if (this._hasColumn("facts", "created_at")) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at)");
    }
    if (this._hasColumns("facts", ["time", "session_id"])) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_time_session ON facts(time, session_id)");
    }
  }

  _migrate() {
    const current = this.db.pragma("user_version", { simple: true });
    if (current >= SCHEMA_VERSION) return;

    this.db.transaction(() => {
      let v = current;
      while (v < SCHEMA_VERSION) {
        switch (v) {
          case 0:
            // v0 → v1：初始 schema 标记（无实际变更，仅打版本戳）
            break;
          case 1:
            // v1 → v2：增加 source 和 project_path 列（Phase 4 增强检索）
            if (!this._hasColumn("facts", "source")) {
              this.db.exec("ALTER TABLE facts ADD COLUMN source TEXT");
            }
            if (!this._hasColumn("facts", "project_path")) {
              this.db.exec("ALTER TABLE facts ADD COLUMN project_path TEXT");
            }
            this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project_path)");
            break;
          case 2:
            // v2 → v3：重要度分数 / 命中计数 / 最近访问时间
            if (!this._hasColumn("facts", "importance_score")) {
              this.db.exec("ALTER TABLE facts ADD COLUMN importance_score REAL NOT NULL DEFAULT 0");
            }
            if (!this._hasColumn("facts", "hit_count")) {
              this.db.exec("ALTER TABLE facts ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0");
            }
            if (!this._hasColumn("facts", "last_accessed_at")) {
              this.db.exec("ALTER TABLE facts ADD COLUMN last_accessed_at TEXT");
            }
            this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_importance ON facts(importance_score DESC)");
            this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_last_accessed ON facts(last_accessed_at DESC)");
            break;
          case 3:
            // v3 → v4：结构化记忆字段
            if (!this._hasColumn("facts", "category")) {
              this.db.exec(`ALTER TABLE facts ADD COLUMN category TEXT NOT NULL DEFAULT '${DEFAULT_CATEGORY}'`);
            }
            if (!this._hasColumn("facts", "confidence")) {
              this.db.exec("ALTER TABLE facts ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5");
            }
            if (!this._hasColumn("facts", "evidence")) {
              this.db.exec("ALTER TABLE facts ADD COLUMN evidence TEXT");
            }
            this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category)");
            this._backfillStructuredFields();
            break;
          case 4:
            this._ensureFactLinksTable();
            break;
        }
        v++;
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();

    console.log(`[FactStore] schema migrated: v${current} → v${SCHEMA_VERSION}`);
  }

  _ensureDerivedIndexes() {
    this._ensureBaseIndexes();
    if (this._hasColumn("facts", "project_path")) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project_path)");
    }
    if (this._hasColumn("facts", "importance_score")) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_importance ON facts(importance_score DESC)");
    }
    if (this._hasColumn("facts", "last_accessed_at")) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_last_accessed ON facts(last_accessed_at DESC)");
    }
    if (this._hasColumn("facts", "category")) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category)");
    }
  }

  _prepareStatements() {
    this._stmts = {
      insert: this.db.prepare(`
        INSERT INTO facts (
          fact, tags, time, session_id, created_at,
          source, project_path, importance_score, hit_count, last_accessed_at,
          category, confidence, evidence
        )
        VALUES (
          @fact, @tags, @time, @sessionId, @createdAt,
          @source, @projectPath, @importanceScore, @hitCount, @lastAccessedAt,
          @category, @confidence, @evidence
        )
      `),
      getAll: this.db.prepare(`SELECT * FROM facts ORDER BY time DESC`),
      getById: this.db.prepare(`SELECT * FROM facts WHERE id = ?`),
      getBySession: this.db.prepare(`SELECT * FROM facts WHERE session_id = ? ORDER BY time DESC`),
      getImportant: this.db.prepare(`
        SELECT * FROM facts
        WHERE importance_score >= ?
        ORDER BY importance_score DESC, COALESCE(last_accessed_at, created_at) DESC
        LIMIT ?
      `),
      count: this.db.prepare(`SELECT COUNT(*) as cnt FROM facts`),
      deleteById: this.db.prepare(`DELETE FROM facts WHERE id = ?`),
      deleteAll: this.db.prepare(`DELETE FROM facts`),
      touchFact: this.db.prepare(`
        UPDATE facts
        SET
          hit_count = COALESCE(hit_count, 0) + @increment,
          importance_score = COALESCE(importance_score, 0) + @importanceDelta,
          last_accessed_at = @lastAccessedAt
        WHERE id = @id
      `),
      updateFact: this.db.prepare(`
        UPDATE facts
        SET
          category = COALESCE(@category, category),
          confidence = COALESCE(@confidence, confidence),
          evidence = CASE
            WHEN @evidenceSet = 1 THEN @evidence
            ELSE evidence
          END
        WHERE id = @id
      `),
      ftsSearch: this.db.prepare(`
        SELECT f.*, rank
        FROM facts_fts fts
        JOIN facts f ON f.id = fts.rowid
        WHERE facts_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `),
      getByCategory: this.db.prepare(`
        SELECT *
        FROM facts
        WHERE category = ?
        ORDER BY COALESCE(last_accessed_at, time, created_at) DESC
        LIMIT ?
      `),
      insertLink: this.db.prepare(`
        INSERT OR IGNORE INTO fact_links (from_id, to_id, relation, created_at)
        VALUES (@fromId, @toId, @relation, @createdAt)
      `),
      getLinksForFactIds: this.db.prepare(`
        SELECT
          fl.id,
          fl.from_id,
          fl.to_id,
          fl.relation,
          fl.created_at,
          f.fact AS related_fact,
          f.category AS related_category,
          f.confidence AS related_confidence
        FROM fact_links fl
        JOIN facts f ON f.id = fl.to_id
        WHERE fl.from_id IN (SELECT value FROM json_each(?))
        ORDER BY fl.created_at DESC
      `),
    };
  }

  registerChangeListener(listener) {
    if (typeof listener !== "function") return () => {};
    this._changeListeners.add(listener);
    return () => this._changeListeners.delete(listener);
  }

  _emitChange(event) {
    for (const listener of this._changeListeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn(`[FactStore] change listener failed: ${err?.message || err}`);
      }
    }
  }

  add(entry) {
    const { cleaned, detected } = scrubPII(entry.fact);
    if (detected.length > 0) {
      console.warn(`[FactStore] PII detected (${detected.join(", ")}), redacted before storage`);
    }

    const now = new Date().toISOString();
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    const row = {
      fact: cleaned,
      tags,
      time: entry.time || null,
      session_id: entry.session_id || null,
      created_at: now,
      source: entry.source || null,
      project_path: entry.project_path || null,
      importance_score: isFiniteNumber(entry.importance_score) ? entry.importance_score : this.baseImportance,
      hit_count: isFiniteNumber(entry.hit_count) ? entry.hit_count : 0,
      last_accessed_at: entry.last_accessed_at || null,
      category: normalizeCategory(entry.category || inferCategoryFromContent(cleaned, tags)),
      confidence: clampConfidence(entry.confidence),
      evidence: typeof entry.evidence === "string" && entry.evidence.trim()
        ? entry.evidence.trim().slice(0, 500)
        : null,
    };

    const result = this._stmts.insert.run({
      fact: row.fact,
      tags: JSON.stringify(tags),
      time: row.time,
      sessionId: row.session_id,
      createdAt: row.created_at,
      source: row.source,
      projectPath: row.project_path,
      importanceScore: row.importance_score,
      hitCount: row.hit_count,
      lastAccessedAt: row.last_accessed_at,
      category: row.category,
      confidence: row.confidence,
      evidence: row.evidence,
    });

    const id = Number(result.lastInsertRowid);
    this._emitChange({ type: "add", row: { id, ...row } });
    return { id };
  }

  searchByCategory(category, limit = 20) {
    const normalized = normalizeCategory(category);
    const rows = this._stmts.getByCategory.all(normalized, limit);
    return rows.map((row) => this._rowToFact(row));
  }

  addLink(fromId, toId, relation = "related_to") {
    const normalizedFrom = Number(fromId);
    const normalizedTo = Number(toId);
    if (!Number.isInteger(normalizedFrom) || !Number.isInteger(normalizedTo)) return false;
    if (normalizedFrom === normalizedTo) return false;
    const result = this._stmts.insertLink.run({
      fromId: normalizedFrom,
      toId: normalizedTo,
      relation: normalizeRelation(relation),
      createdAt: new Date().toISOString(),
    });
    return result.changes > 0;
  }

  getRelatedFacts(ids) {
    const normalizedIds = [...new Set((ids || []).filter((id) => Number.isInteger(id) || /^[0-9]+$/.test(String(id))).map((id) => Number(id)))];
    if (normalizedIds.length === 0) return new Map();

    const rows = this._stmts.getLinksForFactIds.all(JSON.stringify(normalizedIds));
    const map = new Map();
    for (const row of rows) {
      const key = Number(row.from_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({
        id: row.id,
        to_id: Number(row.to_id),
        relation: row.relation,
        fact: row.related_fact,
        category: normalizeCategory(row.related_category),
        confidence: clampConfidence(row.related_confidence),
        created_at: row.created_at,
      });
    }
    return map;
  }

  addBatch(entries) {
    const run = this.db.transaction(() => {
      for (const entry of entries) {
        this.add(entry);
      }
    });
    run();
    return entries.length;
  }

  searchByTags(queryTags, dateRange, limit = 20) {
    if (!queryTags || queryTags.length === 0) return [];

    const stmt = this._getTagSearchStmt(queryTags.length, dateRange);
    const params = { limit };
    for (let i = 0; i < queryTags.length; i++) {
      params[`tag${i}`] = queryTags[i];
    }
    if (dateRange?.from) params.dateFrom = dateRange.from;
    if (dateRange?.to) params.dateTo = dateRange.to;

    const rows = stmt.all(params);
    return rows.map((row) => this._rowToFact(row));
  }

  _getTagSearchStmt(tagCount, dateRange) {
    const dateKey = (dateRange?.from ? 1 : 0) | (dateRange?.to ? 2 : 0);
    const cacheKey = `${tagCount}:${dateKey}`;

    let stmt = this._tagSearchCache.get(cacheKey);
    if (stmt) return stmt;

    const placeholders = Array.from({ length: tagCount }, (_, i) => `@tag${i}`).join(", ");
    let dateWhere = "";
    if (dateKey & 1) dateWhere += ` AND f.time >= @dateFrom`;
    if (dateKey & 2) dateWhere += ` AND f.time <= @dateTo`;

    const sql = `
      SELECT f.*, COUNT(DISTINCT je.value) as matchCount
      FROM facts f, json_each(f.tags) je
      WHERE je.value IN (${placeholders})${dateWhere}
      GROUP BY f.id
      ORDER BY matchCount DESC, f.time DESC
      LIMIT @limit
    `;

    stmt = this.db.prepare(sql);
    if (this._tagSearchCache.size >= 200) {
      const firstKey = this._tagSearchCache.keys().next().value;
      this._tagSearchCache.delete(firstKey);
    }
    this._tagSearchCache.set(cacheKey, stmt);
    return stmt;
  }

  searchFullText(query, limit = 20) {
    if (!query || !query.trim()) return [];

    try {
      const ftsQuery = query
        .trim()
        .split(/\s+/)
        .map((w) => `"${w.replace(/"/g, '""')}"`)
        .join(" OR ");

      const rows = this._stmts.ftsSearch.all(ftsQuery, limit);
      return rows.map((row) => this._rowToFact(row));
    } catch {
      return this._likeFallback(query, limit);
    }
  }

  _likeFallback(query, limit) {
    const rows = this.db
      .prepare(`SELECT * FROM facts WHERE fact LIKE '%' || ? || '%' ORDER BY time DESC LIMIT ?`)
      .all(query, limit);
    return rows.map((row) => this._rowToFact(row));
  }

  getAll() {
    return this._stmts.getAll.all().map((row) => this._rowToFact(row));
  }

  getBySession(sessionId) {
    return this._stmts.getBySession.all(sessionId).map((row) => this._rowToFact(row));
  }

  getById(id) {
    const row = this._stmts.getById.get(id);
    return row ? this._rowToFact(row) : null;
  }

  getImportantFacts({ limit = 20, minImportance = this.compileThreshold } = {}) {
    return this._stmts.getImportant
      .all(minImportance, limit)
      .map((row) => this._rowToFact(row));
  }

  markAccessed(ids, opts = {}) {
    const normalizedIds = [...new Set((ids || []).filter((id) => Number.isInteger(id) || /^[0-9]+$/.test(String(id))).map((id) => Number(id)))];
    if (normalizedIds.length === 0) return 0;

    const increment = isFiniteNumber(opts.increment) ? opts.increment : 1;
    const importanceDelta = isFiniteNumber(opts.importanceDelta) ? opts.importanceDelta : this.hitBonus;
    const lastAccessedAt = opts.at || new Date().toISOString();

    const run = this.db.transaction(() => {
      let touched = 0;
      for (const id of normalizedIds) {
        touched += this._stmts.touchFact.run({
          id,
          increment,
          importanceDelta,
          lastAccessedAt,
        }).changes;
      }
      return touched;
    });

    const touched = run();
    if (touched > 0) {
      this._emitChange({ type: "access", ids: normalizedIds, at: lastAccessedAt });
    }
    return touched;
  }

  get size() {
    return this._stmts.count.get().cnt;
  }

  delete(id) {
    const changed = this._stmts.deleteById.run(id).changes > 0;
    if (changed) this._emitChange({ type: "delete", id: Number(id) });
    return changed;
  }

  updateFact(id, updates = {}) {
    const payload = {
      id: Number(id),
      category: Object.prototype.hasOwnProperty.call(updates, "category")
        ? normalizeCategory(updates.category)
        : null,
      confidence: Object.prototype.hasOwnProperty.call(updates, "confidence")
        ? clampConfidence(updates.confidence)
        : null,
      evidenceSet: Object.prototype.hasOwnProperty.call(updates, "evidence") ? 1 : 0,
      evidence: Object.prototype.hasOwnProperty.call(updates, "evidence")
        ? (typeof updates.evidence === "string" && updates.evidence.trim()
          ? updates.evidence.trim().slice(0, 500)
          : null)
        : null,
    };

    const changed = this._stmts.updateFact.run(payload).changes > 0;
    if (changed) {
      this._emitChange({ type: "update", id: Number(id), updates: payload });
      return this.getById(Number(id));
    }
    return null;
  }

  clearAll() {
    this.db.transaction(() => {
      this._stmts.deleteAll.run();
      this.db.exec("INSERT INTO facts_fts(facts_fts) VALUES ('rebuild')");
    })();
    this._emitChange({ type: "clear" });
  }

  exportAll() {
    return this.getAll();
  }

  importAll(entries) {
    const run = this.db.transaction(() => {
      for (const entry of entries) {
        this.add({
          fact: entry.fact,
          tags: entry.tags || [],
          time: entry.time || null,
          session_id: entry.session_id || null,
          source: entry.source || null,
          project_path: entry.project_path || null,
          importance_score: entry.importance_score,
          hit_count: entry.hit_count,
          last_accessed_at: entry.last_accessed_at || null,
          category: entry.category || null,
          confidence: entry.confidence,
          evidence: entry.evidence || null,
        });
      }
    });
    run();
  }

  close() {
    if (this._walTimer) { clearInterval(this._walTimer); this._walTimer = null; }
    try { this.db?.pragma?.("wal_checkpoint(TRUNCATE)"); } catch {}
    for (const stmt of this._tagSearchCache.values()) {
      try { stmt.finalize?.(); } catch {}
    }
    this._tagSearchCache.clear();
    this._changeListeners.clear();
    if (this.db?.open) this.db.close();
  }

  searchCombined(keywords, limit = 5) {
    if (!keywords || keywords.length === 0) return [];

    const seenIds = new Set();
    const scored = [];

    try {
      const tagResults = this.searchByTags(keywords, undefined, limit * 2);
      for (const r of tagResults) {
        seenIds.add(r.id);
        scored.push({ row: r, score: (r.matchCount || 1) * 2 + (r.importance_score || 0) * 0.1 });
      }
    } catch {}

    if (scored.length < 2) {
      const ftsQuery = keywords.join(" ");
      try {
        const ftsResults = this.searchFullText(ftsQuery, limit * 2);
        for (const r of ftsResults) {
          if (seenIds.has(r.id)) continue;
          seenIds.add(r.id);
          scored.push({ row: r, score: 1 + (r.importance_score || 0) * 0.1 });
        }
      } catch {}
    }

    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, limit).map((s) => s.row);
    if (results.length > 0) this.markAccessed(results.map((row) => row.id));
    return results;
  }

  searchByProject(projectPath, keywords, limit = 10) {
    const hasProjectColumn = this._hasColumn("facts", "project_path");
    if (!hasProjectColumn || !projectPath) {
      return this.searchCombined(keywords, limit);
    }

    try {
      const stmt = this.db.prepare(`
        SELECT f.*, COUNT(DISTINCT je.value) as matchCount
        FROM facts f, json_each(f.tags) je
        WHERE je.value IN (${keywords.map(() => "?").join(", ")})
          AND f.project_path = ?
        GROUP BY f.id
        ORDER BY matchCount DESC, f.time DESC
        LIMIT ?
      `);
      const rows = stmt.all(...keywords, projectPath, limit);
      const results = rows.map(row => this._rowToFact(row));
      if (results.length > 0) this.markAccessed(results.map((row) => row.id));
      return results;
    } catch {
      return this.searchCombined(keywords, limit);
    }
  }

  _hasColumn(table, column) {
    try {
      const cols = this.db.pragma(`table_info(${table})`);
      return cols.some(c => c.name === column);
    } catch {
      return false;
    }
  }

  _hasColumns(table, columns) {
    try {
      const existing = new Set(this.db.pragma(`table_info(${table})`).map((c) => c.name));
      return columns.every((column) => existing.has(column));
    } catch {
      return false;
    }
  }

  _ensureFactLinksTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fact_links (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id    INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        to_id      INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        relation   TEXT NOT NULL DEFAULT 'related_to',
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_links_unique ON fact_links(from_id, to_id, relation);
      CREATE INDEX IF NOT EXISTS idx_fact_links_from ON fact_links(from_id);
      CREATE INDEX IF NOT EXISTS idx_fact_links_to ON fact_links(to_id);
    `);
  }

  _backfillStructuredFields() {
    const hasCategory = this._hasColumn("facts", "category");
    const hasConfidence = this._hasColumn("facts", "confidence");
    if (!hasCategory && !hasConfidence) return;

    const rows = this.db.prepare(`
      SELECT id, fact, tags, category, confidence
      FROM facts
    `).all();

    const update = this.db.prepare(`
      UPDATE facts
      SET category = @category,
          confidence = @confidence
      WHERE id = @id
    `);

    for (const row of rows) {
      let tags = [];
      try {
        tags = JSON.parse(row.tags || "[]");
      } catch {}
      const category = normalizeCategory(row.category || inferCategoryFromContent(row.fact, tags));
      const confidence = clampConfidence(row.confidence);
      update.run({ id: row.id, category, confidence });
    }
  }

  _rowToFact(row) {
    return {
      id: row.id,
      fact: row.fact,
      tags: (() => {
        try { return JSON.parse(row.tags); } catch { return []; }
      })(),
      time: row.time,
      session_id: row.session_id,
      created_at: row.created_at,
      source: row.source ?? null,
      project_path: row.project_path ?? null,
      importance_score: row.importance_score ?? 0,
      hit_count: row.hit_count ?? 0,
      last_accessed_at: row.last_accessed_at ?? null,
      category: normalizeCategory(row.category),
      confidence: clampConfidence(row.confidence),
      evidence: row.evidence ?? null,
      matchCount: row.matchCount ?? undefined,
    };
  }
}
