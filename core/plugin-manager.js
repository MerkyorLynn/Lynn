import fs from "fs";
import path from "path";
import { createPluginContext } from "./plugin-context.js";

const KNOWN_CONTRIBUTION_DIRS = [
  "tools", "routes", "skills", "hooks", "agents", "commands", "providers",
];

export class PluginManager {
  /**
   * @param {{ pluginsDirs: string[], dataDir: string, bus: object }} opts
   * pluginsDirs: 多个扫描目录，先内嵌后用户（靠前的优先）
   * 兼容旧签名 { pluginsDir: string } → 自动转为单元素数组
   */
  constructor({ pluginsDirs, pluginsDir, dataDir, bus, engine }) {
    this._pluginsDirs = pluginsDirs || (pluginsDir ? [pluginsDir] : []);
    this._dataDir = dataDir;
    this._bus = bus;
    this._engine = engine || null;
    this._plugins = new Map();
    this._scanned = [];
    this.routeRegistry = new Map();

    // Contribution registries
    this._tools = [];
    this._commands = [];
    this._skillPaths = [];
    this._agentTemplates = [];
    this._providerPlugins = [];
    this._configSchemas = [];
    // hookRegistry: Map<eventType, Array<{ pluginId, handlerPath, _cache?: Function }>>
    this._hookRegistry = new Map();
  }

