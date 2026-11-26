/**
 * mcp-client.ts — MCP (Model Context Protocol) 客户端
 *
 * 支持：
 * - stdio 传输
 * - SSE 传输（远程 MCP）
 * - tools/list + tools/call
 * - resources/list
 * - 兼容 Cursor / Codex / Claude Desktop / VS Code 的 MCP 配置发现
 *
 * 配置文件：~/.lynn/mcp-servers.yaml
 */

import fs from "fs";
import { McpOAuth } from "./mcp/oauth.js";
import { refreshManagedKimiCredentials } from "./mcp/kimi-device-auth.js";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { createModuleLogger } from "./debug-log.js";
import { Type } from "@sinclair/typebox";
import { createMcpConnection, type McpConnectionBase } from "./mcp-client-connections.js";
import { isEnglishLocale } from "../shared/i18n-runtime.js";
import {
  BUILTIN_SERVERS,
  DISCOVERY_PATHS,
  cloneDeep,
  errorMessage,
  normalizeServerConfig,
  parseCompatConfig,
  replaceCredentialPlaceholders,
  resolveDiscoveryPath,
  sanitizeBuiltinCredentialFields,
  serializeServerConfig,
  type BuiltinCredentialStore,
  type CredentialValues,
  type HeaderMap,
  type McpBuiltinState,
  type McpResource,
  type McpServerConfigMap,
  type McpServerState,
  type McpServerTemplateKind,
  type McpTestServerResult,
  type McpTool,
  type McpToolDefinition,
  type McpTransport,
  type NormalizedMcpServerConfig,
  type RawMcpServerConfig,
  type SaveBuiltinCredentialsPayload,
} from "./mcp-client-config.js";

const log = createModuleLogger("mcp");
export type {
  BuiltinCredentialSpec,
  McpBuiltinState,
  McpHttpServerConfig,
  McpResource,
  McpServerState,
  McpServerTemplateKind,
  McpSseServerConfig,
  McpStdioServerConfig,
  McpTestServerResult,
  McpTool,
  McpToolDefinition,
  McpTransport,
  NormalizedMcpServerConfig,
  RawMcpServerConfig,
  SanitizedBuiltinCredentialSpec,
  SaveBuiltinCredentialsPayload,
} from "./mcp-client-config.js";

export class McpManager {
  private oauth: McpOAuth;
  private _lynnHome: string;
  private _configPath: string;
  private _credentialsPath: string;
  private _connections: Map<string, McpConnectionBase>;
  private _localServers: McpServerConfigMap;
  private _discoveredServers: McpServerConfigMap;
  private _builtinServers: McpServerConfigMap;
  private _builtinCredentials: BuiltinCredentialStore;
  private _mergedServers: McpServerConfigMap;

  constructor(lynnHome: string) {
    this.oauth = new McpOAuth(path.join(lynnHome, "user", "mcp-oauth"));
    this._lynnHome = lynnHome;
    this._configPath = path.join(lynnHome, "mcp-servers.yaml");
    this._credentialsPath = path.join(lynnHome, "user", "mcp-credentials.json");
    this._connections = new Map();
    this._localServers = {};
    this._discoveredServers = {};
    this._builtinServers = {};
    this._builtinCredentials = {};
    this._mergedServers = {};
  }

  async init(): Promise<void> {
    this._loadConfigs();
    const tasks = Object.entries(this._mergedServers)
      .filter(([, config]) => !config.disabled)
      .map(([name, config]) => this._connectServer(name, config));
    await Promise.allSettled(tasks);
    log.log(`MCP init done: ${this.serverCount} server(s), ${this.toolCount} tool(s)`);
  }

  async dispose(preserveOAuth = false): Promise<void> {
    if (!preserveOAuth) this.oauth.dispose();
    for (const [, conn] of this._connections) {
      conn.close();
    }
    this._connections.clear();
  }

  async reload(): Promise<void> {
    await this.dispose(true);
    this._loadConfigs();
    await this.init();
  }

  get serverCount(): number {
    return [...this._connections.values()].filter((conn) => conn.ready).length;
  }

