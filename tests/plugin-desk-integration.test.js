/**
 * plugin-desk-integration.test.js — v0.77 插件与书桌集成测试
 *
 * 验证：
 * 1. rag-core / tts-bridge / flux-studio 三个预装插件能被 PluginManager 加载
 * 2. 插件工具命名空间正确（pluginId.toolName）
 * 3. DeskManager 支持插件工作区创建和列表
 * 4. PluginDeskBridge 能检测插件工作区文件变化并 emit 事件
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { PluginManager } from "../core/plugin-manager.js";
import { createDeskManager } from "../lib/desk/desk-manager.js";
import { createPluginDeskBridge } from "../lib/desk/plugin-desk-bridge.js";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

describe("v0.77 Plugin + Desk Integration", () => {
  let tempRoot;
  let builtinPluginsDir;
  let dataDir;

  beforeEach(() => {
    tempRoot = makeTempDir("lynn-v077-test-");
    builtinPluginsDir = path.join(tempRoot, "plugins");
    dataDir = path.join(tempRoot, "plugin-data");
    fs.mkdirSync(builtinPluginsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    // 复制三个预装插件到临时目录
    const srcPlugins = path.join(process.cwd(), "plugins");
    for (const name of ["rag-core", "tts-bridge", "flux-studio"]) {
      copyDir(path.join(srcPlugins, name), path.join(builtinPluginsDir, name));
    }
    // 复制 lib/memory 供 rag-core 引用
    const srcLib = path.join(process.cwd(), "lib", "memory");
    const destLib = path.join(tempRoot, "lib", "memory");
    fs.mkdirSync(destLib, { recursive: true });
    for (const f of fs.readdirSync(srcLib)) {
      if (f.endsWith(".js")) fs.copyFileSync(path.join(srcLib, f), path.join(destLib, f));
    }
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("should scan and load all three v0.77 builtin plugins", async () => {
    const pm = new PluginManager({
      pluginsDirs: [builtinPluginsDir],
      dataDir,
      bus: { emit: () => {} },
    });
    pm.scan();
    await pm.loadAll();

    const plugins = pm.listPlugins();
    expect(plugins.length).toBeGreaterThanOrEqual(3);
    const ids = plugins.map((p) => p.id).sort();
    expect(ids).toContain("rag-core");
    expect(ids).toContain("tts-bridge");
    expect(ids).toContain("flux-studio");
  });

  it("should register plugin tools with namespaced names", async () => {
    const pm = new PluginManager({
      pluginsDirs: [builtinPluginsDir],
      dataDir,
      bus: { emit: () => {} },
    });
    pm.scan();
    await pm.loadAll();

    const tools = pm.getAllTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain("rag-core.knowledge_index");
    expect(names).toContain("rag-core.knowledge_query");
    expect(names).toContain("tts-bridge.tts_speak");
    expect(names).toContain("flux-studio.generate_image");
    expect(names).toContain("flux-studio.edit_image");
  });

  it("should expose correct tool descriptions and parameters", async () => {
    const pm = new PluginManager({
      pluginsDirs: [builtinPluginsDir],
      dataDir,
      bus: { emit: () => {} },
    });
    pm.scan();
    await pm.loadAll();

    const tts = pm.getAllTools().find((t) => t.name === "tts-bridge.tts_speak");
    expect(tts).toBeDefined();
    expect(tts.description).toContain("语音");
    expect(tts.parameters).toBeDefined();
    expect(tts.parameters.type).toBe("object");
  });

  it("should create and list plugin workspaces via DeskManager", () => {
    const deskDir = path.join(tempRoot, "desk");
    const dm = createDeskManager(deskDir);
    dm.ensureDir();

    const ws = dm.ensurePluginWorkspace("rag-core");
    expect(fs.existsSync(ws)).toBe(true);
    expect(ws).toContain(path.join("desk", "plugins", "rag-core"));

    const list = dm.listPluginWorkspaces();
    expect(list.length).toBe(1);
    expect(list[0].pluginId).toBe("rag-core");
  });

  it("should detect plugin workspace changes via PluginDeskBridge", () => {
    const deskDir = path.join(tempRoot, "desk");
    const dm = createDeskManager(deskDir);
    dm.ensureDir();
    dm.ensurePluginWorkspace("tts-bridge");

    // 放入一个测试文件
    fs.writeFileSync(path.join(deskDir, "plugins", "tts-bridge", "hello.txt"), "world", "utf-8");

    const events = [];
    const bridge = createPluginDeskBridge({
      deskDir,
      bus: { emit: (type, payload) => events.push({ type, payload }) },
    });

    const changes = bridge.heartbeatScan();
    expect(changes.length).toBe(1);
    expect(changes[0].pluginId).toBe("tts-bridge");
    expect(changes[0].files.some((f) => f.name === "hello.txt")).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe("plugin:desk:files");
  });

  it("should load plugin route registry for tts-bridge", async () => {
    const pm = new PluginManager({
      pluginsDirs: [builtinPluginsDir],
      dataDir,
      bus: { emit: () => {} },
    });
    pm.scan();
    await pm.loadAll();

    const ragApp = pm.routeRegistry.get("tts-bridge");
    expect(ragApp).toBeDefined();
    expect(typeof ragApp.fetch).toBe("function");
  });

  it("should load rag-core skill paths", async () => {
    const pm = new PluginManager({
      pluginsDirs: [builtinPluginsDir],
      dataDir,
      bus: { emit: () => {} },
    });
    pm.scan();
    await pm.loadAll();

    const paths = pm.getSkillPaths();
    const ragSkill = paths.find((p) => p.dirPath.includes("rag-core"));
    expect(ragSkill).toBeDefined();
    expect(ragSkill.label).toBe("plugin:rag-core");
  });
});
