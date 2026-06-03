import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  isPidAlive,
  pollServerInfo,
  isReusableServerHealth,
  resolveAecNativeDir,
  injectWindowsGitPath,
  resolveBundledServerLaunch,
  createServerProcessController,
} = require("../server-process.cjs");

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-sp-"));
  return path.join(dir, name);
}

describe("isPidAlive", () => {
  it("reports the current process alive and a dead pid not alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    // injected fake proc whose kill throws (ESRCH) → not alive
    const fakeProc = { kill: () => { throw new Error("ESRCH"); } };
    expect(isPidAlive(999999, fakeProc as unknown as NodeJS.Process)).toBe(false);
  });
});

describe("pollServerInfo", () => {
  it("resolves with the parsed info once the file exists and the PID is alive", async () => {
    const p = tmpFile("server-info.json");
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, port: 4321, token: "tok" }));
    const info = await pollServerInfo(p, { interval: 5 });
    expect(info).toEqual({ pid: process.pid, port: 4321, token: "tok" });
  });

  it("rejects with the localized timeout message when the file never appears", async () => {
    const p = tmpFile("never.json");
    const mt = (key: string, _vars: unknown, fallback: string) => `MT:${key}:${fallback ?? ""}`;
    await expect(pollServerInfo(p, { timeout: 40, interval: 5, mt })).rejects.toThrow(
      "MT:dialog.serverStartTimeout",
    );
  });

  it("rejects fast (via injected mt) when the child process exits", async () => {
    const p = tmpFile("exit.json");
    const proc = new EventEmitter();
    const mt = (key: string) => `MT:${key}`;
    const pending = pollServerInfo(p, { timeout: 5000, interval: 5, process: proc, mt });
    proc.emit("exit", 1, null);
    await expect(pending).rejects.toThrow("MT:dialog.serverExitedWithCode");
  });
});

describe("isReusableServerHealth", () => {
  const okFeatures = { translateRoute: true, toolsRoute: true };

  it("accepts a healthy server with the required feature routes", () => {
    expect(isReusableServerHealth({ status: "ok", features: okFeatures })).toBe(true);
  });

  it("rejects non-ok / missing health", () => {
    expect(isReusableServerHealth(null)).toBe(false);
    expect(isReusableServerHealth({ status: "degraded", features: okFeatures })).toBe(false);
  });

  it("rejects when a required feature route is missing (stale server)", () => {
    expect(isReusableServerHealth({ status: "ok", features: { translateRoute: true } })).toBe(false);
    expect(isReusableServerHealth({ status: "ok", features: {} })).toBe(false);
  });

  it("rejects on version mismatch when expectedVersion is provided", () => {
    const health = { status: "ok", version: "0.80.5", features: okFeatures };
    expect(isReusableServerHealth(health, "0.80.6")).toBe(false);
    expect(isReusableServerHealth(health, "0.80.5")).toBe(true);
    expect(isReusableServerHealth(health)).toBe(true); // version not enforced without expectedVersion
  });
});

describe("resolveAecNativeDir", () => {
  it("returns the dev dir when it exists (non-asar)", () => {
    const dirname = path.join(path.sep, "app");
    const dev = path.join(dirname, "native-modules", "aec");
    const existsSync = (p: string) => p === dev;
    expect(resolveAecNativeDir({ dirname, existsSync })).toBe(dev);
  });

  it("returns null when no aec dir exists", () => {
    const dirname = path.join(path.sep, "app");
    expect(resolveAecNativeDir({ dirname, existsSync: () => false })).toBeNull();
  });

  it("prefers the app.asar.unpacked dir in a packaged build", () => {
    const dirname = path.join(path.sep, "x", "app.asar", "desktop");
    const unpacked = path.join(
      dirname.replace("app.asar", "app.asar.unpacked"),
      "native-modules",
      "aec",
    );
    const existsSync = (p: string) => p === unpacked;
    expect(resolveAecNativeDir({ dirname, existsSync })).toBe(unpacked);
  });
});

