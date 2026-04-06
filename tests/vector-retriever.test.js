import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  TfIdfVectorRetriever,
  createVectorRetriever,
} from "../lib/memory/vector-interface.js";
import { HybridRetriever } from "../lib/memory/retriever.js";

const tmpRoots = [];

function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-vector-test-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
  }
});

function createStubFactStore() {
  const rows = new Map();
  return {
    get size() { return rows.size; },
    add(row) {
      rows.set(row.id, {
        hit_count: 0,
        importance_score: 0,
        last_accessed_at: null,
        created_at: new Date().toISOString(),
        project_path: null,
        ...row,
      });
    },
    getAll() {
      return Array.from(rows.values());
    },
    getById(id) {
      return rows.get(id) || null;
    },
    searchByTags(keywords) {
      return Array.from(rows.values())
        .map((row) => ({
          ...row,
          matchCount: row.tags.filter((tag) => keywords.includes(tag)).length,
        }))
        .filter((row) => row.matchCount > 0);
    },
    searchFullText(query) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      return Array.from(rows.values()).filter((row) => {
        const hay = `${row.fact} ${row.tags.join(" ")}`.toLowerCase();
        return words.some((word) => hay.includes(word));
      });
    },
    markAccessed(ids) {
      const touchedAt = new Date().toISOString();
      for (const id of ids) {
        const row = rows.get(id);
        if (!row) continue;
        row.hit_count += 1;
        row.importance_score += 2;
        row.last_accessed_at = touchedAt;
      }
    },
  };
}

describe("vector retriever integration", () => {
  it("returns semantically similar rows from the TF-IDF sidecar vector index", async () => {
    const root = makeTempRoot();
    const vector = new TfIdfVectorRetriever(path.join(root, "vectors.db"));

    await vector.rebuildIndex([
      { id: 1, text: "Next.js routing with dynamic segments", tags: ["nextjs", "routing"] },
      { id: 2, text: "Grocery list and dinner prep", tags: ["personal"] },
    ]);

    const results = await vector.search("next routing", 5);
    expect(results[0].id).toBe(1);
    expect(results[0].score).toBeGreaterThan(0);

    vector.close();
  });

  it("creates the TF-IDF retriever from factory config", async () => {
    const root = makeTempRoot();
    const vector = createVectorRetriever({
      type: "tfidf-local",
      dbPath: path.join(root, "vectors.db"),
    });

    await vector.rebuildIndex([
      { id: 1, text: "Brain router signed device token flow", tags: ["brain", "auth"] },
      { id: 2, text: "Weekly dinner groceries", tags: ["personal"] },
    ]);

    const results = await vector.search("brain token", 5);
    expect(results[0].id).toBe(1);
  });

  it("rebuilds and searches through HybridRetriever, then increments access stats", async () => {
    const root = makeTempRoot();
    const factStore = createStubFactStore();
    factStore.add({
      id: 1,
      fact: "React suspense streaming patterns",
      tags: ["react", "streaming"],
      importance_score: 12,
    });
    factStore.add({
      id: 2,
      fact: "Vacation planning notes",
      tags: ["travel"],
      importance_score: 2,
    });

    const retriever = new HybridRetriever({
      factStore,
      vectorConfig: {
        type: "tfidf-local",
        dbPath: path.join(root, "vectors.db"),
        dimensions: 256,
      },
    });

    await retriever.rebuildIndex();
    const before = { ...factStore.getById(1) };
    const results = await retriever.search(["react", "suspense"], 5);
    expect(results[0].id).toBe(1);
    expect(results[0].vectorScore).toBeGreaterThan(0);

    const after = factStore.getById(1);
    expect(after.hit_count).toBeGreaterThan(before.hit_count);
    expect(after.importance_score).toBeGreaterThan(before.importance_score);

    retriever.close();
  });
});
