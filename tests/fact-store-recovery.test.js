import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let rows;
let nextId;
let openFailuresRemaining;
let prepareFailuresRemaining;

class RecoverableDatabase {
  constructor(filename) {
    this.filename = filename;
    this.open = true;
    if (openFailuresRemaining > 0) {
      openFailuresRemaining -= 1;
      throw new Error("file is not a database");
    }
  }

  pragma(source, opts) {
    if (source === "user_version" && opts?.simple) return 5;
    return [];
  }

  exec() {}

  transaction(fn) {
    return (...args) => fn(...args);
  }

  prepare(sql) {
    if (prepareFailuresRemaining > 0 && sql.includes("INSERT INTO facts")) {
      prepareFailuresRemaining -= 1;
      throw new Error("SQLITE_ERROR: no such column: session_id");
    }

    if (sql.includes("INSERT INTO facts")) {
      return {
        run(params) {
          const id = nextId++;
          rows.push({
            id,
            fact: params.fact,
            tags: params.tags || "[]",
            time: params.time || null,
            session_id: params.sessionId || null,
            created_at: params.createdAt || new Date().toISOString(),
            source: params.source || null,
            project_path: params.projectPath || null,
            importance_score: params.importanceScore || 0,
            hit_count: params.hitCount || 0,
            last_accessed_at: params.lastAccessedAt || null,
            category: params.category || "other",
            confidence: params.confidence ?? 0.5,
            evidence: params.evidence || null,
          });
          return { changes: 1, lastInsertRowid: id };
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

    if (sql.includes("SELECT COUNT(*) as cnt")) {
      return {
        get() {
          return { cnt: rows.length };
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
  default: RecoverableDatabase,
}));

const tempRoots = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-fact-recovery-"));
  tempRoots.push(root);
  return root;
}

function listBackups(dir) {
  return fs.readdirSync(dir).filter((name) => name.startsWith("facts.db.bak-"));
}

beforeEach(() => {
  rows = [];
  nextId = 1;
  openFailuresRemaining = 0;
  prepareFailuresRemaining = 0;
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("FactStore startup recovery", () => {
  it("backs up an unusable facts.db and rebuilds an empty store", async () => {
    const root = makeTempRoot();
    const dbPath = path.join(root, "facts.db");
    fs.writeFileSync(dbPath, "not a sqlite database", "utf-8");
    openFailuresRemaining = 1;

    const { FactStore } = await import("../lib/memory/fact-store.js");
    const store = new FactStore(dbPath);

    expect(store.getAll()).toEqual([]);
    store.add({ fact: "Lynn can restart after a broken facts database." });
    expect(store.getAll()[0].fact).toContain("broken facts database");
    store.close();

    const backups = listBackups(root);
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, backups[0]), "utf-8")).toBe("not a sqlite database");
  });

  it("backs up an incompatible schema when statement preparation fails", async () => {
    const root = makeTempRoot();
    const dbPath = path.join(root, "facts.db");
    fs.writeFileSync(dbPath, "sqlite file with incompatible latest-version schema", "utf-8");
    prepareFailuresRemaining = 1;

    const { FactStore } = await import("../lib/memory/fact-store.js");
    const store = new FactStore(dbPath);

    expect(store.getAll()).toEqual([]);
    store.add({ fact: "Recovered from an incompatible facts schema." });
    expect(store.getAll()[0].fact).toContain("incompatible facts schema");
    store.close();

    expect(listBackups(root)).toHaveLength(1);
  });
});
