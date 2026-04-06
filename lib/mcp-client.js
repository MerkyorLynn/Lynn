/**
 * mcp-client.js — MCP (Model Context Protocol) 客户端
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

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { createModuleLogger } from "./debug-log.js";
import { Type } from "@sinclair/typebox";

const log = createModuleLogger("mcp");
let _msgId = 0;

const MCP_DISCOVERY_PATHS = [
  ".cursor/mcp.json",
  ".codex/mcp.json",
  ".vscode/mcp.json",
  "claude_desktop_config.json",
];

function normalizeHeaders(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, headerValue]) => headerValue !== undefined && headerValue !== null && headerValue !== "")
      .map(([key, headerValue]) => [key, String(headerValue)]),
  );
}

function normalizeArgs(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function normalizeServerConfig(raw = {}) {
  const base = {
    disabled: raw.disabled === true,
  };

  if (raw.transport === "sse" || raw.url) {
    return {
      ...base,
      transport: "sse",
      url: String(raw.url || "").trim(),
      headers: normalizeHeaders(raw.headers),
      messageUrl: raw.messageUrl || raw.message_url || "",
    };
  }

  return {
    ...base,
    transport: "stdio",
    command: String(raw.command || "").trim(),
    args: normalizeArgs(raw.args),
    env: raw.env && typeof raw.env === "object" ? raw.env : {},
    cwd: raw.cwd ? String(raw.cwd).trim() : "",
  };
}

function serializeServerConfig(config = {}) {
  const normalized = normalizeServerConfig(config);
  if (normalized.transport === "sse") {
    return {
      transport: "sse",
      url: normalized.url,
      ...(Object.keys(normalized.headers || {}).length > 0 ? { headers: normalized.headers } : {}),
      ...(normalized.messageUrl ? { messageUrl: normalized.messageUrl } : {}),
      ...(normalized.disabled ? { disabled: true } : {}),
    };
  }

  return {
    command: normalized.command,
    ...(normalized.args?.length ? { args: normalized.args } : {}),
    ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
    ...(normalized.env && Object.keys(normalized.env).length > 0 ? { env: normalized.env } : {}),
    ...(normalized.disabled ? { disabled: true } : {}),
  };
}

function resolveDiscoveryPath(lynnHome, relativePath) {
  const homeDir = path.dirname(lynnHome);
  return path.join(homeDir, relativePath);
}

function parseCompatConfig(rawPath) {
  try {
    if (!fs.existsSync(rawPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(rawPath, "utf-8"));
    const rawServers = parsed?.servers || parsed?.mcpServers || parsed?.mcp_servers || {};
    if (!rawServers || typeof rawServers !== "object") return {};

    const servers = {};
    for (const [name, rawConfig] of Object.entries(rawServers)) {
      if (!rawConfig || typeof rawConfig !== "object") continue;
      const normalized = normalizeServerConfig(rawConfig);
      if (normalized.transport === "sse" && !normalized.url) continue;
      if (normalized.transport === "stdio" && !normalized.command) continue;
      servers[name] = normalized;
    }
    return servers;
  } catch (err) {
    log.log(`compat config parse failed (${rawPath}): ${err.message}`);
    return {};
  }
}

function deriveSseMessageUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "";
  if (/\/sse\/?$/i.test(trimmed)) {
    return trimmed.replace(/\/sse\/?$/i, "/messages");
  }
  return `${trimmed.replace(/\/+$/, "")}/messages`;
}

function parseSseEvent(block) {
  let eventName = "message";
  const dataLines = [];
  for (const rawLine of String(block || "").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return {
    eventName,
    data: dataLines.join("\n").trim(),
  };
}

class McpConnectionBase {
  constructor(name, config) {
    this.name = name;
    this.config = normalizeServerConfig(config);
    this._pending = new Map();
    this._tools = [];
    this._resources = [];
    this._ready = false;
    this._lastError = null;
    this._closed = false;
  }

  get tools() { return this._tools; }
  get resources() { return this._resources; }
  get ready() { return this._ready; }
  get lastError() { return this._lastError; }

  async listTools() {
    if (!this._ready) return [];
    try {
      const result = await this._sendRequest("tools/list", {});
      this._tools = result?.tools || [];
      return this._tools;
    } catch (err) {
      this._lastError = err?.message || String(err);
      log.log(`[${this.name}] tools/list failed: ${this._lastError}`);
      return [];
    }
  }

  async listResources() {
    if (!this._ready) return [];
    try {
      const result = await this._sendRequest("resources/list", {});
      this._resources = result?.resources || [];
      return this._resources;
    } catch (err) {
      // resources/list 不是所有服务器都支持，静默降级
      return [];
    }
  }

  async callTool(toolName, args) {
    if (!this._ready) throw new Error(`MCP server "${this.name}" not ready`);
    return this._sendRequest("tools/call", { name: toolName, arguments: args });
  }

  _handleJsonRpcMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.id && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
  }

  _rejectPending(err) {
    for (const [, { reject }] of this._pending) {
      reject(err);
    }
    this._pending.clear();
  }
}

class McpStdioConnection extends McpConnectionBase {
  constructor(name, config) {
    super(name, config);
    this.command = this.config.command;
    this.args = this.config.args || [];
    this.env = this.config.env || {};
    this.cwd = this.config.cwd || undefined;
    this._process = null;
    this._buffer = "";
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`MCP server "${this.name}" startup timeout`)), 15000);

      try {
        this._process = spawn(this.command, this.args, {
          cwd: this.cwd,
          env: { ...process.env, ...this.env },
          stdio: ["pipe", "pipe", "pipe"],
        });

        this._process.stdout.on("data", (chunk) => this._onData(chunk));
        this._process.stderr.on("data", (chunk) => {
          log.log(`[${this.name}] stderr: ${chunk.toString().trim()}`);
        });
        this._process.on("error", (err) => {
          clearTimeout(timeout);
          this._lastError = err.message;
          reject(err);
        });
        this._process.on("exit", (code) => {
          log.log(`[${this.name}] exited with code ${code}`);
          this._ready = false;
        });

        this._sendRequest("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "lynn", version: "1.0.0" },
        }).then((result) => {
          clearTimeout(timeout);
          this._sendNotification("notifications/initialized", {});
          this._ready = true;
          this._lastError = null;
          resolve(result);
        }).catch((err) => {
          clearTimeout(timeout);
          this._lastError = err.message;
          reject(err);
        });
      } catch (err) {
        clearTimeout(timeout);
        this._lastError = err.message;
        reject(err);
      }
    });
  }

  close() {
    this._ready = false;
    this._closed = true;
    if (this._process) {
      try { this._process.kill(); } catch {}
      this._process = null;
    }
    this._rejectPending(new Error("Connection closed"));
  }

  _sendRequest(method, params) {
    const id = ++_msgId;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        this._process.stdin.write(msg);
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  _sendNotification(method, params) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    try { this._process?.stdin.write(msg); } catch {}
  }

  _onData(chunk) {
    this._buffer += chunk.toString();
    const lines = this._buffer.split("\n");
    this._buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this._handleJsonRpcMessage(JSON.parse(line));
      } catch {}
    }
  }
}

class McpSseConnection extends McpConnectionBase {
  constructor(name, config) {
    super(name, config);
    this.url = this.config.url;
    this.headers = normalizeHeaders(this.config.headers);
    this._messageUrl = this.config.messageUrl || "";
    this._streamController = null;
    this._reconnectTimer = null;
    this._reconnectDelayMs = 1000;
    this._waitingForEndpoint = [];
  }

  async connect() {
    this._closed = false;
    this._ready = false;
    this._lastError = null;

    const controller = new AbortController();
    this._streamController = controller;
    const connectTimeout = setTimeout(() => controller.abort(new DOMException("MCP SSE connect timeout", "AbortError")), 15000);

    try {
      const res = await fetch(this.url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          ...this.headers,
        },
        signal: controller.signal,
      });
      clearTimeout(connectTimeout);

      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: ${res.status} ${res.statusText}`);
      }

      void this._consumeStream(res.body);

      if (!this._messageUrl) {
        this._messageUrl = await this._awaitMessageUrl();
      }
      if (!this._messageUrl) {
        this._messageUrl = deriveSseMessageUrl(this.url);
      }

      const result = await this._sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lynn", version: "1.0.0" },
      });
      this._sendNotification("notifications/initialized", {});
      this._ready = true;
      this._reconnectDelayMs = 1000;
      return result;
    } catch (err) {
      clearTimeout(connectTimeout);
      this._lastError = err.message;
      this.close();
      throw err;
    }
  }

  close() {
    this._closed = true;
    this._ready = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try { this._streamController?.abort(); } catch {}
    this._streamController = null;
    this._rejectPending(new Error("Connection closed"));
  }

  _awaitMessageUrl() {
    if (this._messageUrl) return Promise.resolve(this._messageUrl);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._waitingForEndpoint = this._waitingForEndpoint.filter((entry) => entry.resolve !== resolve);
        resolve(deriveSseMessageUrl(this.url));
      }, 1500);
      this._waitingForEndpoint.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  }

  async _consumeStream(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let splitIndex = buffer.indexOf("\n\n");
        while (splitIndex >= 0) {
          const rawEvent = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex + 2);
          this._handleSseEvent(rawEvent);
          splitIndex = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      if (this._closed) return;
      this._lastError = err.message;
    } finally {
      if (!this._closed) {
        this._ready = false;
        this._scheduleReconnect();
      }
    }
  }

  _handleSseEvent(rawEvent) {
    const { eventName, data } = parseSseEvent(rawEvent);
    if (!data) return;

    if (eventName === "endpoint") {
      try {
        this._messageUrl = new URL(data, this.url).toString();
      } catch {
        this._messageUrl = data;
      }
      const pending = [...this._waitingForEndpoint];
      this._waitingForEndpoint = [];
      for (const waiter of pending) waiter.resolve(this._messageUrl);
      return;
    }

    try {
      this._handleJsonRpcMessage(JSON.parse(data));
    } catch {
      log.log(`[${this.name}] ignored non-JSON SSE event (${eventName})`);
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this._closed) return;
    const delay = this._reconnectDelayMs;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.connect();
        await this.listTools();
        await this.listResources();
      } catch (err) {
        this._lastError = err.message;
        this._reconnectDelayMs = Math.min(this._reconnectDelayMs * 2, 10_000);
        this._scheduleReconnect();
      }
    }, delay);
  }

  _sendRequest(method, params) {
    const id = ++_msgId;
    const postUrl = this._messageUrl || deriveSseMessageUrl(this.url);
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      fetch(postUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers,
        },
        body,
      }).then((res) => {
        if (res.ok || res.status === 202 || res.status === 204) return;
        this._pending.delete(id);
        reject(new Error(`SSE request failed: ${res.status} ${res.statusText}`));
      }).catch((err) => {
        this._pending.delete(id);
        reject(err);
      });
    });
  }

  _sendNotification(method, params) {
    const postUrl = this._messageUrl || deriveSseMessageUrl(this.url);
    void fetch(postUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    }).catch(() => {});
  }
}

export class McpManager {
  constructor(lynnHome) {
    this._lynnHome = lynnHome;
    this._configPath = path.join(lynnHome, "mcp-servers.yaml");
    this._connections = new Map();
    this._localServers = {};
    this._discoveredServers = {};
    this._mergedServers = {};
  }

  async init() {
    this._loadConfigs();
    const tasks = Object.entries(this._mergedServers)
      .filter(([, config]) => !config.disabled)
      .map(([name, config]) => this._connectServer(name, config));
    await Promise.allSettled(tasks);
    log.log(`MCP init done: ${this.serverCount} server(s), ${this.toolCount} tool(s)`);
  }

  async dispose() {
    for (const [, conn] of this._connections) {
      conn.close();
    }
    this._connections.clear();
  }

  async reload() {
    await this.dispose();
    this._loadConfigs();
    await this.init();
  }

  get serverCount() {
    return [...this._connections.values()].filter((conn) => conn.ready).length;
  }

  get toolCount() {
    return this.getTools().length;
  }

  getTools() {
    const tools = [];
    for (const [serverName, connection] of this._connections) {
      for (const mcpTool of connection.tools || []) {
        const fullName = `mcp__${serverName}__${mcpTool.name}`;
        tools.push(this._convertTool(fullName, connection, mcpTool));
      }
    }
    return tools;
  }

  getPromptContext() {
    const lines = [];
    for (const [name, connection] of this._connections) {
      const resources = connection.resources || [];
      if (resources.length === 0) continue;
      lines.push(`- ${name}: ${resources.slice(0, 5).map((item) => item.name || item.title || item.uri).filter(Boolean).join(", ")}`);
    }
    if (lines.length === 0) return "";
    return ["[MCP Resources]", ...lines].join("\n");
  }

  listServerStates() {
    return Object.entries(this._mergedServers).map(([name, config]) => {
      const connection = this._connections.get(name) || null;
      const source = this._localServers[name] ? "local" : "discovered";
      return {
        name,
        transport: config.transport || "stdio",
        disabled: config.disabled === true,
        command: config.command || "",
        args: config.args || [],
        cwd: config.cwd || "",
        url: config.url || "",
        headers: config.headers || {},
        messageUrl: config.messageUrl || "",
        source,
        sourcePath: source === "discovered"
          ? MCP_DISCOVERY_PATHS
              .map((rel) => resolveDiscoveryPath(this._lynnHome, rel))
              .find((candidate) => parseCompatConfig(candidate)?.[name]) || null
          : this._configPath,
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

  async saveServer(name, config) {
    const trimmedName = String(name || "").trim();
    if (!trimmedName) throw new Error("MCP server name is required");
    const normalized = normalizeServerConfig(config);
    if (normalized.transport === "sse" && !normalized.url) {
      throw new Error("SSE MCP server requires url");
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

  async deleteServer(name) {
    if (!this._localServers[name]) {
      throw new Error(`MCP server "${name}" is not editable`);
    }
    const localConfig = this._readLocalConfig();
    delete localConfig.servers[name];
    this._writeLocalConfig(localConfig);
    await this.reload();
  }

  async testServerConfig(name, config) {
    const normalized = normalizeServerConfig(config);
    const connection = this._createConnection(name || "test", normalized);
    try {
      await connection.connect();
      const [tools, resources] = await Promise.all([
        connection.listTools(),
        connection.listResources(),
      ]);
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

  async _connectServer(name, config) {
    try {
      const connection = this._createConnection(name, config);
      await connection.connect();
      await Promise.all([connection.listTools(), connection.listResources()]);
      this._connections.set(name, connection);
      log.log(`[${name}] connected, ${connection.tools.length} tool(s), ${connection.resources.length} resource(s)`);
    } catch (err) {
      log.log(`[${name}] connect failed: ${err.message}`);
    }
  }

  _createConnection(name, config) {
    return config.transport === "sse"
      ? new McpSseConnection(name, config)
      : new McpStdioConnection(name, config);
  }

  _convertTool(fullName, connection, mcpTool) {
    const params = mcpTool.inputSchema || Type.Object({});
    return {
      name: fullName,
      label: mcpTool.name,
      description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
      parameters: params,
      execute: async (_toolCallId, args) => {
        try {
          const result = await connection.callTool(mcpTool.name, args || {});
          const content = result?.content || [];
          if (content.length === 0) {
            return { content: [{ type: "text", text: "(no output)" }] };
          }
          return { content };
        } catch (err) {
          return { content: [{ type: "text", text: `MCP error: ${err.message}` }] };
        }
      },
    };
  }

  _readLocalConfig() {
    try {
      if (!fs.existsSync(this._configPath)) return { servers: {} };
      const parsed = YAML.load(fs.readFileSync(this._configPath, "utf-8")) || {};
      return {
        servers: parsed.servers && typeof parsed.servers === "object" ? parsed.servers : {},
      };
    } catch (err) {
      log.log(`config load failed: ${err.message}`);
      return { servers: {} };
    }
  }

  _writeLocalConfig(config) {
    fs.mkdirSync(path.dirname(this._configPath), { recursive: true });
    const yaml = YAML.dump({ servers: config.servers || {} }, {
      indent: 2,
      lineWidth: -1,
      sortKeys: false,
    });
    fs.writeFileSync(this._configPath, yaml, "utf-8");
  }

  _discoverServers() {
    const discovered = {};
    for (const relativePath of MCP_DISCOVERY_PATHS) {
      const fullPath = resolveDiscoveryPath(this._lynnHome, relativePath);
      Object.assign(discovered, parseCompatConfig(fullPath));
    }
    return discovered;
  }

  _loadConfigs() {
    const localConfig = this._readLocalConfig();
    this._localServers = Object.fromEntries(
      Object.entries(localConfig.servers || {}).map(([name, config]) => [name, normalizeServerConfig(config)]),
    );
    this._discoveredServers = this._discoverServers();
    this._mergedServers = {
      ...this._discoveredServers,
      ...this._localServers,
    };
  }
}

export function createDefaultMcpServerTemplate(kind = "stdio") {
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
