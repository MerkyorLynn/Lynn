import fs from "fs";
import path from "path";
import type { Hono } from "hono";
import { createPluginContext } from "./plugin-context.js";
import type { PluginBus, PluginContext, PluginDisposable, PluginLogger } from "./plugin-context.js";

const KNOWN_CONTRIBUTION_DIRS = [
  "tools", "routes", "skills", "hooks", "agents", "commands", "providers",
] as const;

type KnownContributionDir = (typeof KNOWN_CONTRIBUTION_DIRS)[number];
type PluginContribution = KnownContributionDir | "lifecycle";
type PluginStatus = "loading" | "loaded" | "failed" | "unloaded";
type JsonRecord = Record<string, unknown>;
type UnknownFunction = (...args: unknown[]) => unknown;

export type PluginConfigSchema = JsonRecord;

export interface PluginManifestContributes extends JsonRecord {
  configuration?: PluginConfigSchema;
}

export interface PluginManifest extends JsonRecord {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  contributes?: PluginManifestContributes;
}

export interface PluginDescriptor {
  id: string;
  name: string;
  version: string;
  description: string;
  pluginDir: string;
  manifest: PluginManifest | null;
  contributions: PluginContribution[];
}

export interface PluginLifecycleInstance {
  ctx?: PluginContext;
  register?: (disposable: unknown) => void;
  onload?: () => unknown;
  onunload?: () => unknown;
  [key: string]: unknown;
}

export interface PluginEntry extends PluginDescriptor {
  status: PluginStatus;
  instance: PluginLifecycleInstance | null;
  _disposables: PluginDisposable[];
  error?: string;
}

export interface PluginTool {
  name: string;
  description: unknown;
  parameters: unknown;
  execute: (input: unknown) => unknown;
  _pluginId: string;
}

export interface PluginCommand {
  name: string;
  description: unknown;
  execute: UnknownFunction;
  _pluginId: string;
}

export interface PluginSkillPath {
  dirPath: string;
  label: string;
}

export interface PluginAgentTemplate extends JsonRecord {
  _pluginId?: string;
}

export interface PluginProvider extends JsonRecord {
  _pluginId: string;
}

export interface PluginConfigSchemaEntry {
  pluginId: string;
  schema: PluginConfigSchema;
}

export interface PluginManagerOptions {
  pluginsDirs?: string[] | null;
  pluginsDir?: string | null;
  dataDir: string;
  bus?: PluginBus | null;
  engine?: unknown;
}

interface ToolExecutionContext {
  bus: PluginBus | null;
  engine: unknown;
  config: {
    get(): JsonRecord;
    get(key: string): unknown;
  };
  log: PluginLogger;
}

interface ToolModule {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  execute?: unknown;
}

type ToolExecutor = (input: unknown, ctx: ToolExecutionContext) => unknown;

interface CommandModule {
  name?: unknown;
  description?: unknown;
  execute?: unknown;
}

interface RouteModule {
  default?: unknown;
  register?: unknown;
}

interface HookMap {
  [eventType: string]: string;
}

interface HookEntry {
  pluginId: string;
  handlerPath: string;
  _cache: unknown;
}

interface HookModule {
  default?: unknown;
}

type HookHandler = (event: unknown) => unknown;

interface ProviderModule extends JsonRecord {
  id?: unknown;
}

interface LifecycleModule {
  default?: unknown;
}

type PluginConstructor = new () => PluginLifecycleInstance;

function errorMessage(err: unknown): string | undefined {
  if (err && (typeof err === "object" || typeof err === "function") && "message" in err) {
    const message = (err as { message?: unknown }).message;
    return message === undefined ? undefined : String(message);
  }
  return undefined;
}

