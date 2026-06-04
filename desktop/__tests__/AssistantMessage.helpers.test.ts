// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  parseMessageModelRef,
  formatProviderRouteName,
  providerRouteLabel,
  providerRouteTitle,
  summarizeToolState,
  extractPlainTextFromBlocks,
  reviewerKindFromConfig,
  reviewerNameFromKind,
  findLatestReviewBlock,
  shouldShowFollowUpAction,
  fallbackI18n,
} from "../src/react/components/chat/AssistantMessage.helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("parseMessageModelRef", () => {
  it("splits provider/id forms and recognizes known local ids", () => {
    expect(parseMessageModelRef("openai / gpt-4o")).toEqual({ provider: "openai", id: "gpt-4o" });
    expect(parseMessageModelRef("anthropic/claude")).toEqual({ provider: "anthropic", id: "claude" });
    expect(parseMessageModelRef("lynn-brain-router")).toEqual({ provider: "brain", id: "lynn-brain-router" });
    expect(parseMessageModelRef("qwen35-9b-q4km-imatrix")?.provider).toBe("local-qwen35-9b-q4km-imatrix");
    expect(parseMessageModelRef("plainmodel")).toEqual({ id: "plainmodel" });
    expect(parseMessageModelRef("")).toBeNull();
  });
});

describe("formatProviderRouteName", () => {
  it("maps vendors and tidies qwen ids", () => {
    expect(formatProviderRouteName("mimo-v2.5")).toBe("MiMo");
    expect(formatProviderRouteName("spark-apex")).toBe("Spark");
    expect(formatProviderRouteName("gpt-5")).toBe("OpenAI");
    expect(formatProviderRouteName("qwen35-9b")).toBe("Qwen 9b");
    expect(formatProviderRouteName("")).toBe("");
  });
});

describe("providerRoute label/title", () => {
  const route = { activeProvider: "spark", fallbackFrom: [{ id: "mimo", reason: "timeout" }] } as any;
  it("builds a de-duped fallback chain label", () => {
    expect(providerRouteLabel(route)).toBe("MiMo -> Spark");
    expect(providerRouteLabel({ activeProvider: "x", fallbackFrom: [] } as any)).toBeNull();
  });
  it("builds a hover title with hop reasons", () => {
    expect(providerRouteTitle(route)).toContain("Spark");
    expect(providerRouteTitle(route)).toContain("timeout");
    expect(providerRouteTitle({ activeProvider: "spark", fallbackFrom: [] } as any)).toBe("当前回答模型：Spark");
  });
});

describe("summarizeToolState", () => {
  it("counts running vs total and surfaces the first active label", () => {
    const blocks = [
      { type: "tool_group", tools: [{ name: "bash", done: true }, { name: "web_search", done: false }] },
      { type: "text", html: "hi" },
    ] as any;
    expect(summarizeToolState(blocks)).toEqual({ running: 1, total: 2, activeLabel: "搜索中" });
  });
});

describe("extractPlainTextFromBlocks (jsdom DOMParser)", () => {
  it("prefers plainText, falls back to parsing html", () => {
    const blocks = [
      { type: "text", plainText: "first" },
      { type: "text", html: "<p>second <b>bold</b></p>" },
      { type: "tool_group", tools: [] },
    ] as any;
    const out = extractPlainTextFromBlocks(blocks);
    expect(out).toContain("first");
    expect(out).toContain("second");
    expect(out).not.toContain("<p>");
  });
});

describe("reviewer + follow-up + i18n", () => {
  it("reviewerKindFromConfig / reviewerNameFromKind", () => {
    expect(reviewerKindFromConfig({ defaultReviewer: "butter" } as any)).toBe("butter");
    expect(reviewerKindFromConfig(null)).toBe("hanako");
    expect(reviewerNameFromKind("butter")).toBe("Butter");
  });
  it("findLatestReviewBlock returns the last review", () => {
    const blocks = [{ type: "review", id: "a" }, { type: "text" }, { type: "review", id: "b" }] as any;
    expect(findLatestReviewBlock(blocks)?.id).toBe("b");
    expect(findLatestReviewBlock([{ type: "text" }] as any)).toBeNull();
  });
  it("shouldShowFollowUpAction gates on done + prompt + workflowGate", () => {
    expect(shouldShowFollowUpAction({ status: "done", followUpPrompt: "x", workflowGate: "follow_up" } as any)).toBe(true);
    expect(shouldShowFollowUpAction({ status: "done", followUpPrompt: "x", workflowGate: "pass" } as any)).toBe(false);
    expect(shouldShowFollowUpAction({ status: "running", followUpPrompt: "x", workflowGate: "hold" } as any)).toBe(false);
    expect(shouldShowFollowUpAction(null)).toBe(false);
  });
  it("fallbackI18n returns fallback for i18n-key-shaped strings", () => {
    expect(fallbackI18n("chat.review.title", "Review")).toBe("Review");
    expect(fallbackI18n("Actual Text", "fb")).toBe("Actual Text");
    expect(fallbackI18n("", "fb")).toBe("fb");
  });
});
