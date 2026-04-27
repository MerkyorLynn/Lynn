import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { execute as knowledgeIndex } from "../plugins/rag-core/tools/knowledge-index.js";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeCtx(dataDir) {
  return {
    dataDir,
    pluginDir: path.join(process.cwd(), "plugins", "rag-core"),
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    config: {
      get(key) {
        if (key === "chunk_size") return 5000;
        if (key === "chunk_overlap") return 0;
        return undefined;
      },
    },
  };
}

function readIndexedSources(dataDir, collection) {
  const metaPath = path.join(dataDir, `${collection}-chunks.json`);
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  return new Set(meta.chunks.map((chunk) => chunk.source));
}

describe("knowledge_index recursive indexing", () => {
  const tempRoots = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
    }
  });

  it("indexes only top-level files when recursive=false", async () => {
    const root = makeTempDir("lynn-rag-index-");
    tempRoots.push(root);

    const docsDir = path.join(root, "docs");
    const nestedDir = path.join(docsDir, "nested");
    const hiddenDir = path.join(docsDir, ".hidden");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.mkdirSync(hiddenDir, { recursive: true });

    const topFile = path.join(docsDir, "top.txt");
    const nestedFile = path.join(nestedDir, "deep.txt");
    const hiddenFile = path.join(hiddenDir, "skip.txt");
    const hiddenTopFile = path.join(docsDir, ".skip.txt");

    fs.writeFileSync(topFile, "top level content", "utf-8");
    fs.writeFileSync(nestedFile, "nested content", "utf-8");
    fs.writeFileSync(hiddenFile, "hidden nested content", "utf-8");
    fs.writeFileSync(hiddenTopFile, "hidden top content", "utf-8");

    const dataDir = path.join(root, "plugin-data");
    const result = await knowledgeIndex(
      { file_path: docsDir, collection: "top-only", recursive: false },
      makeCtx(dataDir),
    );

    expect(result.details.ok).toBe(true);
    expect(result.details.indexedFiles).toBe(1);
    expect(result.details.failedFiles).toBe(0);

    const indexedSources = readIndexedSources(dataDir, "top-only");
    expect(indexedSources).toEqual(new Set([topFile]));
  });

  it("recursively indexes nested files and skips hidden paths when recursive=true", async () => {
    const root = makeTempDir("lynn-rag-index-");
    tempRoots.push(root);

    const docsDir = path.join(root, "docs");
    const nestedDir = path.join(docsDir, "nested");
    const deepDir = path.join(nestedDir, "deep");
    const hiddenDir = path.join(docsDir, ".hidden");
    fs.mkdirSync(deepDir, { recursive: true });
    fs.mkdirSync(hiddenDir, { recursive: true });

    const topFile = path.join(docsDir, "top.txt");
    const nestedFile = path.join(nestedDir, "nested.txt");
    const deepFile = path.join(deepDir, "deep.txt");
    const hiddenNestedFile = path.join(hiddenDir, "skip.txt");
    const hiddenTopFile = path.join(docsDir, ".skip.txt");

    fs.writeFileSync(topFile, "top level content", "utf-8");
    fs.writeFileSync(nestedFile, "nested content", "utf-8");
    fs.writeFileSync(deepFile, "deep content", "utf-8");
    fs.writeFileSync(hiddenNestedFile, "hidden nested content", "utf-8");
    fs.writeFileSync(hiddenTopFile, "hidden top content", "utf-8");

    const dataDir = path.join(root, "plugin-data");
    const result = await knowledgeIndex(
      { file_path: docsDir, collection: "recursive", recursive: true },
      makeCtx(dataDir),
    );

    expect(result.details.ok).toBe(true);
    expect(result.details.indexedFiles).toBe(3);
    expect(result.details.failedFiles).toBe(0);
    expect(result.details.recursive).toBe(true);

    const indexedSources = readIndexedSources(dataDir, "recursive");
    expect(indexedSources).toEqual(new Set([topFile, nestedFile, deepFile]));
    expect(indexedSources.has(hiddenNestedFile)).toBe(false);
    expect(indexedSources.has(hiddenTopFile)).toBe(false);
  });
});
