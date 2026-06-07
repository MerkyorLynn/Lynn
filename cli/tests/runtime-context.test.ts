import { describe, expect, it } from "vitest";
import {
  buildCliRuntimeSystemMessage,
  refreshCliRuntimeSystemMessage,
  resetCliRuntimeMessages,
} from "../src/runtime-context.js";

describe("CLI runtime context", () => {
  it("tells the model which route the user sees", () => {
    const message = buildCliRuntimeSystemMessage("StepFun 3.7 Flash → MiMo V2.5 Pro via Brain router (auto)");

    expect(message.role).toBe("system");
    expect(message.content).toContain("Current model route shown to the user: StepFun 3.7 Flash");
    expect(message.content).toContain("default online route is StepFun 3.7 Flash first (256K context; high reasoning with a 32K reasoning/generation budget)");
    expect(message.content).toContain("answer from this runtime context");
    expect(message.content).toContain("Lynn CLI memory is layered");
    expect(message.content).toContain("Local 9B is explicit opt-in only");
    expect(message.content).toContain("failure should promote to StepFun");
    expect(message.content).toContain("/memory add");
    expect(message.content).toContain("Do not assume the user's current directory contains that docs path");
    // Usage how-to (headless/Fleet/scripting commands) is no longer carried verbatim
    // in the model prompt — it is answered locally and pointed at the runtime docs.
    expect(message.content).toContain("docs/ops/lynn-cli-runtime-knowledge.md");
    expect(message.content).toContain("Lynn worker run");
    expect(message.content).toContain("downloadable reports, PPTX decks");
    expect(message.content).toContain("polished artifact");
    expect(message.content).not.toContain("Headless one-shot:");
  });

  it("keeps volatile runtime values (version, route) in a tail after the stable prefix", () => {
    const message = buildCliRuntimeSystemMessage("StepFun 3.7 Flash → MiMo V2.5 Pro via Brain router (auto)");
    const content = String(message.content);

    // The stable identity/rules must come before the volatile runtime line so the
    // prefix cache survives route/version/memory changes.
    expect(content.indexOf("You are Lynn CLI")).toBeLessThan(content.indexOf("Runtime context:"));
    expect(content.indexOf("Answer in the user's language.")).toBeLessThan(content.indexOf("Runtime context:"));
  });

  it("refreshes the system route without moving it out of the prefix", () => {
    const messages = resetCliRuntimeMessages("StepFun 3.7 Flash → MiMo V2.5 Pro");
    messages.push({ role: "user", content: "hi" });

    refreshCliRuntimeSystemMessage(messages, "CLI BYOK: step-3.7-flash");

    expect(messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("CLI BYOK: step-3.7-flash"),
    });
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
  });
});
