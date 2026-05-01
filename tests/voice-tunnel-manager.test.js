/**
 * voice-tunnel-manager 单测 · Lynn V0.79+ 2026-05-01
 *
 * 验证 spawn / health / standby / 跨平台 / 失败回退 / 退出清理。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { VoiceTunnelManager } from "../desktop/voice-tunnel-manager.cjs";

class FakeSshChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 99999;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }
  kill() { this.killed = true; this.emit("exit", 0, "SIGTERM"); return true; }
}

function makeFakeSpawn() {
  const calls = [];
  const children = [];
  const fn = (cmd, args, opts) => {
    const child = new FakeSshChild();
    calls.push({ cmd, args, opts });
    children.push(child);
    return child;
  };
  fn.calls = calls;
  fn.children = children;
  return fn;
}

function makeFakeHttp({ statusFor = () => 200, errorPort = null } = {}) {
  return {
    get: (opts, cb) => {
      const req = new EventEmitter();
      req.destroy = () => {};
      const port = opts.port;
      // 异步触发,模拟真实 http
      queueMicrotask(() => {
        if (errorPort && port === errorPort) {
          req.emit("error", new Error("ECONNREFUSED"));
          return;
        }
        const res = new EventEmitter();
        res.statusCode = statusFor(port);
        res.resume = () => {};
        cb(res);
      });
      return req;
    },
  };
}

function makeFakeFs({ exists = true, content = "Host dgx\n  HostName 1.2.3.4\n" } = {}) {
  return {
    existsSync: () => exists,
    readFileSync: () => content,
  };
}

let logSpy;
let stateRecord;

function makeMgr(overrides = {}) {
  stateRecord = [];
  logSpy = vi.fn();
  return new VoiceTunnelManager({
    onLog: logSpy,
    onState: (s) => stateRecord.push(s),
    spawnFn: overrides.spawnFn || makeFakeSpawn(),
    httpModule: overrides.httpModule || makeFakeHttp(),
    fsModule: overrides.fsModule || makeFakeFs(),
    envSkip: overrides.envSkip || (() => false),
    homeDir: overrides.homeDir || "/home/test",
    platform: overrides.platform || "darwin",
    healthIntervalMs: 50_000, // 测试不依赖循环
    healthTimeoutMs: 100,
    restartDelayMs: 10,
    ...overrides,
  });
}

describe("VoiceTunnelManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("env skip → status=disabled,no spawn", async () => {
    const spawnFn = makeFakeSpawn();
    const mgr = makeMgr({ envSkip: () => true, spawnFn });
    await mgr.start();
    expect(spawnFn.calls).toHaveLength(0);
    expect(stateRecord.at(-1)).toMatchObject({ status: "disabled", reason: "env-skip" });
  });

  it("missing ssh config → status=disabled,no spawn", async () => {
    const spawnFn = makeFakeSpawn();
    const mgr = makeMgr({ fsModule: makeFakeFs({ exists: false }), spawnFn });
    await mgr.start();
    expect(spawnFn.calls).toHaveLength(0);
    expect(stateRecord.at(-1)).toMatchObject({ status: "disabled", reason: "no-ssh-config" });
  });

  it("ssh config without Host dgx → disabled", async () => {
    const spawnFn = makeFakeSpawn();
    const mgr = makeMgr({
      fsModule: makeFakeFs({ content: "Host other\n  HostName x\n" }),
      spawnFn,
    });
    await mgr.start();
    expect(spawnFn.calls).toHaveLength(0);
    expect(stateRecord.at(-1)).toMatchObject({ status: "disabled", reason: "no-ssh-config" });
  });

  it("all 4 ports already healthy → standby (Mac launchd 让位),no spawn", async () => {
    const spawnFn = makeFakeSpawn();
    const mgr = makeMgr({ spawnFn, httpModule: makeFakeHttp({ statusFor: () => 200 }) });
    await mgr.start();
    expect(spawnFn.calls).toHaveLength(0);
    const standby = stateRecord.find((s) => s.status === "standby");
    expect(standby).toBeTruthy();
    expect(standby.reason).toBe("external-watchdog");
    mgr.stop();
  });

  it("any port unhealthy → spawn ssh with all forwards + Host dgx", async () => {
    const spawnFn = makeFakeSpawn();
    const mgr = makeMgr({
      spawnFn,
      httpModule: makeFakeHttp({ statusFor: (port) => (port === 18007 ? 0 : 200), errorPort: 18007 }),
    });
    await mgr.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(spawnFn.calls).toHaveLength(1);
    const { cmd, args } = spawnFn.calls[0];
    expect(cmd).toBe("ssh");
    expect(args).toContain("-N");
    expect(args).toContain("-L");
    expect(args).toContain("127.0.0.1:18007:127.0.0.1:18007");
    expect(args).toContain("127.0.0.1:18008:127.0.0.1:18008");
    expect(args).toContain("127.0.0.1:18020:127.0.0.1:8004");
    expect(args).toContain("127.0.0.1:18021:127.0.0.1:8005");
    expect(args[args.length - 1]).toBe("dgx");
    expect(args).toContain("ServerAliveInterval=15");
    mgr.stop();
  });

  it("Windows platform uses ssh.exe", async () => {
    const spawnFn = makeFakeSpawn();
    const mgr = makeMgr({
      spawnFn,
      platform: "win32",
      httpModule: makeFakeHttp({ statusFor: () => 0, errorPort: 18007 }),
    });
    await mgr.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(spawnFn.calls[0].cmd).toBe("ssh.exe");
    mgr.stop();
  });

  it("ssh child exit triggers restart after delay", async () => {
    const spawnFn = makeFakeSpawn();
    const mgr = makeMgr({
      spawnFn,
      restartDelayMs: 5,
      httpModule: makeFakeHttp({ statusFor: () => 0, errorPort: 18007 }),
    });
    await mgr.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(spawnFn.calls).toHaveLength(1);

    // 模拟 ssh 死
    spawnFn.children[0].emit("exit", 1, null);
    await new Promise((r) => setTimeout(r, 30));
    expect(spawnFn.calls.length).toBeGreaterThanOrEqual(2);
    expect(stateRecord.some((s) => s.status === "reconnecting")).toBe(true);
    mgr.stop();
  });

  it("stop() kills child + clears timer + emits stopped", async () => {
    const spawnFn = makeFakeSpawn();
    const mgr = makeMgr({
      spawnFn,
      httpModule: makeFakeHttp({ statusFor: () => 0, errorPort: 18007 }),
    });
    await mgr.start();
    await new Promise((r) => setTimeout(r, 5));
    const child = spawnFn.children[0];
    mgr.stop();
    expect(child.killed).toBe(true);
    expect(stateRecord.at(-1)).toMatchObject({ status: "stopped" });
  });

  it("stop() before start does not throw", () => {
    const mgr = makeMgr();
    expect(() => mgr.stop()).not.toThrow();
  });

  it("spawn throws synchronously → captured + scheduled restart", async () => {
    const failSpawn = vi.fn(() => { throw new Error("ENOENT ssh"); });
    const mgr = makeMgr({
      spawnFn: failSpawn,
      httpModule: makeFakeHttp({ statusFor: () => 0, errorPort: 18007 }),
    });
    await mgr.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(failSpawn).toHaveBeenCalled();
    expect(stateRecord.some((s) => s.status === "spawn-error")).toBe(true);
    mgr.stop();
  });

  it("getStatus reports current internal state", async () => {
    const spawnFn = makeFakeSpawn();
    const mgr = makeMgr({
      spawnFn,
      httpModule: makeFakeHttp({ statusFor: () => 0, errorPort: 18007 }),
    });
    await mgr.start();
    await new Promise((r) => setTimeout(r, 5));
    const st = mgr.getStatus();
    expect(st.stopped).toBe(false);
    expect(st.standby).toBe(false);
    expect(st.hasChild).toBe(true);
    mgr.stop();
    const after = mgr.getStatus();
    expect(after.stopped).toBe(true);
    expect(after.hasChild).toBe(false);
  });

  it("standby mode flips to active when external watchdog dies (一端口 down)", async () => {
    const spawnFn = makeFakeSpawn();
    let portState = { 18007: 200, 18008: 200, 18020: 200, 18021: 200 };
    const httpModule = {
      get: (opts, cb) => {
        const req = new EventEmitter();
        req.destroy = () => {};
        queueMicrotask(() => {
          const code = portState[opts.port];
          if (code === 0) {
            req.emit("error", new Error("down"));
            return;
          }
          const res = new EventEmitter();
          res.statusCode = code;
          res.resume = () => {};
          cb(res);
        });
        return req;
      },
    };
    const mgr = makeMgr({ spawnFn, httpModule, healthIntervalMs: 30 });
    await mgr.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnFn.calls).toHaveLength(0);
    expect(mgr.getStatus().standby).toBe(true);

    // 外部守护挂了 — 一个端口 down
    portState[18007] = 0;
    // 等下次健康 tick(30ms 后)
    await new Promise((r) => setTimeout(r, 60));
    expect(spawnFn.calls.length).toBeGreaterThanOrEqual(1);
    expect(mgr.getStatus().standby).toBe(false);
    mgr.stop();
  });
});