function hasFetch(value: unknown): value is Hono {
  return Boolean(
    value &&
    typeof value === "object" &&
    "fetch" in value &&
    typeof (value as { fetch?: unknown }).fetch === "function",
  );
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

export class PluginManager {
  /**
   * pluginsDirs: 多个扫描目录，先内嵌后用户（靠前的优先）
   * 兼容旧签名 { pluginsDir: string } -> 自动转为单元素数组
   */
  _pluginsDirs: string[];
  _dataDir: string;
  _bus: PluginBus | null;
  _engine: unknown;
  _plugins: Map<string, PluginEntry>;
  _scanned: PluginDescriptor[];
  routeRegistry: Map<string, Hono>;
  _tools: PluginTool[];
  _commands: PluginCommand[];
  _skillPaths: PluginSkillPath[];
  _agentTemplates: PluginAgentTemplate[];
  _providerPlugins: PluginProvider[];
  _configSchemas: PluginConfigSchemaEntry[];
  _hookRegistry: Map<string, HookEntry[]>;

  constructor({ pluginsDirs, pluginsDir, dataDir, bus, engine }: PluginManagerOptions) {
    this._pluginsDirs = pluginsDirs || (pluginsDir ? [pluginsDir] : []);
    this._dataDir = dataDir;
    this._bus = bus || null;
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

  scan(): PluginDescriptor[] {
    const results: PluginDescriptor[] = [];
    const seen = new Set<string>();
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
          console.error(`[plugin-manager] failed to read plugin "${entry.name}":`, errorMessage(err));
        }
      }
    }
    this._scanned = results;
    return results;
  }

  _readPluginDescriptor(pluginDir: string, dirName: string): PluginDescriptor {
    const manifestPath = path.join(pluginDir, "manifest.json");
    let manifest: PluginManifest | null = null;
    if (fs.existsSync(manifestPath)) {
      manifest = readJsonFile<PluginManifest>(manifestPath);
    }
    const id = manifest?.id || dirName;
    const name = manifest?.name || dirName;
    const version = manifest?.version || "0.0.0";
    const description = manifest?.description || "";
    const contributions: PluginContribution[] = [];
    for (const dir of KNOWN_CONTRIBUTION_DIRS) {
      if (fs.existsSync(path.join(pluginDir, dir))) contributions.push(dir);
    }
    if (fs.existsSync(path.join(pluginDir, "hooks.json"))) contributions.push("hooks");
    if (fs.existsSync(path.join(pluginDir, "index.js"))) contributions.push("lifecycle");
    return { id, name, version, description, pluginDir, manifest, contributions };
  }

  async loadAll(): Promise<void> {
    const descriptors = this._scanned.length > 0 ? this._scanned : this.scan();
    for (const desc of descriptors) {
      const entry: PluginEntry = { ...desc, status: "loading", instance: null, _disposables: [] };
      this._plugins.set(desc.id, entry);
      try {
        await this._loadPlugin(entry);
        entry.status = "loaded";
      } catch (err) {
        entry.status = "failed";
        entry.error = errorMessage(err);
        console.error(`[plugin-manager] plugin "${desc.id}" failed to load:`, errorMessage(err));
      }
    }
  }

  async _loadPlugin(entry: PluginEntry): Promise<void> {
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
    const mod = (await import(indexPath)) as LifecycleModule;
    const PluginClass = mod.default;
    if (!PluginClass || typeof PluginClass !== "function") return;
    const instance = new (PluginClass as PluginConstructor)();
    entry.instance = instance;
    instance.ctx = createPluginContext({
      pluginId: entry.id,
      pluginDir: entry.pluginDir,
      dataDir: path.join(this._dataDir, entry.id),
      bus: this._bus,
      engine: this._engine || null,
      disposables: entry._disposables,
    });
    instance.register = (disposable: unknown) => {
      if (typeof disposable === "function") entry._disposables.push(disposable as PluginDisposable);
    };
    if (typeof instance.onload === "function") await instance.onload();
  }

  // -- Task 5: Tool loader --------------------------------------------------

  async _loadTools(entry: PluginEntry): Promise<void> {
    const toolsDir = path.join(entry.pluginDir, "tools");
    if (!fs.existsSync(toolsDir)) return;
    const files = fs.readdirSync(toolsDir).filter((f) => f.endsWith(".js"));
    const configPath = path.join(this._dataDir, entry.id, "config.json");

    function getConfig(): JsonRecord;
    function getConfig(key: string): unknown;
    function getConfig(key?: string): JsonRecord | unknown {
      try {
        const data = readJsonFile<JsonRecord>(configPath);
        return key ? data[key] : data;
      } catch {
        return key ? undefined : {};
      }
    }

    const ctx: ToolExecutionContext = {
      bus: this._bus,
      engine: this._engine || null,
      config: {
        get: getConfig,
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
        const mod = (await import(filePath)) as ToolModule;
        if (!mod.name || !mod.description || typeof mod.execute !== "function") continue;
        const origExecute = mod.execute as ToolExecutor;
        this._tools.push({
          name: `${entry.id}.${String(mod.name)}`,
          description: mod.description,
          parameters: mod.parameters ?? {},
          execute: (input: unknown) => origExecute(input, ctx),
          _pluginId: entry.id,
        });
      } catch (err) {
        console.error(`[plugin-manager] tool "${file}" in "${entry.id}" failed to load:`, errorMessage(err));
      }
    }
  }

  getAllTools(): PluginTool[] {
    return [...this._tools];
  }

  // -- Task 6: Skill paths + Command loader --------------------------------

  async _loadSkillPaths(entry: PluginEntry): Promise<void> {
    const skillsDir = path.join(entry.pluginDir, "skills");
    if (!fs.existsSync(skillsDir)) return;
    this._skillPaths.push({
      dirPath: skillsDir,
      label: `plugin:${entry.id}`,
    });
  }

  getSkillPaths(): PluginSkillPath[] {
    return [...this._skillPaths];
  }

  async _loadCommands(entry: PluginEntry): Promise<void> {
    const cmdsDir = path.join(entry.pluginDir, "commands");
    if (!fs.existsSync(cmdsDir)) return;
    const files = fs.readdirSync(cmdsDir).filter((f) => f.endsWith(".js"));
    for (const file of files) {
      const filePath = path.join(cmdsDir, file);
      try {
        const mod = (await import(filePath)) as CommandModule;
        if (!mod.name || typeof mod.execute !== "function") continue;
        this._commands.push({
          name: `${entry.id}.${String(mod.name)}`,
          description: mod.description ?? "",
          execute: mod.execute as UnknownFunction,
          _pluginId: entry.id,
        });
      } catch (err) {
        console.error(`[plugin-manager] command "${file}" in "${entry.id}" failed to load:`, errorMessage(err));
      }
    }
  }

  getAllCommands(): PluginCommand[] {
    return [...this._commands];
  }

  // -- Task 7: Route loader -------------------------------------------------

  async _loadRoutes(entry: PluginEntry): Promise<void> {
    const routesDir = path.join(entry.pluginDir, "routes");
    if (!fs.existsSync(routesDir)) return;
    const { Hono: HonoCtor } = await import("hono");
    const app = new HonoCtor();
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
        const mod = (await import(filePath)) as RouteModule;
        if (hasFetch(mod.default)) {
          app.route(prefix, mod.default);
          continue;
        }
        if (typeof mod.default === "function") {
          const routeFactory = mod.default as UnknownFunction;
          if (routeFactory.length >= 2) {
            routeFactory(app, ctx);
          } else {
            const maybeApp = routeFactory(ctx);
            if (hasFetch(maybeApp)) {
              app.route(prefix, maybeApp);
            }
          }
          continue;
        }
        if (mod.register && typeof mod.register === "function") {
          const maybeApp = (mod.register as UnknownFunction)(app, ctx);
          if (hasFetch(maybeApp)) {
            app.route(prefix, maybeApp);
          }
        }
      } catch (err) {
        console.error('[plugin-manager] route "' + file + '" in "' + entry.id + '" failed to load:', errorMessage(err));
      }
    }
    this.routeRegistry.set(entry.id, app);
  }

  // -- Task 8: Hook loader --------------------------------------------------

  _loadHooks(entry: PluginEntry): void {
    const hooksJsonPath = path.join(entry.pluginDir, "hooks.json");
    if (!fs.existsSync(hooksJsonPath)) return;
    let hookMap: HookMap;
    try {
      hookMap = readJsonFile<HookMap>(hooksJsonPath);
    } catch (err) {
      console.error(`[plugin-manager] hooks.json in "${entry.id}" is invalid:`, errorMessage(err));
      return;
    }
    for (const [eventType, handlerPath] of Object.entries(hookMap)) {
      let canonicalHandler: string;
      try {
        const root = fs.realpathSync(entry.pluginDir);
        canonicalHandler = fs.realpathSync(path.resolve(root, handlerPath));
        const relative = path.relative(root, canonicalHandler);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      } catch { continue; }
      if (!this._hookRegistry.has(eventType)) this._hookRegistry.set(eventType, []);
      this._hookRegistry.get(eventType)?.push({
        pluginId: entry.id,
        // Resolve relative path against plugin directory
        handlerPath: canonicalHandler,
        _cache: null,
      });
    }
  }

  /**
   * Execute hooks for a given event type.
   *
   * Semantics for before-* hooks:
   *   - handler returns null   -> cancel (propagation stops, return null)
   *   - handler returns object -> replace event with returned value, continue chain
   *   - handler returns undefined -> pass-through unchanged
   *
   * For non-before-* hooks, the result of the last responding handler is returned.
   * If no handlers exist, the original event is returned unchanged.
   */
  async executeHook(eventType: string, event: unknown): Promise<unknown> {
    const handlers = this._hookRegistry.get(eventType);
    if (!handlers || handlers.length === 0) return event;

    const isBefore = eventType.startsWith("before-");
    let current = event;

    for (const hookEntry of handlers) {
      // Lazy-load and cache the handler function
      if (!hookEntry._cache) {
        try {
          const mod = (await import(hookEntry.handlerPath)) as HookModule;
          hookEntry._cache = mod.default ?? mod;
        } catch (err) {
          console.error(`[plugin-manager] hook handler "${hookEntry.handlerPath}" failed to load:`, errorMessage(err));
          continue;
        }
      }
      let result: unknown;
      try {
        result = await (hookEntry._cache as HookHandler)(current);
      } catch (err) {
        console.error(`[plugin-manager] hook handler "${hookEntry.handlerPath}" threw:`, errorMessage(err));
        continue;
      }

      if (isBefore) {
        if (result === null) return null; // cancelled
        if (result !== undefined) current = result; // replaced
        // undefined -> pass-through, current stays
      } else {
        if (result !== undefined) current = result;
      }
    }
    return current;
  }

  // -- Task 9: Configuration loader ----------------------------------------

  _loadConfiguration(entry: PluginEntry): void {
    const schema = entry.manifest?.contributes?.configuration;
    if (!schema) return;
    this._configSchemas.push({ pluginId: entry.id, schema });
  }

  getConfigSchema(pluginId: string): PluginConfigSchema | null {
    return this._configSchemas.find((s) => s.pluginId === pluginId)?.schema ?? null;
  }

  getAllConfigSchemas(): PluginConfigSchemaEntry[] {
    return [...this._configSchemas];
  }

  // -- Task 10: Agent templates + Provider loader --------------------------

  async _loadAgentTemplates(entry: PluginEntry): Promise<void> {
    const agentsDir = path.join(entry.pluginDir, "agents");
    if (!fs.existsSync(agentsDir)) return;
    const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(agentsDir, file);
      try {
        const template = readJsonFile<PluginAgentTemplate>(filePath);
        template._pluginId = entry.id;
        this._agentTemplates.push(template);
      } catch (err) {
        console.error(`[plugin-manager] agent template "${file}" in "${entry.id}" failed to load:`, errorMessage(err));
      }
    }
  }

  getAgentTemplates(): PluginAgentTemplate[] {
    return [...this._agentTemplates];
  }

  async _loadProviders(entry: PluginEntry): Promise<void> {
    const providersDir = path.join(entry.pluginDir, "providers");
    if (!fs.existsSync(providersDir)) return;
    const files = fs.readdirSync(providersDir).filter((f) => f.endsWith(".js"));
    for (const file of files) {
      const filePath = path.join(providersDir, file);
      try {
        const mod = (await import(filePath)) as ProviderModule;
        if (!mod.id) continue;
        this._providerPlugins.push({ ...mod, _pluginId: entry.id });
      } catch (err) {
        console.error(`[plugin-manager] provider "${file}" in "${entry.id}" failed to load:`, errorMessage(err));
      }
    }
  }

  getProviderPlugins(): PluginProvider[] {
    return [...this._providerPlugins];
  }

  // -- Lifecycle ------------------------------------------------------------

  _removePluginContributions(pluginId: string): void {
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

  async unloadPlugin(pluginId: string): Promise<void> {
    const entry = this._plugins.get(pluginId);
    if (!entry) return;
    if (entry.instance) {
      if (typeof entry.instance.onunload === "function") {
        try { await entry.instance.onunload(); } catch (err) {
          console.error(`[plugin-manager] "${pluginId}" onunload error:`, errorMessage(err));
        }
      }
      for (const d of entry._disposables.reverse()) {
        try { d(); } catch (err) {
          console.error(`[plugin-manager] "${pluginId}" disposable error:`, errorMessage(err));
        }
      }
      entry._disposables = [];
    }
    this.routeRegistry.delete(pluginId);
    this._removePluginContributions(pluginId);
    entry.status = "unloaded";
  }

  getPlugin(id: string): PluginEntry | null { return this._plugins.get(id) || null; }
  listPlugins(): PluginEntry[] { return [...this._plugins.values()]; }
}
