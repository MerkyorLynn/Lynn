import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PluginManager } from "../core/plugin-manager.js";

const tmpHome = path.join(os.tmpdir(), "hana-pm-test-" + Date.now());
const pluginsDir = path.join(tmpHome, "plugins");
const dataDir = path.join(tmpHome, "plugin-data");

beforeEach(() => {
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function makeBus() {
  const { EventBus } = await import("../hub/event-bus.js");
  return new EventBus();
}

describe("scan", () => {
  it("discovers plugin from directory with manifest.json", async () => {
    const dir = path.join(pluginsDir, "my-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "my-plugin", name: "My Plugin", version: "1.0.0",
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    const plugins = pm.scan();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("my-plugin");
    expect(plugins[0].name).toBe("My Plugin");
  });

  it("infers id from directory name when no manifest", async () => {
    const dir = path.join(pluginsDir, "simple-tool");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "hello.js"),
      'export const name = "hello";\nexport const description = "test";\nexport const parameters = {};\nexport async function execute() { return "hi"; }\n');
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    const plugins = pm.scan();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("simple-tool");
  });

  it("detects contribution types from subdirectories", async () => {
    const dir = path.join(pluginsDir, "multi");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), "export const name='t';");
    fs.writeFileSync(path.join(dir, "skills", "s.md"), "---\nname: s\n---\n# S");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    const plugins = pm.scan();
    expect(plugins[0].contributions).toContain("tools");
    expect(plugins[0].contributions).toContain("skills");
  });

  it("skips hidden directories and non-directories", async () => {
    fs.mkdirSync(path.join(pluginsDir, ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, "README.md"), "hi");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    expect(pm.scan()).toHaveLength(0);
  });

  it("invalid manifest.json logs error and skips plugin", async () => {
    const dir = path.join(pluginsDir, "bad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), "NOT JSON");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    expect(pm.scan()).toHaveLength(0);
  });
});

describe("loadAll", () => {
  it("loads plugin with index.js and calls onload", async () => {
    const dir = path.join(pluginsDir, "stateful");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class TestPlugin {
        async onload() { this.loaded = true; }
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const entry = pm.getPlugin("stateful");
    expect(entry.status).toBe("loaded");
    expect(entry.instance.loaded).toBe(true);
  });

  it("provides register() on instance and cleans up on unload", async () => {
    const dir = path.join(pluginsDir, "reg-test");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), `
      export default class RegPlugin {
        async onload() {
          this.register(() => { globalThis.__regTestCleanup = true; });
        }
      }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    await pm.unloadPlugin("reg-test");
    expect(globalThis.__regTestCleanup).toBe(true);
    delete globalThis.__regTestCleanup;
  });

  it("failed onload marks plugin as failed, does not block others", async () => {
    const bad = path.join(pluginsDir, "bad-plugin");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "index.js"), `
      export default class Bad { async onload() { throw new Error("boom"); } }
    `);
    const good = path.join(pluginsDir, "good-plugin");
    fs.mkdirSync(path.join(good, "tools"), { recursive: true });
    fs.writeFileSync(path.join(good, "tools", "t.js"), "export const name='t';");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("bad-plugin").status).toBe("failed");
    expect(pm.getPlugin("good-plugin").status).toBe("loaded");
  });

  it("plugin without index.js loads as static (no lifecycle)", async () => {
    const dir = path.join(pluginsDir, "static-only");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "t.js"), "export const name='t';");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    expect(pm.getPlugin("static-only").status).toBe("loaded");
    expect(pm.getPlugin("static-only").instance).toBeNull();
  });
});

describe("tool loading", () => {
  it("loads tools from tools/ directory with namespace prefix", async () => {
    const dir = path.join(pluginsDir, "search-plugin");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "web-search.js"), `
      export const name = "web-search";
      export const description = "Search the web";
      export const parameters = { type: "object", properties: { query: { type: "string" } } };
      export async function execute(input) { return "results for " + input.query; }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const tools = pm.getAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("search-plugin.web-search");
    expect(tools[0].description).toBe("Search the web");
  });

  it("skips tool files with invalid exports", async () => {
    const dir = path.join(pluginsDir, "bad-tool");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "bad.js"), "export const x = 1;");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    expect(pm.getAllTools()).toHaveLength(0);
  });
});

