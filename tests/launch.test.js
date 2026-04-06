import { describe, expect, it, vi } from "vitest";
import { canLoadBetterSqlite3, resolveLaunchPlan } from "../scripts/launch.js";

describe("scripts/launch", () => {
  it("detects when better-sqlite3 can be opened by current runtime", () => {
    class FakeDatabase {
      close() {}
    }
    const requireFn = vi.fn((id) => {
      if (id === "better-sqlite3") return FakeDatabase;
      throw new Error(`unexpected module: ${id}`);
    });

    expect(canLoadBetterSqlite3(requireFn)).toBe(true);
    expect(requireFn).toHaveBeenCalledWith("better-sqlite3");
  });

  it("falls back to Electron runtime for server when better-sqlite3 ABI is incompatible", () => {
    const requireFn = vi.fn((id) => {
      if (id === "better-sqlite3") {
        throw new Error("NODE_MODULE_VERSION mismatch");
      }
      if (id === "electron") return "/Applications/Electron.app/Contents/MacOS/Electron";
      throw new Error(`unexpected module: ${id}`);
    });

    const plan = resolveLaunchPlan({
      mode: "server",
      extra: ["--inspect"],
      env: {},
      execPath: "/usr/local/bin/node",
      requireFn,
      nodeVersion: "v24.14.0",
    });

    expect(plan.bin).toBe("/Applications/Electron.app/Contents/MacOS/Electron");
    expect(plan.args).toEqual(["server/index.js", "--inspect"]);
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(plan.warning).toContain("自动切换到 Electron 运行时");
  });

  it("uses current Node for server when better-sqlite3 loads successfully", () => {
    class FakeDatabase {
      close() {}
    }
    const requireFn = vi.fn((id) => {
      if (id === "better-sqlite3") return FakeDatabase;
      if (id === "electron") return "/Applications/Electron.app/Contents/MacOS/Electron";
      throw new Error(`unexpected module: ${id}`);
    });

    const plan = resolveLaunchPlan({
      mode: "server",
      extra: ["--port", "9999"],
      env: {},
      execPath: "/usr/local/bin/node",
      requireFn,
    });

    expect(plan.bin).toBe("/usr/local/bin/node");
    expect(plan.args).toEqual(["server/index.js", "--port", "9999"]);
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(plan.warning).toBeNull();
  });
});
