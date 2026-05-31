import { describe, expect, it } from "vitest";
import { formatBrainErrorForHuman, renderBrainEventForHuman, summarizeUsage, type HumanBrainRenderState } from "../src/brain-render.js";

describe("brain render usage summary", () => {
  it("shows tokens, cache hit ratio, and TPS when usage timing is available", () => {
    expect(summarizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 120,
      total_tokens: 1120,
      prompt_cache_hit_tokens: 850,
    }, { durationMs: 2000 })).toBe("1120 tokens · in 1000 · out 120 · cache 850 (85%) · 60.0 TPS");
  });

  it("computes cache ratio from hit and miss tokens when prompt_tokens is missing", () => {
    expect(summarizeUsage({
      completion_tokens: 10,
      prompt_cache_hit_tokens: 90,
      prompt_cache_miss_tokens: 10,
    }, { durationMs: 1000 })).toBe("out 10 · cache 90 · miss 10 (90%) · 10.0 TPS");
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
    }, { durationMs: 1000 })).toBe("1200 tokens · in 1000 · out 200 · cache 750 (75%) · 200 TPS");
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
    renderBrainEventForHuman({ type: "tool_progress", event: "end", name: "web_search", ok: true, ms: 5134 }, state, stream);

    expect(output).toContain("route: step-3.7-flash");
    expect(output).toContain("╭─ tool web_search");
    expect(output).toContain("✓ tool web_search done 5134ms");
    expect(output).not.toContain("server tool:");
  });
});
