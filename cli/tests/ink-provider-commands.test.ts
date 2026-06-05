import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { handleInkProviderCommand } from "../src/ink-provider-commands.js";
import { setLang } from "../src/i18n.js";
import { readCliProviderProfile } from "../src/provider-profile.js";

beforeEach(() => setLang("en"));
afterEach(() => setLang(null));

async function makeBaseArgs() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-ink-provider-"));
  return {
    dataDir,
    args: parseArgs(["chat", "--data-dir", dataDir]),
  };
}

describe("Ink provider commands", () => {
  it("renders provider info inside Ink instead of sending /providers to the model", async () => {
    const { args } = await makeBaseArgs();

    const result = await handleInkProviderCommand("/providers", args);

    expect(result.handled).toBe(true);
    expect(result.message).toContain("Lynn Providers / BYOK");
    expect(result.message).toContain("CLI BYOK");
    expect(result.refreshedProvider).toBeUndefined();
  });

  it("renders model route info inside Ink instead of sending /model to the model", async () => {
    const { args } = await makeBaseArgs();

    const result = await handleInkProviderCommand("/model", args);

    expect(result.handled).toBe(true);
    expect(result.message).toContain("Lynn Models / Brain Route");
    expect(result.message).toContain("StepFun 3.7 Flash");
    expect(result.message).toContain("Spark Qwen 3.6 35B A3B");
    expect(result.message).not.toContain("MiMo");
  });

  it("normalizes full-width slash for model route commands", async () => {
    const { args } = await makeBaseArgs();

    const result = await handleInkProviderCommand("／model", args);

    expect(result.handled).toBe(true);
    expect(result.message).toContain("StepFun 3.7 Flash");
  });

  it("prints set usage for bare interactive provider setup commands", async () => {
    const { args, dataDir } = await makeBaseArgs();

    const result = await handleInkProviderCommand("/providers set", args);

    expect(result.handled).toBe(true);
    expect(result.message).toContain("/providers set --base-url");
    await expect(readCliProviderProfile(dataDir)).resolves.toBeNull();
  });

  it("saves provider profiles and returns the refreshed route for Ink status bars", async () => {
    const { args, dataDir } = await makeBaseArgs();

    const result = await handleInkProviderCommand(
      "/providers set --preset stepfun --api-key sk-test-1234",
      args,
    );

    expect(result.handled).toBe(true);
    expect(result.message).toContain("Saved CLI BYOK provider");
    expect(result.message).not.toContain("sk-test-1234");
    expect(result.refreshedProvider).toMatchObject({
      provider: "openai-compatible",
      model: "step-3.7-flash",
      apiKey: "sk-test-1234",
    });
    await expect(readCliProviderProfile(dataDir)).resolves.toMatchObject({
      provider: "openai-compatible",
      model: "step-3.7-flash",
      apiKey: "sk-test-1234",
    });
  });

  it("ignores normal user text", async () => {
    const { args } = await makeBaseArgs();

    await expect(handleInkProviderCommand("hello", args)).resolves.toEqual({
      handled: false,
      message: "",
    });
  });

  it("leaves unknown slash commands for the local unknown-command guard", async () => {
    const { args } = await makeBaseArgs();

    await expect(handleInkProviderCommand("/not-a-command", args)).resolves.toEqual({
      handled: false,
      message: "",
    });
  });
});
