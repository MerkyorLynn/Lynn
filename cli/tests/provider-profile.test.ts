import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import {
  providerProfilePath,
  readEnvProviderProfile,
  readCliProviderProfile,
  redactApiKey,
  resolveCliProviderProfile,
  writeCliProviderProfile,
} from "../src/provider-profile.js";

async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-provider-"));
}

const originalPreset = process.env.LYNN_CLI_PRESET;
const originalApiKey = process.env.LYNN_CLI_API_KEY;
const originalBaseUrl = process.env.LYNN_CLI_BASE_URL;
const originalModel = process.env.LYNN_CLI_MODEL;

afterEach(() => {
  if (originalPreset === undefined) delete process.env.LYNN_CLI_PRESET;
  else process.env.LYNN_CLI_PRESET = originalPreset;
  if (originalApiKey === undefined) delete process.env.LYNN_CLI_API_KEY;
  else process.env.LYNN_CLI_API_KEY = originalApiKey;
  if (originalBaseUrl === undefined) delete process.env.LYNN_CLI_BASE_URL;
  else process.env.LYNN_CLI_BASE_URL = originalBaseUrl;
  if (originalModel === undefined) delete process.env.LYNN_CLI_MODEL;
  else process.env.LYNN_CLI_MODEL = originalModel;
});

describe("CLI provider profile", () => {
  it("stores CLI BYOK provider config under the Lynn data dir", async () => {
    const dataDir = await tempDir();
    await writeCliProviderProfile(dataDir, {
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1/",
      model: "example-model",
      apiKey: "sk-test-secret",
    });

    await expect(readCliProviderProfile(dataDir)).resolves.toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      model: "example-model",
      apiKey: "sk-test-secret",
    });
    await expect(fs.readFile(providerProfilePath(dataDir), "utf8")).resolves.toContain("example-model");
  });

  it("resolves explicit flags before file config", async () => {
    const dataDir = await tempDir();
    await writeCliProviderProfile(dataDir, {
      provider: "file",
      baseUrl: "https://file.example/v1",
      model: "file-model",
    });

    const resolved = await resolveCliProviderProfile(parseArgs([
      "prompt",
      "hello",
      "--data-dir",
      dataDir,
      "--provider",
      "flags",
      "--base-url",
      "https://flags.example/v1",
      "--model",
      "flag-model",
      "--api-key",
      "sk-flag-secret",
    ]));

    expect(resolved?.source).toBe("flags");
    expect(resolved?.profile).toMatchObject({
      provider: "flags",
      baseUrl: "https://flags.example/v1",
      model: "flag-model",
      apiKey: "sk-flag-secret",
    });
  });

  it("redacts API keys for display", () => {
    expect(redactApiKey("sk-1234567890")).toBe("sk-1…7890");
    expect(redactApiKey("short")).toBe("********");
    expect(redactApiKey(undefined)).toBe("(none)");
  });

  it("resolves CLI provider presets from environment for node-only installs", () => {
    expect(readEnvProviderProfile({
      LYNN_CLI_PRESET: "stepfun",
      LYNN_CLI_API_KEY: "step-secret",
    })).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.stepfun.com/step_plan/v1",
      model: "step-3.7-flash",
      apiKey: "step-secret",
    });

    expect(readEnvProviderProfile({
      LYNN_CLI_PRESET: "stepfun",
      LYNN_CLI_MODEL: "step-3.7-flash-override",
      LYNN_CLI_API_KEY: "step-secret",
    })).toMatchObject({
      baseUrl: "https://api.stepfun.com/step_plan/v1",
      model: "step-3.7-flash-override",
      apiKey: "step-secret",
    });
  });

  it("hydrates matching flag presets with env API keys for Fleet worker profiles", async () => {
    const dataDir = await tempDir();
    process.env.LYNN_CLI_PRESET = "stepfun";
    process.env.LYNN_CLI_API_KEY = "step-env-secret";

    const resolved = await resolveCliProviderProfile(parseArgs([
      "worker",
      "run",
      "--data-dir",
      dataDir,
      "--preset",
      "stepfun",
    ]));

    expect(resolved?.source).toBe("flags");
    expect(resolved?.profile).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "https://api.stepfun.com/step_plan/v1",
      model: "step-3.7-flash",
      apiKey: "step-env-secret",
    });
  });
});
