import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../src/args.js";
import { activeRouteLabel, renderProvidersInfo, runProviders } from "../src/commands/providers.js";
import { providerProfilePath, readCliProviderProfile } from "../src/provider-profile.js";
import { setLang } from "../src/i18n.js";

beforeEach(() => setLang("en"));
afterEach(() => setLang(null));

describe("providers command", () => {
  it("renders BYOK guidance without exposing keys", () => {
    const output = renderProvidersInfo({
      defaultRoute: "MiMo via local Brain router (auto)",
      byokEntry: "Open Lynn GUI > Settings > Providers",
      keyPolicy: "Provider keys stay private.",
      brainUrl: "http://127.0.0.1:8790",
      server: { status: "ok", url: "http://127.0.0.1:3000" },
      activeProvider: "openai",
      activeModel: "gpt-5.5",
      providers: [
        { id: "openai", displayName: "OpenAI", type: "api-key", configured: true, modelCount: 2 },
        { id: "deepseek", displayName: "DeepSeek", type: "api-key", configured: false, modelCount: 1 },
      ],
    });

    expect(output).toContain("Lynn Providers / BYOK");
    expect(output).toContain("MiMo");
    expect(output).toContain("OpenAI");
    expect(output).not.toContain("secret");
    expect(output).toContain("Settings > Providers");
    expect(output).toContain("CLI BYOK");
    expect(output).not.toContain("sk-");
  });

  it("prints JSON when requested", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs(["providers", "--json", "--data-dir", "/tmp/lynn-cli-missing-test"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("\"type\":\"providers.info\"");
    expect(output).toContain("MiMo");
  });

  it("makes model a providers alias", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs(["model", "--data-dir", "/tmp/lynn-cli-missing-test"]))).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("Default route");
    expect(output).toContain("BYOK");
  });

  it("formats the active route for the startup banner", () => {
    expect(activeRouteLabel({
      defaultRoute: "MiMo via local Brain router (auto)",
      activeProvider: "mimo",
      activeModel: "mimo-v2.5-pro",
    })).toBe("mimo / mimo-v2.5-pro");
    expect(activeRouteLabel({
      defaultRoute: "MiMo via local Brain router (auto)",
    })).toBe("MiMo via local Brain router (auto)");
  });

  it("saves a CLI BYOK provider profile without printing the raw key", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-providers-"));
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runProviders(parseArgs([
        "providers",
        "set",
        "--data-dir",
        dataDir,
        "--base-url",
        "https://api.example.com/v1",
        "--api-key",
        "sk-secret-1234",
        "--model",
        "example-model",
      ]), false)).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }
    await expect(readCliProviderProfile(dataDir)).resolves.toMatchObject({
      baseUrl: "https://api.example.com/v1",
      model: "example-model",
      apiKey: "sk-secret-1234",
    });
    expect(output).toContain(providerProfilePath(dataDir));
    expect(output).toContain("sk-s…1234");
    expect(output).not.toContain("sk-secret-1234");
  });
});
