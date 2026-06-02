import { describe, expect, it } from "vitest";
import { gelabZeroMcpArmExample, renderExternalMcpArmContract, validateExternalMcpArmConfig } from "../src/mcp-external-arm.js";

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
    expect(rendered).toContain("Fleet still trusts Lynn-side JSONL");
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
});
