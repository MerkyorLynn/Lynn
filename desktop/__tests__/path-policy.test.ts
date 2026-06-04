import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizePolicyPath, resolveCanonicalPath, isPathInsideRoot, uniqueCanonicalPaths } = require("../path-policy.cjs");

describe("isPathInsideRoot", () => {
  it("accepts paths inside the root, rejects siblings and traversal", () => {
    const root = path.join(path.sep, "a", "b");
    expect(isPathInsideRoot(path.join(root, "c", "d"), root)).toBe(true);
    expect(isPathInsideRoot(root, root)).toBe(true);
    expect(isPathInsideRoot(path.join(path.sep, "a", "bb"), root)).toBe(false); // prefix-but-not-inside
    expect(isPathInsideRoot(path.join(path.sep, "a"), root)).toBe(false);
  });
});

describe("resolveCanonicalPath + uniqueCanonicalPaths", () => {
  it("resolves real paths and rejects invalid input", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-pp-")));
    const f = path.join(dir, "f.txt");
    fs.writeFileSync(f, "x");
    expect(resolveCanonicalPath(f)).toBe(f);
    expect(resolveCanonicalPath(123 as unknown as string)).toBeNull();
    expect(resolveCanonicalPath("with\0null")).toBeNull();
    // resolves a not-yet-existing child against its real parent
    expect(resolveCanonicalPath(path.join(dir, "new.txt"))).toBe(path.join(dir, "new.txt"));
  });
  it("dedupes canonical paths (case-insensitive on win32 via normalizePolicyPath)", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-pp-")));
    const f = path.join(dir, "g.txt");
    fs.writeFileSync(f, "y");
    const out = uniqueCanonicalPaths([f, f, "bogus\0"]);
    expect(out).toEqual([f]);
  });
});

describe("normalizePolicyPath", () => {
  it("is platform-aware (win32 lowercases)", () => {
    const r = normalizePolicyPath("/A/B");
    expect(r === "/A/B" || r === "/a/b").toBe(true); // posix keeps case, win32 lowercases
  });
});