describe("injectWindowsGitPath", () => {
  it("is a no-op on non-win32", () => {
    const env: Record<string, string> = { PATH: "/usr/bin" };
    const out = injectWindowsGitPath(env, { platform: "darwin", resourcesPath: "/r", existsSync: () => true });
    expect(out.PATH).toBe("/usr/bin");
  });

  it("prepends MinGit paths and collapses a 'Path' casing duplicate on win32", () => {
    const gitRoot = path.join("C:\\res", "git");
    const mingw = path.join(gitRoot, "mingw64", "bin");
    const cmd = path.join(gitRoot, "cmd");
    const env: Record<string, string> = { Path: "C:\\system32" }; // title-case key
    const out = injectWindowsGitPath(env, {
      platform: "win32",
      resourcesPath: "C:\\res",
      existsSync: (p: string) => p === mingw || p === cmd,
    });
    expect(out.Path).toBeUndefined(); // duplicate casing key removed
    expect(out.PATH).toBe(`${mingw};${cmd};C:\\system32`);
  });

  it("leaves env unchanged on win32 when no git paths exist", () => {
    const env: Record<string, string> = { PATH: "C:\\system32" };
    const out = injectWindowsGitPath(env, { platform: "win32", resourcesPath: "C:\\res", existsSync: () => false });
    expect(out.PATH).toBe("C:\\system32");
  });
});

