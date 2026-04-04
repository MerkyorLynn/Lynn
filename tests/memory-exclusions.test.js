import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryExclusions } from "../lib/memory/memory-exclusions.js";

const tempRoots = [];

function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-memory-exclusion-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("MemoryExclusions", () => {
  it("stores phrases and matches future facts", () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "exclusions.json");
    const exclusions = new MemoryExclusions({ filePath });

    exclusions.addPhrase("米色暖阳主题");

    expect(exclusions.list().phrases).toEqual(["米色暖阳主题"]);
    expect(exclusions.matchesFact({
      fact: "用户喜欢米色暖阳主题",
      tags: ["主题"],
      evidence: "多次提到米色暖阳",
    })).toBe(true);
    expect(exclusions.matchesFact({
      fact: "用户偏好 TypeScript",
      tags: ["技术"],
      evidence: "明确说明",
    })).toBe(false);
  });
});
