import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LlamaCppManager,
  DEFAULT_CONFIG,
  bundledBinaryPath,
  systemBinaryCandidates,
} from "../desktop/llamacpp-manager.cjs";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("LlamaCppManager path and spawn safety", () => {
  it("resolves bundled llama.cpp binary and model from custom LYNN_HOME before default home", () => {
    const homeDir = makeTempDir("lynn-home-default-");
    const lynnHome = makeTempDir("lynn-home-custom-");
    const binName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
    const expectedBinary = path.join(lynnHome, "llamacpp", "bin", binName);
    const expectedModel = path.join(lynnHome, "models", DEFAULT_CONFIG.modelFileName);

    fs.mkdirSync(path.dirname(expectedBinary), { recursive: true });
    fs.mkdirSync(path.dirname(expectedModel), { recursive: true });
    fs.writeFileSync(expectedBinary, "stub");
    fs.writeFileSync(expectedModel, "stub");

    const manager = new LlamaCppManager({
      homeDir,
      lynnHome,
      fsModule: fs,
    });

    expect(manager.resolveBinaryPath()).toBe(expectedBinary);
    expect(manager.resolveModelPath()).toBe(expectedModel);
  });

  it("spawns llama-server with windowsHide to avoid console flashes on Windows", async () => {
    let spawnOptions = null;
    const manager = new LlamaCppManager({
      binaryPath: "/tmp/llama-server",
      modelPath: "/tmp/model.gguf",
      fsModule: { existsSync: () => true },
      spawnFn: (_binary, _args, options) => {
        spawnOptions = options;
        throw new Error("stop before process launch");
      },
    });
    manager.findFreePort = async () => 18099;

    await manager.spawnServer();

    expect(spawnOptions).toMatchObject({ windowsHide: true });
  });

  it("discovers a Windows llama-server installed on PATH with where.exe", () => {
    const expected = "C:\\llama.cpp\\llama-server.exe";
    const spawnCalls = [];
    const spawnSyncFn = (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { stdout: `${expected}\r\n` };
    };
    const manager = new LlamaCppManager({
      platform: "win32",
      lynnHome: "C:\\Users\\test\\.lynn",
      fsModule: { existsSync: (candidate) => candidate === expected },
      spawnSyncFn,
    });

    expect(manager.resolveBinaryPath()).toBe(expected);
    expect(spawnCalls).toEqual([
      expect.objectContaining({ command: "where.exe", args: ["llama-server"] }),
    ]);
  });

  it("discovers the llama-server bundled in Windows app resources before PATH", () => {
    const resourcesPath = "C:\\Program Files\\Lynn\\resources";
    const expected = bundledBinaryPath(resourcesPath, "win32");
    const spawnCalls = [];
    const manager = new LlamaCppManager({
      platform: "win32",
      resourcesPath,
      lynnHome: "C:\\Users\\test\\.lynn",
      fsModule: { existsSync: (candidate) => candidate === expected },
      spawnSyncFn: (...args) => {
        spawnCalls.push(args);
        return { stdout: "C:\\other\\llama-server.exe\r\n" };
      },
    });

    expect(manager.resolveBinaryPath()).toBe(expected);
    expect(spawnCalls).toEqual([]);
  });

  it("keeps a managed Windows llama-server ahead of the bundled runtime", () => {
    const lynnHome = makeTempDir("lynn-managed-win-");
    const resourcesPath = makeTempDir("lynn-resources-win-");
    const managed = path.join(lynnHome, "llamacpp", "bin", "llama-server.exe");
    const bundled = bundledBinaryPath(resourcesPath, "win32");
    const manager = new LlamaCppManager({
      platform: "win32",
      resourcesPath,
      lynnHome,
      fsModule: { existsSync: (candidate) => candidate === managed || candidate === bundled },
    });

    expect(manager.resolveBinaryPath()).toBe(managed);
  });

  it("keeps every valid Windows PATH match so an unavailable first result can fall through", () => {
    const candidates = systemBinaryCandidates("win32", () => ({
      stdout: "C:\\old\\llama-server.exe\r\nD:\\tools\\llama-server.exe\r\n",
    }));

    expect(candidates).toEqual([
      "C:\\old\\llama-server.exe",
      "D:\\tools\\llama-server.exe",
    ]);
  });

  it("defaults to the new Q3 model without injecting a legacy MTP head", () => {
    const manager = new LlamaCppManager({
      binaryPath: "/tmp/llama-server",
      modelPath: "/tmp/model.gguf",
      fsModule: { existsSync: () => true },
    });
    manager.binaryPath = "/tmp/llama-server";
    manager.binarySupportsFlag = () => true;

    const args = manager.buildServerArgs();

    expect(DEFAULT_CONFIG.modelId).toBe("qwen38-27b-coder390-q3-lynnstyle");
    expect(DEFAULT_CONFIG.modelFileName).toBe("GGUF/Qwen3.8-27B-Coder390-EfficientThink-Q3LynnStyle-MTP.gguf");
    expect(args).toEqual(expect.arrayContaining([
      "-a", "qwen38-27b-coder390-q3-lynnstyle",
      "--ctx-size", "8192",
    ]));
    expect(args).not.toContain('draft-mtp');
  });

  it("drops unsupported optional llama.cpp flags before spawning older binaries", () => {
    const logs = [];
    const manager = new LlamaCppManager({
      binaryPath: "/tmp/llama-server",
      modelPath: "/tmp/model.gguf",
      fsModule: { existsSync: () => true },
      onLog: (level, message) => logs.push({ level, message }),
      serverArgs: [
        "--ctx-size", "32768",
        "--jinja",
        "--reasoning", "auto",
        "--reasoning-budget", "-1",
        "--metrics",
        "--spec-type", "draft-mtp",
        "--spec-draft-n-max", "3",
        "--cache-type-k", "q8_0",
        "--cache-type-v", "q8_0",
        "--host", "127.0.0.1",
      ],
    });
    manager.binaryPath = "/tmp/llama-server";
    manager.binarySupportsFlag = (flag) => flag === "--ctx-size" || flag === "--host";

    const args = manager.buildServerArgs();

    expect(args).toEqual([
      "--ctx-size", "32768",
      "--host", "127.0.0.1",
    ]);
    expect(args).not.toContain("auto");
    expect(args).not.toContain("draft-mtp");
    expect(args).not.toContain("q8_0");
    expect(logs.map((entry) => entry.message).join("\n")).toContain("does not support --jinja");
    expect(logs.map((entry) => entry.message).join("\n")).toContain("does not support --cache-type-v");
  });
});

