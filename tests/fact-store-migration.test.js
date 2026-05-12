import { beforeEach, describe, expect, it, vi } from "vitest";

let columns;
let rows;
let userVersion;
let createdCategoryIndex;

class LegacySchemaDatabase {
  constructor() {
    this.open = true;
  }

  pragma(name, opts) {
    if (name === "user_version" && opts?.simple) return userVersion;
    if (name.startsWith("user_version =")) {
      userVersion = Number(name.match(/user_version = (\d+)/)?.[1] || userVersion);
      return;
    }
    if (name.startsWith("table_info(")) {
      return columns.map((name) => ({ name }));
    }
    return [];
  }

  exec(sql) {
    if (sql.includes("idx_facts_category") && !columns.includes("category")) {
      throw new Error("no such column: category");
    }
    if (sql.includes("ALTER TABLE facts ADD COLUMN source")) columns.push("source");
    if (sql.includes("ALTER TABLE facts ADD COLUMN project_path")) columns.push("project_path");
    if (sql.includes("ALTER TABLE facts ADD COLUMN importance_score")) columns.push("importance_score");
    if (sql.includes("ALTER TABLE facts ADD COLUMN hit_count")) columns.push("hit_count");
    if (sql.includes("ALTER TABLE facts ADD COLUMN last_accessed_at")) columns.push("last_accessed_at");
    if (sql.includes("ALTER TABLE facts ADD COLUMN category")) columns.push("category");
    if (sql.includes("ALTER TABLE facts ADD COLUMN confidence")) columns.push("confidence");
    if (sql.includes("ALTER TABLE facts ADD COLUMN evidence")) columns.push("evidence");
    if (sql.includes("idx_facts_category")) createdCategoryIndex = true;
  }

  transaction(fn) {
    return (...args) => fn(...args);
  }

  prepare(sql) {
    if (sql.includes("SELECT id, fact, tags, category, confidence")) {
      return {
        all() {
          return rows.map((row) => ({
            ...row,
            category: row.category ?? null,
            confidence: row.confidence ?? null,
          }));
        },
      };
    }

    if (sql.includes("UPDATE facts") && sql.includes("SET category = @category")) {
      return {
        run(params) {
          const row = rows.find((r) => r.id === params.id);
          if (row) {
            row.category = params.category;
            row.confidence = params.confidence;
          }
          return { changes: row ? 1 : 0 };
        },
      };
    }

    if (sql.includes("SELECT * FROM facts ORDER BY time DESC")) {
      return {
        all() {
          return rows;
        },
      };
    }

    if (sql.includes("sqlite_master") && sql.includes("idx_facts_category")) {
      return {
        all() {
          return createdCategoryIndex ? [{ name: "idx_facts_category" }] : [];
        },
      };
    }

    return {
      all() { return []; },
      get() { return undefined; },
      run() { return { changes: 0, lastInsertRowid: 1 }; },
    };
  }

  close() {
    this.open = false;
  }
}

vi.mock("better-sqlite3", () => ({
  default: LegacySchemaDatabase,
}));

describe("FactStore legacy schema migration", () => {
  beforeEach(() => {
    userVersion = 3;
    createdCategoryIndex = false;
    columns = [
      "id",
      "fact",
      "tags",
      "time",
      "session_id",
      "created_at",
      "source",
      "project_path",
      "importance_score",
      "hit_count",
      "last_accessed_at",
    ];
    rows = [
      {
        id: 1,
        fact: "Windows 启动时遇到 SQLITE timeout 踩坑",
        tags: "[\"Windows\",\"SQLite\"]",
        time: "2026-05-12T00:00:00.000Z",
        session_id: "legacy-session",
        created_at: "2026-05-12T00:00:00.000Z",
        source: null,
        project_path: null,
        importance_score: 0,
        hit_count: 0,
        last_accessed_at: null,
      },
    ];
  });

  it("migrates category fields before creating category indexes", async () => {
    const { FactStore } = await import("../lib/memory/fact-store.js");

    const store = new FactStore("/tmp/legacy-facts.db");
    const row = store.getAll()[0];

    expect(columns).toContain("category");
    expect(columns).toContain("confidence");
    expect(columns).toContain("evidence");
    expect(createdCategoryIndex).toBe(true);
    expect(userVersion).toBe(5);
    expect(row.fact).toContain("SQLITE");
    expect(row.category).toBe("pitfall");
    expect(row.confidence).toBe(0.5);

    store.close();
  });
});
