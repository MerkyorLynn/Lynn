import { beforeEach, describe, expect, it, vi } from "vitest";

let rows;
let nextId;

class MockDatabase {
  constructor() {
    this.open = true;
  }

  pragma(name, opts) {
    if (name === "user_version" && opts?.simple) return 4;
    if (name.startsWith("table_info(")) {
      return [
        { name: "id" },
        { name: "fact" },
        { name: "tags" },
        { name: "time" },
        { name: "session_id" },
        { name: "created_at" },
        { name: "source" },
        { name: "project_path" },
        { name: "importance_score" },
        { name: "hit_count" },
        { name: "last_accessed_at" },
        { name: "category" },
        { name: "confidence" },
        { name: "evidence" },
      ];
    }
    return [];
  }

  exec() {}

  transaction(fn) {
    return (...args) => fn(...args);
  }

  prepare(sql) {
    if (sql.includes("INSERT INTO facts (")) {
      return {
        run(params) {
          const id = nextId++;
          rows.set(id, {
            id,
            fact: params.fact,
            tags: params.tags,
            time: params.time,
            session_id: params.sessionId,
            created_at: params.createdAt,
            source: params.source,
            project_path: params.projectPath,
            importance_score: params.importanceScore,
            hit_count: params.hitCount,
            last_accessed_at: params.lastAccessedAt,
            category: params.category,
            confidence: params.confidence,
            evidence: params.evidence,
          });
          return { lastInsertRowid: id };
        },
      };
    }

    if (sql.includes("SELECT * FROM facts WHERE id = ?")) {
      return {
        get(id) {
          return rows.get(Number(id)) || undefined;
        },
      };
    }

    if (sql.includes("SELECT *\n        FROM facts\n        WHERE category = ?")) {
      return {
        all(category, limit) {
          return Array.from(rows.values())
            .filter((row) => row.category === category)
            .slice(0, limit);
        },
      };
    }

    if (sql.includes("SELECT * FROM facts ORDER BY time DESC")) {
      return {
        all() {
          return Array.from(rows.values());
        },
      };
    }

    if (sql.includes("SELECT * FROM facts WHERE session_id = ? ORDER BY time DESC")) {
      return { all() { return []; } };
    }

    if (sql.includes("SELECT * FROM facts") && sql.includes("importance_score")) {
      return { all() { return []; } };
    }

    if (sql.includes("SELECT COUNT(*) as cnt FROM facts")) {
      return {
        get() {
          return { cnt: rows.size };
        },
      };
    }

    if (sql.includes("DELETE FROM facts WHERE id = ?")) {
      return {
        run(id) {
          const existed = rows.delete(Number(id));
          return { changes: existed ? 1 : 0 };
        },
      };
    }

    if (sql.includes("DELETE FROM facts")) {
      return {
        run() {
          const count = rows.size;
          rows.clear();
          return { changes: count };
        },
      };
    }

    if (sql.includes("UPDATE facts") && sql.includes("hit_count")) {
      return {
        run(params) {
          const row = rows.get(Number(params.id));
          if (!row) return { changes: 0 };
          row.hit_count += params.increment;
          row.importance_score += params.importanceDelta;
          row.last_accessed_at = params.lastAccessedAt;
          return { changes: 1 };
        },
      };
    }

    if (sql.includes("JOIN facts f ON f.id = fts.rowid")) {
      return { all() { return []; } };
    }

    return {
      all() { return []; },
      get() { return undefined; },
      run() { return { changes: 0 }; },
    };
  }

  close() {
    this.open = false;
  }
}

vi.mock("better-sqlite3", () => ({
  default: MockDatabase,
}));

describe("FactStore structured fields", () => {
  beforeEach(() => {
    rows = new Map();
    nextId = 1;
  });

  it("persists category, confidence, and evidence", async () => {
    const { FactStore } = await import("../lib/memory/fact-store.js");
    const store = new FactStore("/tmp/facts.db");

    const { id } = store.add({
      fact: "用户喜欢暖色调主题",
      tags: ["主题", "暖色"],
      category: "preference",
      confidence: 0.9,
      evidence: "用户明确要求保持米色暖阳主题",
    });

    const row = store.getById(id);
    expect(row?.category).toBe("preference");
    expect(row?.confidence).toBe(0.9);
    expect(row?.evidence).toBe("用户明确要求保持米色暖阳主题");

    store.close();
  });

  it("supports category-only lookup for structured memory views", async () => {
    const { FactStore } = await import("../lib/memory/fact-store.js");
    const store = new FactStore("/tmp/facts.db");

    store.add({ fact: "Lynn 使用 Electron 架构", tags: ["Electron"], category: "project" });
    store.add({ fact: "用户喜欢直接回答", tags: ["偏好"], category: "preference" });

    const rowsFound = store.searchByCategory("preference", 10);
    expect(rowsFound).toHaveLength(1);
    expect(rowsFound[0].fact).toContain("直接回答");

    store.close();
  });
});
