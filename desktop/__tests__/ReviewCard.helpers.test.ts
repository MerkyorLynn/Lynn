import { describe, expect, it } from "vitest";
import {
  findingsSummary,
  contextPackSummary,
  isFollowUpTaskActive,
  followUpTaskLabel,
  normalizeFollowUpTaskDetail,
  buildDiscussionDraft,
  cleanInlineText,
  normalizeReviewErrorMessage,
  summarizeOriginalAnswer,
  summarizeHanakoConcerns,
  buildExecutionResolution,
  shouldCollapseText,
  stripReviewThinkTags,
} from "../src/react/components/chat/ReviewCard.helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */
const review = (o: Record<string, unknown>) => ({ findings: [], summary: "", ...o }) as any;

describe("summaries", () => {
  it("findingsSummary / contextPackSummary", () => {
    expect(findingsSummary(3, false)).toBe("3 findings");
    expect(findingsSummary(2, true)).toBe("2 条发现");
    expect(findingsSummary(undefined, true)).toBeNull();
    expect(contextPackSummary({ workspacePath: "/w", sessionContext: { toolUses: [1, 2] } } as any, false))
      .toBe("workspace · 2 tool notes");
    expect(contextPackSummary(null, false)).toBeNull();
  });
});

describe("follow-up task", () => {
  it("isFollowUpTaskActive only for in-flight states", () => {
    expect(isFollowUpTaskActive({ status: "running" } as any)).toBe(true);
    expect(isFollowUpTaskActive({ status: "waiting_approval" } as any)).toBe(true);
    expect(isFollowUpTaskActive({ status: "completed" } as any)).toBe(false);
    expect(isFollowUpTaskActive(null)).toBe(false);
  });
  it("followUpTaskLabel localizes by status", () => {
    expect(followUpTaskLabel({ status: "running" } as any, true)).toBe("已开始执行");
    expect(followUpTaskLabel({ status: "completed" } as any, false)).toBe("Completed");
  });
  it("normalizeFollowUpTaskDetail prefers error, else default", () => {
    expect(normalizeFollowUpTaskDetail({ status: "failed", error: "boom" } as any, false)).toBe("boom");
    expect(normalizeFollowUpTaskDetail({ status: "pending" } as any, false)).toContain("should start");
    expect(normalizeFollowUpTaskDetail(null, false)).toBeNull();
  });
});

describe("text helpers", () => {
  it("cleanInlineText strips markdown + truncates", () => {
    expect(cleanInlineText("# Title `code` [link](url) **bold**")).toBe("Title code link bold");
    expect(cleanInlineText("abcdefghij", 5)).toBe("abcde…");
  });
  it("stripReviewThinkTags removes think blocks", () => {
    expect(stripReviewThinkTags("<think>secret</think>\nvisible")).toBe("visible");
  });
  it("shouldCollapseText over 220 chars", () => {
    expect(shouldCollapseText("x".repeat(221))).toBe(true);
    expect(shouldCollapseText("short")).toBe(false);
  });
  it("normalizeReviewErrorMessage maps timeouts, passes others, nulls empty", () => {
    expect(normalizeReviewErrorMessage("aborted due to timeout", null, false)).toContain("timed out");
    expect(normalizeReviewErrorMessage("plain error", null, false)).toBe("plain error");
    expect(normalizeReviewErrorMessage("", null, false)).toBeNull();
  });
});

describe("structured-review builders", () => {
  it("summarizeOriginalAnswer cleans or falls back", () => {
    expect(summarizeOriginalAnswer("**Hello**", false)).toBe("Hello");
    expect(summarizeOriginalAnswer("```\n```", true)).toContain("没有可提炼");
  });
  it("summarizeHanakoConcerns lists top finding titles", () => {
    const out = summarizeHanakoConcerns(review({ findings: [{ title: "A" }, { title: "B" }], summary: "" }), false);
    expect(out).toContain("A");
    expect(out).toContain("B");
  });
  it("buildExecutionResolution branches on gate/severity", () => {
    expect(buildExecutionResolution(review({ findings: [] }), "x", false)).toContain("did not surface blocking");
    expect(buildExecutionResolution(review({ findings: [{ title: "f", severity: "high" }], workflowGate: "hold" }), "x", false))
      .toContain("Do not execute");
    expect(buildExecutionResolution(review({ findings: [{ title: "f", severity: "medium" }], workflowGate: "follow_up" }), "x", false))
      .toContain("merge Hanako");
  });
  it("buildDiscussionDraft embeds source + summary + findings", () => {
    const draft = buildDiscussionDraft("orig", review({ findings: [{ title: "Issue", detail: "d" }], summary: "sum" }), false);
    expect(draft).toContain("orig");
    expect(draft).toContain("sum");
    expect(draft).toContain("1. Issue");
  });
});
