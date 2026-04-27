import { describe, expect, it } from "vitest";
import {
  isNativeToolCallingDisabled,
  routeIntentRequiresNativeTools,
} from "../shared/model-tool-capabilities.js";
import { ROUTE_INTENTS } from "../shared/task-route-intent.js";

describe("model tool capabilities", () => {
  it("marks PRISM/NVFP4 models as native-tool-call disabled", () => {
    expect(isNativeToolCallingDisabled({
      provider: "spark",
      id: "prism-nvfp4",
      name: "PRISM NVFP4",
    })).toBe(true);
    expect(isNativeToolCallingDisabled({
      provider: "local-openai",
      id: "qwen3-32b-nvfp4",
      name: "Qwen3 32B NVFP4",
    })).toBe(true);
  });

  it("does not disable unrelated spark/codex models", () => {
    expect(isNativeToolCallingDisabled({
      provider: "openai",
      id: "gpt-5.3-codex-spark",
      name: "GPT-5.3 Codex Spark",
    })).toBe(false);
  });

  it("only routes tool-heavy intents away from broken tool models", () => {
    expect(routeIntentRequiresNativeTools(ROUTE_INTENTS.UTILITY)).toBe(true);
    expect(routeIntentRequiresNativeTools(ROUTE_INTENTS.CODING)).toBe(true);
    expect(routeIntentRequiresNativeTools(ROUTE_INTENTS.CHAT)).toBe(false);
    expect(routeIntentRequiresNativeTools(ROUTE_INTENTS.REASONING)).toBe(false);
  });
});
