import { describe, it, expect } from "vitest";
import { createPluginContext } from "../core/plugin-context.js";

describe("createPluginContext", () => {
  it("returns ctx with all required properties", () => {
    const bus = { emit() {}, subscribe() {} };
    const engine = { currentAgentId: "lynn-main" };
    const ctx = createPluginContext({
      pluginId: "test-plugin",
      pluginDir: "/plugins/test-plugin",
      dataDir: "/plugin-data/test-plugin",
      bus,
      engine,
    });
    expect(ctx.pluginId).toBe("test-plugin");
    expect(ctx.pluginDir).toBe("/plugins/test-plugin");
    expect(ctx.dataDir).toBe("/plugin-data/test-plugin");
    expect(ctx.bus).toBe(bus);
    expect(ctx.engine).toBe(engine);
    expect(ctx.log).toBeDefined();
    expect(ctx.config).toBeDefined();
    expect(typeof ctx.config.get).toBe("function");
    expect(typeof ctx.config.set).toBe("function");
  });

  it("config.get/set reads and writes plugin-data config.json", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmpDir = path.join(os.tmpdir(), "hana-ctx-test-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const ctx = createPluginContext({
        pluginId: "x", pluginDir: "/tmp", dataDir: tmpDir, bus: {}, engine: null,
      });
      ctx.config.set("foo", 42);
      expect(ctx.config.get("foo")).toBe(42);
      const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"));
      expect(raw.foo).toBe(42);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("log has scoped prefix", () => {
    const ctx = createPluginContext({
      pluginId: "my-plug", pluginDir: "/tmp", dataDir: "/tmp", bus: {}, engine: null,
    });
    expect(typeof ctx.log.info).toBe("function");
    expect(typeof ctx.log.error).toBe("function");
  });
});
