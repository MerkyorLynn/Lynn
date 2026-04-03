/**
 * fact-store.js — 深度记忆存储（元事实 + 标签）
 *
 * v2 记忆系统的 archival 层。每条记忆是一个"元事实"，
 * 附带标签和时间，通过标签匹配 + FTS5 全文搜索检索。
 *
 * Phase 4: 增加 importance / hit_count / project_path / source 元数据，
 * 为混合检索与增量保留提供基础。
 */

import Database from "better-sqlite3";
import { scrubPII } from "../pii-guard.js";

/**
 * 当前 schema 版本。每次改表结构时递增，
 * 并在 _migrate() 里添加对应的迁移逻辑。
 */
const SCHEMA_VERSION = 3;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
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
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -16000");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("mmap_size = 30000000");
    this._initSchema();
    this._migrate();
    this._prepareStatements();
    this._tagSearchCache = new Map();

    // Periodic WAL checkpoint to prevent unbounded WAL growth.
    this._walTimer = setInterval(() => {
      try { this.db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
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
        last_accessed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_facts_time ON facts(time);
      CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id);
      CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at);
      CREATE INDEX IF NOT EXISTS idx_facts_time_session ON facts(time, session_id);
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
        }
        v++;
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();

    console.log(`[FactStore] schema migrated: v${current} → v${SCHEMA_VERSION}`);
  }

  _ensureDerivedIndexes() {
    if (this._hasColumn("facts", "project_path")) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project_path)");
    }
    if (this._hasColumn("facts", "importance_score")) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_importance ON facts(importance_score DESC)");
    }
    if (this._hasColumn("facts", "last_accessed_at")) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_last_accessed ON facts(last_accessed_at DESC)");
    }
  }

  _prepareStatements() {
    this._stmts = {
      insert: this.db.prepare(`
        INSERT INTO facts (
          fact, tags, time, session_id, created_at,
          source, project_path, importance_score, hit_count, last_accessed_at
        )
        VALUES (
          @fact, @tags, @time, @sessionId, @createdAt,
          @source, @projectPath, @importanceScore, @hitCount, @lastAccessedAt
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
      ftsSearch: this.db.prepare(`
        SELECT f.*, rank
        FROM facts_fts fts
        JOIN facts f ON f.id = fts.rowid
        WHERE facts_fts MATCH ?
        ORDER BY rank
        LIMIT ?
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
    });

    const id = Number(result.lastInsertRowid);
    this._emitChange({ type: "add", row: { id, ...row } });
    return { id };
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
        });
      }
    });
    run();
  }

  close() {
    if (this._walTimer) { clearInterval(this._walTimer); this._walTimer = null; }
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
      matchCount: row.matchCount ?? undefined,
    };
  }
}