describe("LlamaCppManager startup lifecycle", () => {
  it("keeps timeout failed, avoids an automatic loop, permits retry and ignores old exits", async () => {
    vi.useFakeTimers();
    const children = [];
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter();
      child.kill = vi.fn(() => { child.emit('exit', null, 'SIGTERM'); return true; });
      children.push(child); return child;
    });
    const manager = new LlamaCppManager({ startupTimeoutMs: 1, restartDelayMs: 5, spawnFn, fsModule: { existsSync: () => true } });
    manager.binaryPath = '/tmp/llama-test'; manager.modelPath = '/tmp/model-test';
    manager.findFreePort = async () => 18099; manager.buildServerArgs = () => [];
    manager.probeHealth = async () => children.length >= 2;
    try {
      const first = manager.spawnServer();
      await vi.advanceTimersByTimeAsync(1500); await first;
      expect(manager.state).toMatchObject({ status: 'failed', reason: 'startup-timeout' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(manager.stopped).toBe(false);
      const retry = manager.start();
      await vi.advanceTimersByTimeAsync(1500); await retry;
      expect(manager.state).toMatchObject({ status: 'ready', reason: null, error: null });
      children[0].emit('exit', 1, null);
      expect(manager.child).toBe(children[1]);
      expect(manager.state.status).toBe('ready');
    } finally { manager.stop(); vi.useRealTimers(); }
  });

  it("reports asynchronous executable errors instead of crashing the application", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter(); child.kill = vi.fn();
    const manager = new LlamaCppManager({ startupTimeoutMs: 10, spawnFn: () => child });
    manager.binaryPath = '/tmp/missing'; manager.modelPath = '/tmp/model-test';
    manager.findFreePort = async () => 18099; manager.buildServerArgs = () => [];
    manager.probeHealth = async () => false;
    try {
      const pending = manager.spawnServer();
      await vi.advanceTimersByTimeAsync(0);
      expect(() => child.emit('error', new Error('spawn EACCES'))).not.toThrow();
      await vi.advanceTimersByTimeAsync(1500); await pending;
      expect(manager.state).toMatchObject({ status: 'failed', reason: 'spawn-error' });
      expect(manager.child).toBeNull();
    } finally { manager.stop(); vi.useRealTimers(); }
  });
});