describe("resolveBundledServerLaunch", () => {
  const base = { resourcesPath: path.join(path.sep, "res"), dirname: path.join(path.sep, "app", "desktop"), execPath: "/usr/bin/electron" };
  const serverDir = path.join(base.resourcesPath, "server");

  it("uses the dev server bundle when it is already built", () => {
    const devBundle = path.join(base.dirname, "..", "dist-server-bundle", "index.js");
    const out = resolveBundledServerLaunch({
      ...base,
      platform: "darwin",
      existsSync: (p: string) => p === devBundle,
    });
    expect(out.mode).toBe("dev");
    expect(out.serverBin).toBe(base.execPath);
    expect(out.serverArgs).toEqual([devBundle]);
    expect(out.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("falls back to tsx + server/index.ts in dev when no server bundle exists", () => {
    const tsEntry = path.join(base.dirname, "..", "server", "index.ts");
    const out = resolveBundledServerLaunch({
      ...base,
      platform: "darwin",
      existsSync: (p: string) => p === tsEntry,
    });
    expect(out.mode).toBe("dev");
    expect(out.serverBin).toBe(base.execPath);
    expect(out.serverArgs).toEqual(["--import", "tsx", tsEntry]);
    expect(out.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("keeps the legacy server/index.js dev fallback when neither bundle nor ts entry exists", () => {
    const out = resolveBundledServerLaunch({ ...base, platform: "darwin", existsSync: () => false });
    expect(out.mode).toBe("dev");
    expect(out.serverBin).toBe(base.execPath);
    expect(out.serverArgs).toEqual([path.join(base.dirname, "..", "server", "index.js")]);
    expect(out.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("uses the node runtime + bundle entry when the bundled node runtime is present", () => {
    const node = path.join(serverDir, "node");
    const entry = path.join(serverDir, "bundle", "index.js");
    const out = resolveBundledServerLaunch({
      ...base,
      platform: "linux",
      existsSync: (p: string) => p === node || p === entry,
    });
    expect(out.mode).toBe("bundled");
    expect(out.serverBin).toBe(node);
    expect(out.serverArgs).toEqual([entry]);
    expect(out.env).toEqual({ HANA_ROOT: serverDir });
  });

  it("uses lynn-server.exe + bundle entry on win32", () => {
    const exe = path.join(serverDir, "lynn-server.exe");
    const entry = path.join(serverDir, "bundle", "index.js");
    const out = resolveBundledServerLaunch({
      ...base,
      platform: "win32",
      existsSync: (p: string) => p === exe || p === entry,
    });
    expect(out.mode).toBe("bundled");
    expect(out.serverBin).toBe(exe);
    expect(out.serverArgs).toEqual([entry]);
  });

  it("falls back to the shell wrapper (no args) when only the wrapper exists", () => {
    const wrapper = path.join(serverDir, "lynn-server");
    const out = resolveBundledServerLaunch({
      ...base,
      platform: "darwin",
      existsSync: (p: string) => p === wrapper,
    });
    expect(out.mode).toBe("bundled");
    expect(out.serverBin).toBe(wrapper);
    expect(out.serverArgs).toEqual([]);
  });
});

describe("createServerProcessController.start (fake deps — no Electron)", () => {
  function baseDeps(lynnHome: string, overrides: Record<string, unknown> = {}) {
    return {
      app: { getVersion: () => "1.2.3" },
      fetch: async () => { throw new Error("fetch should not be called in this path"); },
      spawn: () => { throw new Error("spawn should not be called in this path"); },
      fs,
      mt: (k: string) => k,
      lynnHome,
      dirname: path.join(lynnHome, "app"),
      resourcesPath: path.join(lynnHome, "res"),
      execPath: "/usr/bin/electron",
      platform: "darwin",
      env: { EXISTING: "1" },
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      getWorkerSpawnServerEnv: () => ({}),
      readBrainRuntimeConfig: () => ({}),
      killPid: () => {},
      onLocalAuthHeaderNeeded: () => {},
      ...overrides,
    };
  }

  function fakeChild() {
    let unreffed = false;
    let killed: string | true | null = null;
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    return {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      // pollServerInfo (startup) + monitor() both attach 'exit' handlers; capture
      // the last so tests can simulate a crash via emit().
      on: (event: string, fn: (...a: unknown[]) => void) => { handlers[event] = fn; },
      emit: (event: string, ...args: unknown[]) => handlers[event] && handlers[event](...args),
      get killed() { return !!killed; },
      kill: (signal?: string) => {
        killed = signal || true;
        if (handlers.exit) handlers.exit(null, signal || null);
      },
      killedWith: () => killed,
      unref: () => { unreffed = true; },
      wasUnreffed: () => unreffed,
    };
  }

  it("reuses a live, healthy existing server without spawning", async () => {
    const lynnHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ctl-")));
    // existing server-info points at us (process.pid is alive) → reusable
    fs.writeFileSync(
      path.join(lynnHome, "server-info.json"),
      JSON.stringify({ pid: process.pid, port: 4444, token: "reused" }),
    );
    let authHookCalls = 0;
    const ctl = createServerProcessController(baseDeps(lynnHome, {
      fetch: async () => ({
        ok: true,
        json: async () => ({ status: "ok", version: "1.2.3", features: { translateRoute: true, toolsRoute: true } }),
      }),
      onLocalAuthHeaderNeeded: () => { authHookCalls++; },
      // spawn stays the throwing default → asserts we never spawn on the reuse path
    }));
    await ctl.start();
    expect(ctl.getPort()).toBe(4444);
    expect(ctl.getToken()).toBe("reused");
    expect(ctl.getState().reusedPid).toBe(process.pid);
    expect(ctl.getState().process).toBeNull(); // never spawned
    expect(authHookCalls).toBe(1);
  });

  it("spawns a new server and resolves port/token from the info file", async () => {
    const lynnHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ctl-")));
    const child = fakeChild();
    let authHookCalls = 0;
    const ctl = createServerProcessController(baseDeps(lynnHome, {
      spawn: () => {
        // simulate the spawned server writing its info file (live pid → poll resolves)
        fs.writeFileSync(
          path.join(lynnHome, "server-info.json"),
          JSON.stringify({ pid: process.pid, port: 5555, token: "spawned" }),
        );
        return child;
      },
      onLocalAuthHeaderNeeded: () => { authHookCalls++; },
    }));
    await ctl.start();
    expect(ctl.getPort()).toBe(5555);
    expect(ctl.getToken()).toBe("spawned");
    expect(ctl.getState().process).toBe(child);
    expect(child.wasUnreffed()).toBe(true);
    expect(authHookCalls).toBe(1);
  });

  it("getLogs returns the live (in-place) logs array across restarts", async () => {
    const lynnHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ctl-")));
    const ctl = createServerProcessController(baseDeps(lynnHome, {
      spawn: () => {
        fs.writeFileSync(
          path.join(lynnHome, "server-info.json"),
          JSON.stringify({ pid: process.pid, port: 6666, token: "t" }),
        );
        return fakeChild();
      },
    }));
    const logsRef = ctl.getLogs();
    await ctl.start();
    // start() clears logs in place, so the reference a proxy captured stays valid
    expect(ctl.getLogs()).toBe(logsRef);
  });

  // ── S3: monitor + heartbeat ────────────────────────────────────────────────

  it("auto-restarts once on unexpected server exit and notifies onServerRestarted", async () => {
    const lynnHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ctl-")));
    let port = 7001;
    let restarted: unknown = null;
    let resolveRestart: () => void = () => {};
    const restartDone = new Promise<void>((r) => { resolveRestart = r; });
    const ctl = createServerProcessController(baseDeps(lynnHome, {
      spawn: () => {
        fs.writeFileSync(path.join(lynnHome, "server-info.json"), JSON.stringify({ pid: process.pid, port: port++, token: "t" }));
        return fakeChild();
      },
      onServerRestarted: (p: unknown) => { restarted = p; resolveRestart(); },
    }));
    await ctl.start();
    ctl.monitor();
    expect(ctl.getState().restartAttempts).toBe(0);
    ctl.getState().process.emit("exit", 1, null); // simulate crash
    await restartDone;
    expect(ctl.getState().restartAttempts).toBe(1);
    expect(restarted).toMatchObject({ token: "t" });
  });

  it("gives up after a second crash — writeCrashLog, no restart", async () => {
    const lynnHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ctl-")));
    let restartCalls = 0;
    let crashLogs = 0;
    const ctl = createServerProcessController(baseDeps(lynnHome, {
      spawn: () => {
        fs.writeFileSync(path.join(lynnHome, "server-info.json"), JSON.stringify({ pid: process.pid, port: 7100, token: "t" }));
        return fakeChild();
      },
      onServerRestarted: () => { restartCalls++; },
      writeCrashLog: () => { crashLogs++; },
    }));
    await ctl.start();
    ctl.getState().restartAttempts = 1; // the one allowed restart is already used
    ctl.monitor();
    ctl.getState().process.emit("exit", null, "SIGSEGV");
    await Promise.resolve();
    expect(crashLogs).toBe(1);
    expect(restartCalls).toBe(0);
  });

  it("heartbeat restarts the server after MAX consecutive failures", async () => {
    const lynnHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ctl-")));
    let restarted = false;
    const ctl = createServerProcessController(baseDeps(lynnHome, {
      fetch: async () => { throw new Error("server down"); },
      spawn: () => {
        fs.writeFileSync(path.join(lynnHome, "server-info.json"), JSON.stringify({ pid: process.pid, port: 7200, token: "t" }));
        return fakeChild();
      },
      onServerRestarted: () => { restarted = true; },
    }));
    // set creds directly so startedAt stays 0 → startup grace window is skipped
    const st = ctl.getState();
    st.port = 7000; st.token = "t"; st.startedAt = 0;
    for (let i = 0; i < 6; i++) await ctl.checkHeartbeat();
    expect(restarted).toBe(true);
  });

  it("heartbeat resets the failure counter when the server is healthy", async () => {
    const lynnHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ctl-")));
    const ctl = createServerProcessController(baseDeps(lynnHome, {
      fetch: async () => ({
        ok: true,
        json: async () => ({ status: "ok", version: "1.2.3", features: { translateRoute: true, toolsRoute: true } }),
      }),
    }));
    const st = ctl.getState();
    st.port = 7000; st.token = "t"; st.startedAt = 0; st.heartbeatFailures = 3;
    await ctl.checkHeartbeat();
    expect(ctl.getState().heartbeatFailures).toBe(0);
  });

  it("shutdown stops heartbeat and terminates a spawned server process", async () => {
    const lynnHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ctl-")));
    const child = fakeChild();
    const ctl = createServerProcessController(baseDeps(lynnHome, {
      spawn: () => {
        fs.writeFileSync(path.join(lynnHome, "server-info.json"), JSON.stringify({ pid: process.pid, port: 7300, token: "t" }));
        return child;
      },
      shutdownGraceMs: 5,
    }));
    await ctl.start();
    ctl.startHeartbeat();
    expect(ctl.hasServer()).toBe(true);
    const didShutdown = await ctl.shutdown();
    expect(didShutdown).toBe(true);
    expect(child.killedWith()).toBe("SIGTERM");
    expect(ctl.getState().process).toBeNull();
    expect(ctl.getState().heartbeatTimer).toBeNull();
    expect(ctl.hasServer()).toBe(false);
  });

  it("shutdown closes a reused server through the HTTP endpoint", async () => {
    const lynnHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-ctl-")));
    fs.writeFileSync(
      path.join(lynnHome, "server-info.json"),
      JSON.stringify({ pid: process.pid, port: 7400, token: "reuse-token" }),
    );
    const requests: Array<{ url: string; headers?: Record<string, string>; method?: string }> = [];
    let killCalls = 0;
    const ctl = createServerProcessController(baseDeps(lynnHome, {
      fetch: async (url: string, options: { headers?: Record<string, string>; method?: string } = {}) => {
        requests.push({ url, headers: options.headers, method: options.method });
        if (url.includes("/api/health")) {
          return {
            ok: true,
            json: async () => ({ status: "ok", version: "1.2.3", features: { translateRoute: true, toolsRoute: true } }),
          };
        }
        return { ok: true, json: async () => ({}) };
      },
      killPid: () => { killCalls++; },
      reusedShutdownGraceMs: 0,
    }));
    await ctl.start();
    expect(ctl.getState().reusedPid).toBe(process.pid);
    const didShutdown = await ctl.shutdown();
    expect(didShutdown).toBe(true);
    expect(requests.some((r) => r.url.endsWith("/api/shutdown") && r.method === "POST" && r.headers?.Authorization === "Bearer reuse-token")).toBe(true);
    expect(killCalls).toBe(1); // final force-kill safeguard after the zero-ms wait in this test
    expect(ctl.getState().reusedPid).toBeNull();
  });
});