describe("skill paths", () => {
  it("getSkillPaths returns skill directories from all plugins", async () => {
    const dir = path.join(pluginsDir, "skill-plug");
    fs.mkdirSync(path.join(dir, "skills", "my-skill"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: test\n---\n# My Skill");
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const paths = pm.getSkillPaths();
    expect(paths).toHaveLength(1);
    expect(paths[0].dirPath).toContain("skill-plug");
    expect(paths[0].label).toBe("plugin:skill-plug");
  });
});

describe("command loading", () => {
  it("loads commands from commands/ directory", async () => {
    const dir = path.join(pluginsDir, "cmd-plug");
    fs.mkdirSync(path.join(dir, "commands"), { recursive: true });
    fs.writeFileSync(path.join(dir, "commands", "hello.js"), `
      export const name = "hello";
      export const description = "Say hello";
      export async function execute(args, ctx) { return "Hello " + args; }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const cmds = pm.getAllCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe("cmd-plug.hello");
  });
});

describe("hooks", () => {
  it("loads hooks from hooks.json and executes them", async () => {
    const dir = path.join(pluginsDir, "hook-plug");
    fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({
      "test:event": "./hooks/handler.js"
    }));
    fs.writeFileSync(path.join(dir, "hooks", "handler.js"), `
      export default async function(event) { return { injected: true }; }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const result = await pm.executeHook("test:event", { data: 1 });
    expect(result).toEqual({ injected: true });
  });

  it("before-* hook returning null cancels the event", async () => {
    const dir = path.join(pluginsDir, "cancel-hook");
    fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({
      "before-send": "./hooks/block.js"
    }));
    fs.writeFileSync(path.join(dir, "hooks", "block.js"), `
      export default async function() { return null; }
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const result = await pm.executeHook("before-send", { text: "hi" });
    expect(result).toBeNull();
  });

  it("hooks with no handlers return original event unchanged", async () => {
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    const result = await pm.executeHook("no:handler", { x: 1 });
    expect(result).toEqual({ x: 1 });
  });
});

describe("configuration", () => {
  it("reads configuration schema from manifest", async () => {
    const dir = path.join(pluginsDir, "config-plug");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "config-plug", name: "Config Plugin", version: "1.0.0",
      contributes: { configuration: { properties: {
        interval: { type: "number", default: 25, title: "Interval" },
        enabled: { type: "boolean", default: true, title: "Enabled" },
      }}}
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const schema = pm.getConfigSchema("config-plug");
    expect(schema.properties.interval.type).toBe("number");
  });

  it("getAllConfigSchemas returns schemas for all plugins", async () => {
    const dir = path.join(pluginsDir, "cfg");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id: "cfg", name: "C", version: "0.1.0",
      contributes: { configuration: { properties: { x: { type: "string" } } } }
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const all = pm.getAllConfigSchemas();
    expect(all).toHaveLength(1);
    expect(all[0].pluginId).toBe("cfg");
  });
});

describe("agent templates", () => {
  it("loads agent templates from agents/ directory", async () => {
    const dir = path.join(pluginsDir, "agent-plug");
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", "translator.json"), JSON.stringify({
      name: "Translator", systemPrompt: "You are a translator.", defaultModel: "gpt-4o",
    }));
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const templates = pm.getAgentTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("Translator");
    expect(templates[0]._pluginId).toBe("agent-plug");
  });
});

describe("provider declarations", () => {
  it("loads provider plugin data from providers/ directory", async () => {
    const dir = path.join(pluginsDir, "prov-plug");
    fs.mkdirSync(path.join(dir, "providers"), { recursive: true });
    fs.writeFileSync(path.join(dir, "providers", "my-llm.js"), `
      export const id = "my-llm";
      export const displayName = "My LLM";
      export const authType = "api-key";
      export const defaultBaseUrl = "https://api.my-llm.com/v1";
      export const defaultApi = "openai-completions";
    `);
    const pm = new PluginManager({ pluginsDir, dataDir, bus: await makeBus() });
    pm.scan();
    await pm.loadAll();
    const providers = pm.getProviderPlugins();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("my-llm");
  });
});