  get toolCount(): number {
    return this.getTools().length;
  }

  getTools(): McpToolDefinition[] {
    const tools: McpToolDefinition[] = [];
    for (const [serverName, connection] of this._connections) {
      for (const mcpTool of connection.tools || []) {
        const fullName = `mcp__${serverName}__${mcpTool.name}`;
        tools.push(this._convertTool(fullName, connection, mcpTool));
      }
    }
    return tools;
  }

  getPromptContext(): string {
    const lines: string[] = [];
    for (const [name, connection] of this._connections) {
      const resources = connection.resources || [];
      if (resources.length === 0) continue;
      lines.push(`- ${name}: ${resources.slice(0, 5).map((item) => item.name || item.title || item.uri).filter(Boolean).join(", ")}`);
    }
    if (lines.length === 0) return "";
    return ["[MCP Resources]", ...lines].join("\n");
  }

  listServerStates(): McpServerState[] {
    return Object.entries(this._mergedServers).map(([name, config]) => {
      const configView = config as {
        command?: string;
        args?: string[];
        cwd?: string;
        url?: string;
        headers?: HeaderMap;
        messageUrl?: string;
      };
      const connection = this._connections.get(name) || null;
      const source = this._builtinServers[name]
        ? "builtin"
        : this._localServers[name]
          ? "local"
          : "discovered";
      const builtin = BUILTIN_SERVERS[name] || null;
      return {
        name,
        ...(config.oauth ? { oauth: config.oauth } : {}),
        transport: config.transport || "stdio",
        disabled: config.disabled === true,
        command: configView.command || "",
        ...(config.transport === "stdio" ? { env: config.env } : {}),
        args: configView.args || [],
        cwd: configView.cwd || "",
        url: configView.url || "",
        headers: configView.headers || {},
        messageUrl: configView.messageUrl || "",
        source,
        sourcePath: source === "builtin"
          ? this._credentialsPath
          : source === "discovered"
            ? DISCOVERY_PATHS
              .map((rel) => resolveDiscoveryPath(this._lynnHome, rel))
              .find((candidate) => parseCompatConfig(candidate)?.[name]) || null
            : this._configPath,
        builtin: !!builtin,
        label: builtin?.label || name,
        docsUrl: builtin?.docsUrl || "",
        connected: !!connection?.ready,
        lastError: connection?.lastError || null,
        toolCount: connection?.tools?.length || 0,
        resourceCount: connection?.resources?.length || 0,
        tools: (connection?.tools || []).map((tool) => ({
          name: tool.name,
          description: tool.description || "",
        })),
        resources: (connection?.resources || []).map((resource) => ({
          name: resource.name || resource.title || resource.uri,
          uri: resource.uri || "",
        })),
      };
    });
  }

  /**
   * Built-in server states.
   *
   * @param locale  render locale; anything non-Chinese returns the English copy.
   *                Defaults to Chinese for CLI/headless callers.
   */
  listBuiltinStates(locale?: string | null): McpBuiltinState[] {
    const english = isEnglishLocale(locale);
    const states = this.listServerStates();
    return Object.values(BUILTIN_SERVERS).map((builtin) => {
      const serverState = states.find((item) => item.name === builtin.name) || null;
      const rawEntry = this._builtinCredentials?.[builtin.name];
      const credentials = (rawEntry?.credentials && typeof rawEntry.credentials === "object"
        ? rawEntry.credentials
        : rawEntry && typeof rawEntry === "object"
          ? rawEntry
          : {}) as CredentialValues;
      const configured = builtin.credentialFields.every((field) => String(credentials?.[field.key] || "").trim());
      const enabled = rawEntry?.enabled !== false;
      return {
        name: builtin.name,
        label: (english && builtin.labelEn) || builtin.label,
        group: builtin.group || "other",
        description: (english && builtin.descriptionEn) || builtin.description,
        docsUrl: builtin.docsUrl,
        hint: (english && builtin.hintEn) || builtin.hint || "",
        labelEn: builtin.labelEn,
        descriptionEn: builtin.descriptionEn,
        hintEn: builtin.hintEn,
        transport: builtin.transport,
        configured,
        enabled,
        connected: !!serverState?.connected,
        lastError: serverState?.lastError || null,
        toolCount: serverState?.toolCount || 0,
        resourceCount: serverState?.resourceCount || 0,
        tools: serverState?.tools || [],
        resources: serverState?.resources || [],
        credentialFields: sanitizeBuiltinCredentialFields(builtin.credentialFields, credentials),
      };
    });
  }

