import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { compileFacts } from "../lib/memory/compile.js";

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn().mockImplementation(async ({ messages }) => {
    const input = messages?.[0]?.content || "";
    const lines = String(input)
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => /^\d+\.\s/.test(line));
    return lines.join("\n") || input;
  }),
}));

const fakeResolvedModel = {
  model: "test-model",
  api: "openai-completions",
  api_key: "fake",
  base_url: "http://localhost:1234",
};

const tmpRoots = [];

function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-fact-store-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
  }
});

function createFactStoreStub() {
  const rows = new Map();
  let nextId = 1;
  return {
    compileThreshold: 4.5,
    add(entry) {
      const id = nextId++;
      rows.set(id, {
        id,
        fact: entry.fact,
        tags: entry.tags || [],
        importance_score: entry.importance_score ?? 10,
        hit_count: entry.hit_count ?? 0,
        last_accessed_at: entry.last_accessed_at || null,
      });
      return { id };
    },
    getById(id) {
      return rows.get(id) || null;
    },
    markAccessed(ids, opts = {}) {
      const increment = opts.increment ?? 1;
      const importanceDelta = opts.importanceDelta ?? 3;
      let touched = 0;
      for (const id of ids) {
        const row = rows.get(id);
        if (!row) continue;
        row.hit_count += increment;
        row.importance_score += importanceDelta;
        row.last_accessed_at = opts.at || new Date().toISOString();
        touched++;
      }
      return touched;
    },
    getImportantFacts({ minImportance = 4.5 } = {}) {
      return Array.from(rows.values())
        .filter((row) => row.importance_score >= minImportance)
        .sort((a, b) => b.importance_score - a.importance_score);
    },
  };
}

describe("fact store importance + compile retention", () => {
  it("tracks hit counts and importance when facts are accessed", () => {
    const store = createFactStoreStub();
    const { id } = store.add({ fact: "User prefers concise replies", tags: ["preference"] });
    const before = { ...store.getById(id) };

    const touched = store.markAccessed([id]);
    expect(touched).toBe(1);

    const after = store.getById(id);
    expect(after.hit_count).toBe(before.hit_count + 1);
    expect(after.importance_score).toBe(before.importance_score + 3);
    expect(typeof after.last_accessed_at).toBe("string");
  });

  it("compileFacts keeps high-importance facts even without recent summary facts", async () => {
    const root = makeTempRoot();
    const outputPath = path.join(root, "facts.md");
    const store = createFactStoreStub();
    store.add({
      fact: "User is testing Lynn rebrand rollout",
      tags: ["project", "lynn"],
      importance_score: 9,
      hit_count: 4,
    });

    const summaryManager = {
      getSummariesInRange() {
        return [];
      },
    };

    const status = await compileFacts(summaryManager, outputPath, fakeResolvedModel, { factStore: store });

    expect(status).toBe("compiled");
    const content = fs.readFileSync(outputPath, "utf8");
    expect(content).toContain("User is testing Lynn rebrand rollout");
  });
});
