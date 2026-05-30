import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import { renderDoctor, runDoctor } from "../src/commands/doctor.js";
import { writeCliProviderProfile } from "../src/provider-profile.js";

describe("doctor command", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("supports offline diagnostics", async () => {
    const result = await runDoctor(parseArgs(["doctor", "--offline"]));

    expect(result.ok).toBe(true);
    expect(result.brain).toBe("skipped");
    expect(result.checks.some((check) => check.name === "node")).toBe(true);
    expect(result.cliProvider.configured).toBe(false);
    expect(result.presets).toContain("mimo:mimo-v2.5-pro");
    expect(renderDoctor(result)).toContain("optional CLI-only BYOK");
    expect(renderDoctor(result)).toContain("Lynn providers set --preset stepfun --api-key <api-key>");
    expect(renderDoctor(result)).toContain("mimo:mimo-v2.5-pro");
  });

  it("reads Brain v2 provider route status without requiring CLI BYOK", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (href.endsWith("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200, statusText: "OK" });
      if (href.endsWith("/v1/providers/status")) {
        return new Response(JSON.stringify({
          ok: true,
          route: ["step-3.7-flash", "mimo", "apex-spark-i-balanced"],
          providers: [
            { id: "step-3.7-flash", model: "step-3.7-flash", endpoint: "https://api.stepfun.com/step_plan/v1", wire: "openai", credential: "set", configured: true, local: false, inRoute: true },
            { id: "mimo", model: "mimo-v2.5-pro", endpoint: "https://token-plan-cn.xiaomimimo.com/v1", wire: "mimo", credential: "set", configured: true, local: false, inRoute: true },
            { id: "apex-spark-i-balanced", model: "qwen36", endpoint: "http://127.0.0.1:18098/v1", wire: "openai", credential: "not_required", configured: true, local: true, inRoute: true },
          ],
        }), { status: 200, statusText: "OK" });
      }
      if (href.endsWith("/v1/chat/completions")) {
        return new Response([
          'data: {"object":"lynn.provider","meta":{"active_provider":"step-3.7-flash"}}',
          "",
          'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}',
          "",
        ].join("\n"), { status: 200, statusText: "OK" });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }));

    const result = await runDoctor(parseArgs(["doctor", "--brain-url", "http://127.0.0.1:8790"]));
    const rendered = renderDoctor(result);

    expect(result.brain).toBe("ok");
    expect(result.ok).toBe(true);
    expect(result.brainSmoke).toMatchObject({ ok: true, provider: "step-3.7-flash" });
    expect(result.brainProviders?.route[0]).toBe("step-3.7-flash");
    expect(rendered).toContain("brain-route: StepFun 3.7 Flash:key -> MiMo V2.5 Pro:key -> Spark Qwen 3.6 35B A3B:local");
    expect(rendered).toContain("head ready: StepFun 3.7 Flash; fallback ready: MiMo V2.5 Pro, Spark Qwen 3.6 35B A3B");
    expect(rendered).toContain("brain-smoke: route returned assistant output via step-3.7-flash");
  });

  it("uses chat smoke when hosted Brain does not expose provider route status", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (href.endsWith("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200, statusText: "OK" });
      if (href.endsWith("/v1/providers/status")) return new Response("not found", { status: 404, statusText: "Not Found" });
      if (href.endsWith("/v1/chat/completions")) {
        return new Response([
          'data: {"object":"lynn.provider","meta":{"active_provider":"mimo"}}',
          "",
          'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}',
          "",
        ].join("\n"), { status: 200, statusText: "OK" });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }));

    const result = await runDoctor(parseArgs(["doctor", "--brain-url", "https://api.merkyorlynn.com/api/v2"]));
    const rendered = renderDoctor(result);

    expect(result.brain).toBe("ok");
    expect(result.ok).toBe(true);
    expect(result.brainProviders).toBeNull();
    expect(result.brainSmoke).toMatchObject({ ok: true, provider: "mimo" });
    expect(rendered).toContain("brain-route: provider status unavailable; verifying route with chat smoke");
    expect(rendered).toContain("brain-smoke: route returned assistant output via mimo");
  });

  it("fails Brain route diagnostics when no provider in the route is configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (href.endsWith("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200, statusText: "OK" });
      if (href.endsWith("/v1/providers/status")) {
        return new Response(JSON.stringify({
          ok: true,
          route: ["step-3.7-flash", "mimo"],
          providers: [
            { id: "step-3.7-flash", model: "step-3.7-flash", endpoint: "https://api.stepfun.com/step_plan/v1", wire: "openai", credential: "missing", configured: false, local: false, inRoute: true },
            { id: "mimo", model: "mimo-v2.5-pro", endpoint: "https://token-plan-cn.xiaomimimo.com/v1", wire: "mimo", credential: "missing", configured: false, local: false, inRoute: true },
          ],
        }), { status: 200, statusText: "OK" });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }));

    const result = await runDoctor(parseArgs(["doctor", "--brain-url", "http://127.0.0.1:8790"]));
    const rendered = renderDoctor(result);

    expect(result.ok).toBe(false);
    expect(rendered).toContain("FAIL brain-route");
    expect(rendered).toContain("no configured provider in route");
  });

  it("fails Brain diagnostics when the route status is usable but the chat smoke fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (href.endsWith("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200, statusText: "OK" });
      if (href.endsWith("/v1/providers/status")) {
        return new Response(JSON.stringify({
          ok: true,
          route: ["step-3.7-flash", "mimo"],
          providers: [
            { id: "step-3.7-flash", model: "step-3.7-flash", endpoint: "https://api.stepfun.com/step_plan/v1", wire: "openai", credential: "set", configured: true, local: false, inRoute: true },
            { id: "mimo", model: "mimo-v2.5-pro", endpoint: "https://token-plan-cn.xiaomimimo.com/v1", wire: "mimo", credential: "set", configured: true, local: false, inRoute: true },
          ],
        }), { status: 200, statusText: "OK" });
      }
      if (href.endsWith("/v1/chat/completions")) {
        return new Response([
          'data: {"object":"lynn.provider","meta":{"active_provider":"step-3.7-flash"}}',
          "",
          'data: {"object":"lynn.error","error":"all providers failed","code":"all_providers_failed"}',
          "",
        ].join("\n"), { status: 200, statusText: "OK" });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }));

    const result = await runDoctor(parseArgs(["doctor", "--brain-url", "http://127.0.0.1:8790"]));
    const rendered = renderDoctor(result);

    expect(result.ok).toBe(false);
    expect(result.brainSmoke).toMatchObject({ ok: false, provider: "step-3.7-flash" });
    expect(rendered).toContain("FAIL brain-smoke");
    expect(rendered).toContain("all providers failed (all_providers_failed) via step-3.7-flash");
  });

  it("reports configured CLI BYOK without exposing the raw key", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-doctor-"));
    await writeCliProviderProfile(dataDir, {
      provider: "openai-compatible",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      model: "mimo-v2.5-pro",
      apiKey: "mimo-doctor-secret",
    });

    const result = await runDoctor(parseArgs(["doctor", "--offline", "--data-dir", dataDir]));
    const rendered = renderDoctor(result);

    expect(result.cliProvider).toMatchObject({
      configured: true,
      provider: "openai-compatible",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      model: "mimo-v2.5-pro",
    });
    expect(result.cliProvider.apiKey).not.toBe("mimo-doctor-secret");
    expect(rendered).toContain("mimo-v2.5-pro");
    expect(rendered).not.toContain("mimo-doctor-secret");
  });
});