  scan() {
    const results = [];
    const seen = new Set();
    for (const dir of this._pluginsDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (seen.has(entry.name)) continue; // 靠前的目录优先，同名跳过
        seen.add(entry.name);
        const pluginDir = path.join(dir, entry.name);
        try {
          const desc = this._readPluginDescriptor(pluginDir, entry.name);
          results.push(desc);
        } catch (err) {
          console.error(`[plugin-manager] failed to read plugin "${entry.name}":`, err.message);
        }
      }
    }
    this._scanned = results;
    return results;
  }

  _readPluginDescriptor(pluginDir, dirName) {
    const manifestPath = path.join(pluginDir, "manifest.json");
    let manifest = null;
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    }
    const id = manifest?.id || dirName;
    const name = manifest?.name || dirName;
    const version = manifest?.version || "0.0.0";
    const description = manifest?.description || "";
    const contributions = [];
    for (const dir of KNOWN_CONTRIBUTION_DIRS) {
      if (fs.existsSync(path.join(pluginDir, dir))) contributions.push(dir);
    }
    if (fs.existsSync(path.join(pluginDir, "hooks.json"))) contributions.push("hooks");
    if (fs.existsSync(path.join(pluginDir, "index.js"))) contributions.push("lifecycle");
    return { id, name, version, description, pluginDir, manifest, contributions };
  }

  async loadAll() {
    const descriptors = this._scanned.length > 0 ? this._scanned : this.scan();
    for (const desc of descriptors) {
      const entry = { ...desc, status: "loading", instance: null, _disposables: [] };
      this._plugins.set(desc.id, entry);
      try {
        await this._loadPlugin(entry);
        entry.status = "loaded";
      } catch (err) {
        entry.status = "failed";
        entry.error = err.message;
        console.error(`[plugin-manager] plugin "${desc.id}" failed to load:`, err.message);
      }
    }
  }

  async _loadPlugin(entry) {
    // Contribution loaders
    await this._loadTools(entry);
    await this._loadRoutes(entry);
    await this._loadCommands(entry);
    await this._loadSkillPaths(entry);
    await this._loadAgentTemplates(entry);
    await this._loadProviders(entry);
    this._loadHooks(entry);
    this._loadConfiguration(entry);

    // Lifecycle (index.js)
    const indexPath = path.join(entry.pluginDir, "index.js");
    if (!fs.existsSync(indexPath)) return;
    const mod = await import(indexPath);
    const PluginClass = mod.default;
    if (!PluginClass || typeof PluginClass !== "function") return;
    const instance = new PluginClass();
    entry.instance = instance;
    instance.ctx = createPluginContext({
      pluginId: entry.id,
      pluginDir: entry.pluginDir,
      dataDir: path.join(this._dataDir, entry.id),
      bus: this._bus,
      engine: this._engine || null,
      disposables: entry._disposables,
    });
    instance.register = (disposable) => {
      if (typeof disposable === "function") entry._disposables.push(disposable);
    };
    if (typeof instance.onload === "function") await instance.onload();
  }

  // ── Task 5: Tool loader ──────────────────────────────────────────────────

  async _loadTools(entry) {
    const toolsDir = path.join(entry.pluginDir, "tools");
    if (!fs.existsSync(toolsDir)) return;
    const files = fs.readdirSync(toolsDir).filter((f) => f.endsWith(".js"));
    const ctx = {
      bus: this._bus,
      engine: this._engine || null,
      config: {
        get: (key) => {
          try {
            const p = path.join(this._dataDir, entry.id, "config.json");
            const data = JSON.parse(fs.readFileSync(p, "utf-8"));
            return key ? data[key] : data;
          } catch { return key ? undefined : {}; }
        },
      },
      log: {
        info: (...a) => console.log(`[plugin:${entry.id}]`, ...a),
        warn: (...a) => console.warn(`[plugin:${entry.id}]`, ...a),
        error: (...a) => console.error(`[plugin:${entry.id}]`, ...a),
        debug: (...a) => console.debug(`[plugin:${entry.id}]`, ...a),
      },
    };
    for (const file of files) {
      const filePath = path.join(toolsDir, file);
      try {
        const mod = await import(filePath);
        if (!mod.name || !mod.description || typeof mod.execute !== "function") continue;
        const origExecute = mod.execute;
        this._tools.push({
          name: `${entry.id}.${mod.name}`,
          description: mod.description,
          parameters: mod.parameters ?? {},
          execute: (input) => origExecute(input, ctx),
          _pluginId: entry.id,
        });
      } catch (err) {
        console.error(`[plugin-manager] tool "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
  }

  getAllTools() {
    return [...this._tools];
  }

  // ── Task 6: Skill paths + Command loader ────────────────────────────────

  async _loadSkillPaths(entry) {
    const skillsDir = path.join(entry.pluginDir, "skills");
    if (!fs.existsSync(skillsDir)) return;
    this._skillPaths.push({
      dirPath: skillsDir,
      label: `plugin:${entry.id}`,
    });
  }

  getSkillPaths() {
    return [...this._skillPaths];
  }

  async _loadCommands(entry) {
    const cmdsDir = path.join(entry.pluginDir, "commands");
    if (!fs.existsSync(cmdsDir)) return;
    const files = fs.readdirSync(cmdsDir).filter((f) => f.endsWith(".js"));
    for (const file of files) {
      const filePath = path.join(cmdsDir, file);
      try {
        const mod = await import(filePath);
        if (!mod.name || typeof mod.execute !== "function") continue;
        this._commands.push({
          name: `${entry.id}.${mod.name}`,
          description: mod.description ?? "",
          execute: mod.execute,
          _pluginId: entry.id,
        });
      } catch (err) {
        console.error(`[plugin-manager] command "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
  }

  getAllCommands() {
    return [...this._commands];
  }

  // ── Task 7: Route loader ─────────────────────────────────────────────────

  async _loadRoutes(entry) {
    const routesDir = path.join(entry.pluginDir, "routes");
    if (!fs.existsSync(routesDir)) return;
    const { Hono } = await import("hono");
    const app = new Hono();
    const files = fs.readdirSync(routesDir).filter((f) => f.endsWith(".js"));
    const ctx = createPluginContext({
      pluginId: entry.id,
      pluginDir: entry.pluginDir,
      dataDir: path.join(this._dataDir, entry.id),
      bus: this._bus,
      engine: this._engine || null,
      disposables: entry._disposables,
    });
    for (const file of files) {
      const filePath = path.join(routesDir, file);
      const prefix = "/" + path.basename(file, ".js");
      try {
        const mod = await import(filePath);
        if (mod.default && typeof mod.default.fetch === "function") {
          app.route(prefix, mod.default);
          continue;
        }
        if (typeof mod.default === "function") {
          if (mod.default.length >= 2) {
            mod.default(app, ctx);
          } else {
            const maybeApp = mod.default(ctx);
            if (maybeApp && typeof maybeApp.fetch === "function") {
              app.route(prefix, maybeApp);
            }
          }
          continue;
        }
        if (mod.register && typeof mod.register === "function") {
          const maybeApp = mod.register(app, ctx);
          if (maybeApp && typeof maybeApp.fetch === "function") {
            app.route(prefix, maybeApp);
          }
        }
      } catch (err) {
        console.error('[plugin-manager] route "' + file + '" in "' + entry.id + '" failed to load:', err.message);
      }
    }
    this.routeRegistry.set(entry.id, app);
  }

  // ── Task 8: Hook loader ──────────────────────────────────────────────────

  _loadHooks(entry) {
    const hooksJsonPath = path.join(entry.pluginDir, "hooks.json");
    if (!fs.existsSync(hooksJsonPath)) return;
    let hookMap;
    try {
      hookMap = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
    } catch (err) {
      console.error(`[plugin-manager] hooks.json in "${entry.id}" is invalid:`, err.message);
      return;
    }
    for (const [eventType, handlerPath] of Object.entries(hookMap)) {
      if (!this._hookRegistry.has(eventType)) this._hookRegistry.set(eventType, []);
      this._hookRegistry.get(eventType).push({
        pluginId: entry.id,
        // Resolve relative path against plugin directory
        handlerPath: path.resolve(entry.pluginDir, handlerPath),
        _cache: null,
      });
    }
  }

  /**
   * Execute hooks for a given event type.
   *
   * Semantics for before-* hooks:
   *   - handler returns null   → cancel (propagation stops, return null)
   *   - handler returns object → replace event with returned value, continue chain
   *   - handler returns undefined → pass-through unchanged
   *
   * For non-before-* hooks, the result of the last responding handler is returned.
   * If no handlers exist, the original event is returned unchanged.
   */
  async executeHook(eventType, event) {
    const handlers = this._hookRegistry.get(eventType);
    if (!handlers || handlers.length === 0) return event;

    const isBefore = eventType.startsWith("before-");
    let current = event;

    for (const hookEntry of handlers) {
      // Lazy-load and cache the handler function
      if (!hookEntry._cache) {
        try {
          const mod = await import(hookEntry.handlerPath);
          hookEntry._cache = mod.default ?? mod;
        } catch (err) {
          console.error(`[plugin-manager] hook handler "${hookEntry.handlerPath}" failed to load:`, err.message);
          continue;
        }
      }
      let result;
      try {
        result = await hookEntry._cache(current);
      } catch (err) {
        console.error(`[plugin-manager] hook handler "${hookEntry.handlerPath}" threw:`, err.message);
        continue;
      }

      if (isBefore) {
        if (result === null) return null; // cancelled
        if (result !== undefined) current = result; // replaced
        // undefined → pass-through, current stays
      } else {
        if (result !== undefined) current = result;
      }
    }
    return current;
  }

  // ── Task 9: Configuration loader ─────────────────────────────────────────

  _loadConfiguration(entry) {
    const schema = entry.manifest?.contributes?.configuration;
    if (!schema) return;
    this._configSchemas.push({ pluginId: entry.id, schema });
  }

  getConfigSchema(pluginId) {
    return this._configSchemas.find((s) => s.pluginId === pluginId)?.schema ?? null;
  }

  getAllConfigSchemas() {
    return [...this._configSchemas];
  }

  // ── Task 10: Agent templates + Provider loader ───────────────────────────

  async _loadAgentTemplates(entry) {
    const agentsDir = path.join(entry.pluginDir, "agents");
    if (!fs.existsSync(agentsDir)) return;
    const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(agentsDir, file);
      try {
        const template = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        template._pluginId = entry.id;
        this._agentTemplates.push(template);
      } catch (err) {
        console.error(`[plugin-manager] agent template "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
  }

  getAgentTemplates() {
    return [...this._agentTemplates];
  }

  async _loadProviders(entry) {
    const providersDir = path.join(entry.pluginDir, "providers");
    if (!fs.existsSync(providersDir)) return;
    const files = fs.readdirSync(providersDir).filter((f) => f.endsWith(".js"));
    for (const file of files) {
      const filePath = path.join(providersDir, file);
      try {
        const mod = await import(filePath);
        if (!mod.id) continue;
        this._providerPlugins.push({ ...mod, _pluginId: entry.id });
      } catch (err) {
        console.error(`[plugin-manager] provider "${file}" in "${entry.id}" failed to load:`, err.message);
      }
    }
  }

  getProviderPlugins() {
    return [...this._providerPlugins];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  _removePluginContributions(pluginId) {
    this._tools = this._tools.filter((item) => item?._pluginId !== pluginId);
    this._commands = this._commands.filter((item) => item?._pluginId !== pluginId);
    this._skillPaths = this._skillPaths.filter((item) => item?.label !== `plugin:${pluginId}`);
    this._agentTemplates = this._agentTemplates.filter((item) => item?._pluginId !== pluginId);
    this._providerPlugins = this._providerPlugins.filter((item) => item?._pluginId !== pluginId);
    this._configSchemas = this._configSchemas.filter((item) => item?.pluginId !== pluginId);

    for (const [eventType, handlers] of this._hookRegistry.entries()) {
      const kept = handlers.filter((item) => item?.pluginId !== pluginId);
      if (kept.length > 0) this._hookRegistry.set(eventType, kept);
      else this._hookRegistry.delete(eventType);
    }
  }

  async unloadPlugin(pluginId) {
    const entry = this._plugins.get(pluginId);
    if (!entry) return;
    if (entry.instance) {
      if (typeof entry.instance.onunload === "function") {
        try { await entry.instance.onunload(); } catch (err) {
          console.error(`[plugin-manager] "${pluginId}" onunload error:`, err.message);
        }
      }
      for (const d of entry._disposables.reverse()) {
        try { d(); } catch (err) {
          console.error(`[plugin-manager] "${pluginId}" disposable error:`, err.message);
        }
      }
      entry._disposables = [];
    }
    this.routeRegistry.delete(pluginId);
    this._removePluginContributions(pluginId);
    entry.status = "unloaded";
  }

  getPlugin(id) { return this._plugins.get(id) || null; }
  listPlugins() { return [...this._plugins.values()]; }
}
