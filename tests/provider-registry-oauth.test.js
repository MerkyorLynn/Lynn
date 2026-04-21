import { describe, expect, it } from "vitest";
import os from "os";
import path from "path";
import { ProviderRegistry } from "../core/provider-registry.js";

describe("ProviderRegistry OAuth builtins", () => {
  it("registers the OpenAI Codex OAuth provider with auth key mapping", () => {
    const reg = new ProviderRegistry(path.join(os.tmpdir(), "lynn-provider-registry-oauth-test"));
    const entry = reg.get("openai-codex-oauth");

    expect(entry).toBeTruthy();
    expect(entry?.authType).toBe("oauth");
    expect(entry?.displayName).toBe("OpenAI Codex (OAuth)");
    expect(reg.getAuthJsonKey("openai-codex-oauth")).toBe("openai-codex");
  });
});
