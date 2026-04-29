import { describe, expect, it } from "vitest";
import { ContentFilter } from "../lib/content-filter.js";

async function createFilter() {
  const filter = new ContentFilter();
  await filter.init();
  return filter;
}

describe("ContentFilter", () => {
  it("does not block short English sensitive tokens embedded in normal words", async () => {
    const filter = await createFilter();
    const result = filter.check("Translate this sentence: A small train hums beyond the hill.");

    expect(result.blocked).toBe(false);
    expect(result.matches.some((match) => String(match.word).toLowerCase() === "sm")).toBe(false);
  });

  it("still catches standalone short English sensitive tokens", async () => {
    const filter = await createFilter();
    const result = filter.check("sm");

    expect(result.blocked).toBe(true);
    expect(result.matches.some((match) => String(match.word).toLowerCase() === "sm")).toBe(true);
  });

  it("does not block normal file-operation copy wording", async () => {
    const filter = await createFilter();
    const result = filter.check("需要创建、移动、复制、读取或查询文件时，必须直接调用真实工具。");

    expect(result.blocked).toBe(false);
    expect(result.matches.some((match) => String(match.word) === "复制")).toBe(false);
  });

  it("still blocks risky copy-device wording outside file-operation context", async () => {
    const filter = await createFilter();
    const result = filter.check("复制银行卡");

    expect(result.blocked).toBe(true);
  });
});
