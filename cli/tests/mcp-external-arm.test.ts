import { describe, expect, it } from "vitest";
import {
  buildExternalArmBrokerContract,
  buildExternalArmBrokerRequest,
  gelabZeroMcpArmExample,
  renderExternalMcpArmContract,
  summarizeExternalArmBrokerResponse,
  validateExternalMcpArmConfig,
} from "../src/mcp-external-arm.js";

describe("external MCP arm contract", () => {
  it("accepts a gelab-zero style MCP arm without merging external code into Lynn", () => {
    const arm = gelabZeroMcpArmExample();
    const validation = validateExternalMcpArmConfig(arm);

    expect(validation.ok).toBe(true);
    expect(validation.arm).toMatchObject({
      id: "gelab-zero",
      command: "python",
      args: ["mcp_server/detailed_gelab_mcp_server.py"],
      capability: "device",
    });

    const rendered = renderExternalMcpArmContract(arm);
    expect(rendered).toContain("External MCP arm contract");
    expect(rendered).toContain("do not merge external Python/ADB/device code into Lynn CLI");
    expect(rendered).toContain("external_arm.request");
    expect(rendered).toContain("do not expose the full MCP schema");
    expect(rendered).toContain("Fleet still trusts Lynn-side JSONL");
  });

  it("accepts configs that use a capabilities array from MCP-style metadata", () => {
    const validation = validateExternalMcpArmConfig({
      id: "phone-arm",
      command: "python",
      args: ["server.py"],
      capabilities: ["device"],
    });

    expect(validation.ok).toBe(true);
    expect(validation.arm).toMatchObject({ capability: "device" });
  });

  it("rejects shell-string commands and malformed args", () => {
    const validation = validateExternalMcpArmConfig({
      id: "bad",
      command: "python server.py && curl example.com",
      args: ["ok", 1],
      capability: "device",
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain("command must be a binary name/path, not a shell string");
    expect(validation.errors).toContain("args must contain only strings");
    expect(validation.arm).toBeNull();
  });

  it("builds a compact broker contract instead of exposing full MCP schemas", () => {
    const contract = buildExternalArmBrokerContract();

    expect(contract).toMatchObject({
      type: "external_arm.broker_contract",
      protocol: "lynn.external_arm.broker.v1",
      requestType: "external_arm.request",
      responseType: "external_arm.response",
      actions: ["start", "step", "status", "cancel", "artifacts"],
    });
    expect(JSON.stringify(contract)).not.toContain("tools");
    expect(contract.tokenPolicy).toContain("Do not expose full MCP tool schemas");
  });

  it("validates and bounds broker requests", () => {
    const arm = gelabZeroMcpArmExample();
    const validation = buildExternalArmBrokerRequest(arm, {
      action: "start",
      goal: ` ${"open app ".repeat(800)} `,
      constraints: Array.from({ length: 20 }, (_, i) => `constraint ${i} ${"x".repeat(260)}`),
      maxArtifacts: 99,
      timeoutMs: 999_999,
    });

    expect(validation.ok).toBe(true);
    expect(validation.request).toMatchObject({
      type: "external_arm.request",
      protocol: "lynn.external_arm.broker.v1",
      armId: "gelab-zero",
      capability: "device",
      action: "start",
      maxArtifacts: 10,
      timeoutMs: 600_000,
    });
    expect(validation.request?.goal?.length).toBe(4000);
    expect(validation.request?.constraints).toHaveLength(12);
    expect(validation.request?.constraints?.[0].length).toBeLessThanOrEqual(220);
  });

  it("requires task ids and observations for follow-up broker actions", () => {
    const arm = gelabZeroMcpArmExample();

    expect(buildExternalArmBrokerRequest(arm, { action: "status" })).toMatchObject({
      ok: false,
      errors: ["status requires taskId"],
    });
    expect(buildExternalArmBrokerRequest(arm, { action: "step", taskId: "t1" })).toMatchObject({
      ok: false,
      errors: ["step requires goal or observation"],
    });
    expect(buildExternalArmBrokerRequest(arm, { action: "step", taskId: "t1", observation: "screen changed" })).toMatchObject({
      ok: true,
      request: { action: "step", taskId: "t1", observation: "screen changed" },
    });
  });

  it("summarizes broker responses without dumping raw traces", () => {
    const summary = summarizeExternalArmBrokerResponse({
      type: "external_arm.response",
      protocol: "lynn.external_arm.broker.v1",
      armId: "gelab-zero",
      action: "step",
      taskId: "task-1",
      ok: true,
      status: "running",
      summary: "Observed a login screen with username and password fields.",
      actions: ["click username", "type account", "click password", "type password", "click login", "wait for dashboard"],
      artifacts: [
        { id: "a1", kind: "screenshot", path: "/tmp/1.png", summary: "login screen" },
        { id: "a2", kind: "trace", path: "/tmp/trace.jsonl", summary: "action trace" },
        { id: "a3", kind: "log", path: "/tmp/log.txt", summary: "driver log" },
      ],
    }, 2);

    expect(summary).toContain("external_arm gelab-zero step: ok (running)");
    expect(summary).toContain("actions: +1 more");
    expect(summary).toContain("artifact: screenshot /tmp/1.png - login screen");
    expect(summary).toContain("artifacts: +1 more");
  });
});
