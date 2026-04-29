import { describe, expect, it } from "vitest";
import { buildLocalOfficeDirectAnswer } from "../server/chat/local-office-answer.js";

describe("buildLocalOfficeDirectAnswer", () => {
  it("handles regional growth prompts when unit is only declared once at the end", () => {
    const answer = buildLocalOfficeDirectAnswer("【DATA-01】华东 Q1 120 Q2 150；华南 Q1 90 Q2 81；华北 Q1 60 Q2 78（万元）。算环比增长率，给 3 条管理建议。");
    expect(answer).toContain("25%");
    expect(answer).toContain("-10%");
    expect(answer).toContain("30%");
    expect(answer).toContain("管理建议");
  });
});
