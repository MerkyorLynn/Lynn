import { describe, expect, it } from "vitest";
import {
  buildCliRuntimeSystemMessage,
  refreshCliRuntimeSystemMessage,
  resetCliRuntimeMessages,
} from "../src/runtime-context.js";

describe("CLI runtime context", () => {
  it("tells the model which route the user sees", () => {
    const message = buildCliRuntimeSystemMessage("StepFun 3.7 Flash → Spark Qwen 3.6 35B A3B via Brain router (auto)");

    expect(message.role).toBe("system");
    expect(message.content).toContain("Current model route shown to the user: StepFun 3.7 Flash");
    expect(message.content).toContain("default online route is StepFun 3.7 Flash first (256K context; high reasoning with a 32K reasoning/generation budget)");
    expect(message.content).toContain("answer from this runtime context");
    expect(message.content).toContain("docs/ops/lynn-cli-runtime-knowledge.md");
    expect(message.content).toContain("Lynn code -p \"task\" --json");
    expect(message.content).toContain("Lynn worker run --brief task.md");
  });

  it("refreshes the system route without moving it out of the prefix", () => {
    const messages = resetCliRuntimeMessages("StepFun 3.7 Flash → Spark Qwen 3.6 35B A3B");
    messages.push({ role: "user", content: "hi" });

    refreshCliRuntimeSystemMessage(messages, "CLI BYOK: step-3.7-flash");

    expect(messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("CLI BYOK: step-3.7-flash"),
    });
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
  });
});
