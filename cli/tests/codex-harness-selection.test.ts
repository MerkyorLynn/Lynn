import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeCodexAppServer,
  probeBrainHarnessSupport,
  resolveCodeHarnessSelection,
} from "../src/codex-harness-selection.js";

const fixture = fileURLToPath(new URL("../../tests/fixtures/fake-codex-app-server.mjs", import.meta.url));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Codex harness auto selection", () => {
  it("selects Codex only after a successful protocol probe", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    const brainProbe = vi.fn(async () => ({ supported: true, reason: "ready" }));
    const routeProbe = vi.fn(async () => undefined);
    await expect(resolveCodeHarnessSelection({ requested: "auto", cwd: ".", brainUrl: "http://brain", ultra: false, probe, brainProbe, routeProbe })).resolves.toMatchObject({
      requested: "auto",
      selected: "codex",
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(routeProbe).toHaveBeenCalledOnce();
  });

  it("falls back before a run when the protocol probe fails", async () => {
    const probe = vi.fn(async (): Promise<"v2-camel"> => { throw new Error("unsupported protocol"); });
    await expect(resolveCodeHarnessSelection({ requested: "auto", cwd: ".", brainUrl: "http://brain", ultra: false, probe, brainProbe: async () => ({ supported: true, reason: "ready" }) })).resolves.toMatchObject({
      requested: "auto",
      selected: "legacy",
      reason: expect.stringContaining("unsupported protocol"),
    });
  });

  it("keeps ultra on the legacy loop without probing", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    await expect(resolveCodeHarnessSelection({ requested: "auto", cwd: ".", brainUrl: "http://brain", ultra: true, probe })).resolves.toMatchObject({ selected: "legacy" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps attached media on Lynn's verified multimodal bridge without probing", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      hasMedia: true,
      probe,
    })).resolves.toMatchObject({ selected: "legacy", reason: expect.stringContaining("multimodal bridge") });
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps JSON auditing and deny-all on legacy while allowing ask after both probes", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    const routeProbe = vi.fn(async () => undefined);
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      machineReadable: true,
      approval: "yolo",
      probe,
    })).resolves.toMatchObject({ selected: "legacy", reason: expect.stringContaining("per-tool audit") });
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      approval: "ask",
      probe,
      brainProbe: async () => ({ supported: true, reason: "ready" }),
      routeProbe,
    })).resolves.toMatchObject({ selected: "codex", protocol: "v2-camel" });
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      approval: "never",
      probe,
    })).resolves.toMatchObject({ selected: "legacy", reason: expect.stringContaining("strict tool-approval") });
    expect(probe).toHaveBeenCalledOnce();
    expect(routeProbe).toHaveBeenCalledOnce();
  });

  it("rejects an unauthenticated remote BYOK route before probing", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      provider: { provider: "openai-compatible", baseUrl: "https://example.com/v1", model: "test" },
      probe,
    })).resolves.toMatchObject({ selected: "legacy", reason: expect.stringContaining("no API key") });
    expect(probe).not.toHaveBeenCalled();
  });

  it("allows a keyless loopback provider to use the protocol probe", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      provider: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:18098/v1", model: "local" },
      probe,
      routeProbe: async () => undefined,
    })).resolves.toMatchObject({ selected: "codex" });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("preserves explicit modes and validates the explicit Codex/ultra conflict", async () => {
    await expect(resolveCodeHarnessSelection({ requested: "legacy", cwd: ".", brainUrl: "http://brain", ultra: false })).resolves.toMatchObject({ selected: "legacy" });
    const routeProbe = vi.fn(async () => undefined);
    await expect(resolveCodeHarnessSelection({ requested: "codex", cwd: ".", brainUrl: "http://brain", ultra: false, probe: async () => "v2-camel", routeProbe })).resolves.toMatchObject({ selected: "codex", protocol: "v2-camel" });
    await expect(resolveCodeHarnessSelection({ requested: "codex", cwd: ".", brainUrl: "http://brain", ultra: true })).rejects.toThrow(/cannot be combined/);
    await expect(resolveCodeHarnessSelection({ requested: "codex", cwd: ".", brainUrl: "http://brain", ultra: false, hasMedia: true })).rejects.toThrow(/multimodal attachment bridge/);
    await expect(resolveCodeHarnessSelection({ requested: "codex", cwd: ".", brainUrl: "http://brain", ultra: false, machineReadable: true })).rejects.toThrow(/JSON audit stream/);
    await expect(resolveCodeHarnessSelection({ requested: "codex", cwd: ".", brainUrl: "http://brain", ultra: false, approval: "ask", probe: async () => "hybrid-kebab-thread", routeProbe })).resolves.toMatchObject({ selected: "codex", protocol: "hybrid-kebab-thread" });
    await expect(resolveCodeHarnessSelection({ requested: "codex", cwd: ".", brainUrl: "http://brain", ultra: false, approval: "never" })).rejects.toThrow(/approval semantics/);
    expect(routeProbe).toHaveBeenCalledTimes(2);
  });

  it("rejects explicit Codex mode when the authenticated route preflight fails", async () => {
    await expect(resolveCodeHarnessSelection({
      requested: "codex",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      probe: async () => "v2-camel",
      routeProbe: async () => { throw new Error("model is unavailable"); },
    })).rejects.toThrow(/model is unavailable/);
  });

  it("falls back when the authenticated provider/model route probe fails", async () => {
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      approval: "ask",
      probe: async () => "v2-camel",
      brainProbe: async () => ({ supported: true, reason: "ready" }),
      routeProbe: async () => { throw new Error("invalid API key or unsupported model"); },
    })).resolves.toMatchObject({
      selected: "legacy",
      reason: expect.stringContaining("invalid API key or unsupported model"),
    });
  });

  it("falls back when the current Brain does not declare Responses compatibility", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    await expect(resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://legacy-brain",
      ultra: false,
      probe,
      brainProbe: async () => ({ supported: false, reason: "Brain does not declare compatibility" }),
    })).resolves.toMatchObject({ selected: "legacy", reason: expect.stringContaining("does not declare") });
    expect(probe).not.toHaveBeenCalled();
  });

  it("accepts only a usable Brain route with explicit harness capabilities", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      route: ["stepfun"],
      providers: [{
        id: "stepfun",
        model: "step-3.7-flash",
        endpoint: "https://example.invalid",
        wire: "openai",
        credential: "set",
        configured: true,
        local: false,
        inRoute: true,
      }],
      capabilities: { responses: true, appServerHarness: true },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(probeBrainHarnessSupport("http://127.0.0.1:3950")).resolves.toEqual({
      supported: true,
      reason: "Brain Responses route is ready",
    });
  });

  it("defers to the authenticated route probe when the optional Brain status endpoint is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("status blocked"); }));
    await expect(probeBrainHarnessSupport("http://127.0.0.1:3950")).resolves.toEqual({
      supported: true,
      reason: expect.stringContaining("authenticated Responses route preflight"),
    });
  });

  it("performs a real initialize/initialized handshake with the shared client", async () => {
    await expect(probeCodexAppServer({
      command: process.execPath,
      commandArgs: [fixture],
      cwd: path.dirname(fixture),
      requestTimeoutMs: 2_000,
    })).resolves.toMatch(/^(v2-camel|hybrid-kebab-thread|legacy-kebab)$/);
  });

  it("accepts a cold thread startup lasting longer than five seconds", async () => {
    await expect(probeCodexAppServer({
      command: process.execPath,
      commandArgs: [fixture, "slow-thread-start"],
      cwd: path.dirname(fixture),
    })).resolves.toBe("v2-camel");
  });

  it("still respects an explicit shorter protocol timeout", async () => {
    await expect(probeCodexAppServer({
      command: process.execPath,
      commandArgs: [fixture, "slow-thread-start"],
      cwd: path.dirname(fixture),
      requestTimeoutMs: 100,
    })).rejects.toThrow("timed out: thread/start");
  });

  it("forces the native loop for plan mode even when Codex was requested", async () => {
    const probe = vi.fn(async () => "v2-camel" as const);
    const result = await resolveCodeHarnessSelection({
      requested: "codex",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      planMode: true,
      probe,
    });
    expect(result.selected).toBe("legacy");
    expect(result.reason).toContain("plan mode");
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps auto on the native loop when hooks are configured", async () => {
    const result = await resolveCodeHarnessSelection({
      requested: "auto",
      cwd: ".",
      brainUrl: "http://brain",
      ultra: false,
      hasHooks: true,
    });
    expect(result).toMatchObject({ selected: "legacy", reason: expect.stringContaining("hooks") });
  });
});
