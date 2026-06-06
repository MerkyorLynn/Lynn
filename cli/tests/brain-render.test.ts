import { describe, expect, it } from "vitest";
import { formatBrainErrorForHuman, renderBrainEventForHuman, renderToolDetail, renderToolDetailsList, summarizeUsage, type HumanBrainRenderState } from "../src/brain-render.js";

describe("brain render usage summary", () => {
  it("shows tokens, cache hit ratio, and TPS when usage timing is available", () => {
    expect(summarizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 120,
      total_tokens: 1120,
      prompt_cache_hit_tokens: 850,
    }, { durationMs: 2000 })).toBe("1120 tokens · in 1000 · out 120 · prefix-cache 850 hit (85%) · 60.0 TPS");
  });

  it("computes cache ratio from hit and miss tokens when prompt_tokens is missing", () => {
    expect(summarizeUsage({
      completion_tokens: 10,
      prompt_cache_hit_tokens: 90,
      prompt_cache_miss_tokens: 10,
    }, { durationMs: 1000 })).toBe("out 10 · prefix-cache 90 hit · miss 10 (90%) · 10.0 TPS");
  });

  it("keeps the old compact token summary when timing and cache fields are absent", () => {
    expect(summarizeUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    })).toBe("15 tokens · in 10 · out 5");
  });

  it("understands OpenAI-compatible nested cached token shapes", () => {
    expect(summarizeUsage({
      input_tokens: 1000,
      output_tokens: 200,
      prompt_tokens_details: { cached_tokens: 750 },
    }, { durationMs: 1000 })).toBe("1200 tokens · in 1000 · out 200 · prefix-cache 750 hit (75%) · 200 TPS");
  });
});

describe("formatBrainErrorForHuman", () => {
  it("turns all-providers-failed into an actionable setup hint", () => {
    const text = formatBrainErrorForHuman("all providers failed");
    expect(text).toContain("provider");
    expect(text).toContain("Lynn providers set --preset stepfun");
  });
});

describe("renderBrainEventForHuman", () => {
  it("renders route and tool progress as stable cards", () => {
    let output = "";
    const stream = {
      isTTY: false,
      write(chunk: string) {
        output += chunk;
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const state: HumanBrainRenderState = {};

    renderBrainEventForHuman({ type: "provider", activeProvider: "step-3.7-flash" }, state, stream);
    renderBrainEventForHuman({ type: "tool_progress", event: "start", name: "web_search" }, state, stream);
    renderBrainEventForHuman({
      type: "tool_progress",
      event: "end",
      name: "web_search",
      ok: true,
      ms: 5134,
      summary: "MiMo summary · Source A: fresh result",
      details: ["[Source A](https://a.example): fresh result"],
    }, state, stream);

    expect(output).toContain("│ • route: StepFun 3.7 Flash");
    expect(output).toContain("│ 🔧 🔎 web_search · running");
    expect(output).toContain("│ ✓ 🔎 web_search · done 5.1s");
    expect(output).toContain("│   MiMo summary · Source A: fresh result");
    expect(output).toContain("│   sources: /tool 1 · 1 link · a.example");
    expect(renderToolDetailsList(state, false)).toContain("/tool 1");
    expect(renderToolDetail(state, 1, false)).toContain("Source A (https://a.example)");
    expect(output).not.toContain("server tool:");
    for (const line of output.split("\n").filter(Boolean)) {
      expect((line.match(/│/g) || []).length).toBeLessThanOrEqual(1);
    }
  });

  it("keeps tool details inspectable when Brain only reports tool timing", () => {
    let output = "";
    const stream = {
      isTTY: false,
      write(chunk: string) {
        output += chunk;
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const state: HumanBrainRenderState = {};

    renderBrainEventForHuman({
      type: "tool_progress",
      event: "end",
      name: "web_fetch",
      ok: true,
      ms: 2600,
    }, state, stream);

    expect(output).toContain("details: /tool 1");
    expect(renderToolDetailsList(state, false)).toContain("无展开明细");
    expect(renderToolDetail(state, 1, false)).toContain("没有提供搜索摘要或来源明细");
  });

  it("promotes search detail snippets into the visible tool card", () => {
    let output = "";
    const stream = {
      isTTY: false,
      write(chunk: string) {
        output += chunk;
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const state: HumanBrainRenderState = {};

    renderBrainEventForHuman({
      type: "tool_progress",
      event: "end",
      name: "web_search",
      ok: true,
      ms: 4500,
      details: [
        "[StepFun Docs](https://platform.stepfun.com/docs/zh/api-reference/chat/messages-create): max_tokens controls generated tokens; model context is separate.",
        "[Pricing](https://platform.stepfun.com/pricing): StepFun 3.7 Flash supports high reasoning.",
      ],
    }, state, stream);

    expect(output).toContain("StepFun Docs · platform.stepfun.com");
    expect(output).toContain("max_tokens controls generated tokens");
    expect(output).toContain("Pricing · platform.stepfun.com");
    expect(output).toContain("sources: /tool 1 · 2 links · platform.stepfun.com");
    expect(renderToolDetailsList(state, false)).toContain("/tool 1 🔎 web_search · done · 4.5s — 2 sources: platform.stepfun.com");
  });
});