  async saveBuiltinCredentials(
    name: string,
    payload: SaveBuiltinCredentialsPayload = {},
  ): Promise<McpBuiltinState | null> {
    const builtin = BUILTIN_SERVERS[name];
    if (!builtin) throw new Error(`unknown builtin MCP server: ${name}`);

    const credentials = payload?.credentials && typeof payload.credentials === "object" ? payload.credentials : {};
    const enabled = typeof payload?.enabled === "boolean" ? payload.enabled : undefined;
    const current = this._readBuiltinCredentials();
    const prev = current[name] && typeof current[name] === "object" ? current[name] : {};
    current[name] = {
      ...prev,
      ...(enabled !== undefined ? { enabled } : {}),
      credentials: {
        ...(prev.credentials && typeof prev.credentials === "object" ? prev.credentials : {}),
        ...Object.fromEntries(
          Object.entries(credentials)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => [key, String(value)]),
        ),
      },
    };
    this._writeBuiltinCredentials(current);
    await this.reload();
    return this.listBuiltinStates().find((item) => item.name === name) || null;
  }

  async testBuiltinServer(
    name: string,
    payload: SaveBuiltinCredentialsPayload = {},
  ): Promise<McpTestServerResult> {
    const builtin = BUILTIN_SERVERS[name];
    if (!builtin) throw new Error(`unknown builtin MCP server: ${name}`);
    const current = this._readBuiltinCredentials();
    const prev = current[name] && typeof current[name] === "object" ? current[name] : {};
    const overrideCredentials = payload?.credentials && typeof payload.credentials === "object" ? payload.credentials : {};
    const credentials = {
      ...(prev.credentials && typeof prev.credentials === "object" ? prev.credentials : {}),
      ...Object.fromEntries(
        Object.entries(overrideCredentials)
          .filter(([, value]) => value !== undefined && value !== null && String(value).trim())
          .map(([key, value]) => [key, String(value)]),
      ),
    };
    const configured = builtin.credentialFields.every((field) => String(credentials?.[field.key] || "").trim());
    if (!configured) {
      throw new Error(`builtin MCP server "${name}" is missing required credentials`);
    }
    const config = this._resolveBuiltinServerConfig(name, credentials, { enabled: true });
    if (!config) throw new Error(`unknown builtin MCP server: ${name}`);
    return this.testServerConfig(name, config);
  }

  async saveServer(name: string, config: RawMcpServerConfig): Promise<McpServerState | null> {
    const trimmedName = String(name || "").trim();
    if (!trimmedName) throw new Error("MCP server name is required");
    const normalized = normalizeServerConfig(config);
    if ((normalized.transport === "sse" || normalized.transport === "http") && !normalized.url) {
      throw new Error(`${normalized.transport.toUpperCase()} MCP server requires url`);
    }
    if (normalized.transport === "stdio" && !normalized.command) {
      throw new Error("stdio MCP server requires command");
    }
    const localConfig = this._readLocalConfig();
    localConfig.servers[trimmedName] = serializeServerConfig(normalized);
    this._writeLocalConfig(localConfig);
    await this.reload();
    return this.listServerStates().find((item) => item.name === trimmedName) || null;
  }

  async deleteServer(name: string): Promise<void> {
    if (!this._localServers[name]) {
      throw new Error(`MCP server "${name}" is not editable`);
    }
    const localConfig = this._readLocalConfig();
    delete localConfig.servers[name];
    this._writeLocalConfig(localConfig);
    await this.reload();
  }

  async testServerConfig(name: string, config: RawMcpServerConfig): Promise<McpTestServerResult> {
    const normalized = normalizeServerConfig(config);
    const connection = this._createConnection(name || "test", normalized);
    try {
      await connection.connect();
      const [tools, resources] = await Promise.all([
        connection.listTools(),
        connection.listResources(),
      ]);
      if (connection.lastError) throw new Error(connection.lastError);
      return {
        ok: true,
        toolCount: tools.length,
        resourceCount: resources.length,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description || "" })),
        resources: resources.map((resource) => ({ name: resource.name || resource.title || resource.uri, uri: resource.uri || "" })),
      };
    } finally {
      connection.close();
    }
  }

  private async _connectServer(name: string, config: NormalizedMcpServerConfig): Promise<void> {
    try {
      const connection = this._createConnection(name, config);
      this._connections.set(name, connection);
      await connection.connect();
      await Promise.all([connection.listTools(), connection.listResources()]);
      if (connection.lastError) throw new Error(connection.lastError);
      this._connections.set(name, connection);
      log.log(`[${name}] connected, ${connection.tools.length} tool(s), ${connection.resources.length} resource(s)`);
    } catch (err) {
      this._connections.get(name)?.markFailed(errorMessage(err));
      log.log(`[${name}] connect failed: ${errorMessage(err)}`);
    }
  }

  private _createConnection(name: string, config: NormalizedMcpServerConfig): McpConnectionBase {
    const connection = createMcpConnection(name, config);
    if (config.oauth && config.transport !== "stdio") connection.setAuthorizationProvider(force => this.oauth.headers(name, config.url, force));
    return connection;
  }

  private oauthConfig(name: string) {
    const config = this._mergedServers[name];
    if (!config || config.transport === "stdio" || !config.oauth) throw new Error("Enable OAuth on an HTTP or SSE MCP server first");
    return config;
  }
  oauthStatus(name: string) { const config = this.oauthConfig(name); return this.oauth.status(name, config.url); }
  startOAuth(name: string) { const config = this.oauthConfig(name); return this.oauth.start(name, config.url, config.oauth); }
  async disconnectOAuth(name: string) { const config = this.oauthConfig(name); this.oauth.disconnect(name, config.url); await this.reload(); }

  private _convertTool(fullName: string, connection: McpConnectionBase, mcpTool: McpTool): McpToolDefinition {
    const params = mcpTool.inputSchema || Type.Object({});
    return {
      name: fullName,
      label: mcpTool.name,
      description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
      parameters: params,
      execute: async (_toolCallId: string, args: unknown) => {
        try {
          if (connection.config.transport === 'stdio' && connection.config.env.LYNN_KIMI_MANAGED === '1' && typeof connection.config.env.KIMI_CODE_HOME === 'string') await refreshManagedKimiCredentials(connection.config.env.KIMI_CODE_HOME);
          const result = await connection.callTool(mcpTool.name, args || {});
          const content = result?.content || [];
          if (content.length === 0) {
            return { content: [{ type: "text", text: "(no output)" }] };
          }
          return { content };
        } catch (err) {
          return { content: [{ type: "text", text: `MCP error: ${errorMessage(err)}` }] };
        }
      },
    };
  }

  private _readLocalConfig(): { servers: Record<string, RawMcpServerConfig>; discoverExternal: boolean } {
    try {
      if (!fs.existsSync(this._configPath)) return { servers: {}, discoverExternal: false };
      const parsed = (YAML.load(fs.readFileSync(this._configPath, "utf-8")) || {}) as {
        servers?: unknown;
        discover_external?: unknown;
      };
      return {
        servers: parsed.servers && typeof parsed.servers === "object"
          ? parsed.servers as Record<string, RawMcpServerConfig>
          : {},
        discoverExternal: parsed.discover_external === true,
      };
    } catch (err) {
      log.log(`config load failed: ${errorMessage(err)}`);
      return { servers: {}, discoverExternal: false };
    }
  }

  private _writeLocalConfig(config: { servers: Record<string, RawMcpServerConfig>; discoverExternal?: boolean }): void {
    fs.mkdirSync(path.dirname(this._configPath), { recursive: true });
    const yaml = YAML.dump({
      discover_external: config.discoverExternal === true,
      servers: config.servers || {},
    }, {
      indent: 2,
      lineWidth: -1,
      sortKeys: false,
    });
    fs.writeFileSync(this._configPath, yaml, { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(this._configPath, 0o600);
  }

  private _readBuiltinCredentials(): BuiltinCredentialStore {
    try {
      if (!fs.existsSync(this._credentialsPath)) return {};
      const parsed = JSON.parse(fs.readFileSync(this._credentialsPath, "utf-8"));
      return parsed && typeof parsed === "object" ? parsed as BuiltinCredentialStore : {};
    } catch (err) {
      log.log(`builtin credential load failed: ${errorMessage(err)}`);
      return {};
    }
  }

  private _writeBuiltinCredentials(raw: BuiltinCredentialStore): void {
    fs.mkdirSync(path.dirname(this._credentialsPath), { recursive: true });
    fs.writeFileSync(this._credentialsPath, JSON.stringify(raw || {}, null, 2), "utf-8");
    try { fs.chmodSync(this._credentialsPath, 0o600); } catch {}
  }

  private _resolveBuiltinServerConfig(
    name: string,
    credentials: CredentialValues = {},
    opts: { enabled?: boolean } = {},
  ): NormalizedMcpServerConfig | null {
    const builtin = BUILTIN_SERVERS[name];
    if (!builtin) return null;
    const configured = builtin.credentialFields.every((field) => String(credentials?.[field.key] || "").trim());
    const enabled = opts.enabled !== false;
    const resolved = replaceCredentialPlaceholders(cloneDeep(builtin.config), credentials) as RawMcpServerConfig;
    return normalizeServerConfig({
      ...resolved,
      disabled: !(enabled && configured),
    });
  }

  private _buildBuiltinServers(): McpServerConfigMap {
    const builtins: McpServerConfigMap = {};
    const entries = this._readBuiltinCredentials();
    for (const builtin of Object.values(BUILTIN_SERVERS)) {
      const rawEntry = entries[builtin.name];
      const credentials = (rawEntry?.credentials && typeof rawEntry.credentials === "object"
        ? rawEntry.credentials
        : rawEntry && typeof rawEntry === "object"
          ? rawEntry
          : {}) as CredentialValues;
      const enabled = rawEntry?.enabled !== false;
      const resolved = this._resolveBuiltinServerConfig(builtin.name, credentials, { enabled });
      if (resolved) builtins[builtin.name] = resolved;
    }
    this._builtinCredentials = entries;
    return builtins;
  }

  private _discoverServers(enabled: boolean): McpServerConfigMap {
    const discovered: McpServerConfigMap = {};
    if (!enabled) return discovered;
    for (const relativePath of DISCOVERY_PATHS) {
      const fullPath = resolveDiscoveryPath(this._lynnHome, relativePath);
      Object.assign(discovered, parseCompatConfig(fullPath));
    }
    return discovered;
  }

  private _loadConfigs(): void {
    const localConfig = this._readLocalConfig();
    this._localServers = Object.fromEntries(
      Object.entries(localConfig.servers || {}).map(([name, config]) => [name, normalizeServerConfig(config)]),
    );
    this._builtinServers = this._buildBuiltinServers();
    const allowExternalDiscovery = localConfig.discoverExternal === true
      || process.env.LYNN_MCP_DISCOVER_EXTERNAL === "1";
    this._discoveredServers = this._discoverServers(allowExternalDiscovery);
    this._mergedServers = {
      ...this._discoveredServers,
      ...this._builtinServers,
      ...this._localServers,
    };
  }
}

export function createDefaultMcpServerTemplate(kind: McpServerTemplateKind = "stdio"): RawMcpServerConfig {
  if (kind === "http") {
    return {
      transport: "http",
      url: "",
      headers: {},
    };
  }
  if (kind === "sse") {
    return {
      transport: "sse",
      url: "",
      headers: {},
      messageUrl: "",
    };
  }
  return {
    transport: "stdio",
    command: "",
    args: [],
    env: {},
    cwd: os.homedir(),
  };
}
