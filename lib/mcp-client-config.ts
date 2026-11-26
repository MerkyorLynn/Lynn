import fs from "fs";
import path from "path";
import { createModuleLogger } from "./debug-log.js";
import { MCP_BUILTIN_SERVERS, MCP_DISCOVERY_PATHS } from "./mcp/mcp-catalog.js";

const log = createModuleLogger("mcp");

export type HeaderMap = Record<string, string>;
export type RawObject = Record<string, unknown>;
export type TimerHandle = ReturnType<typeof setTimeout>;

export type McpTransport = "stdio" | "sse" | "http";
export type McpServerTemplateKind = McpTransport;

export interface RawMcpServerConfig extends RawObject {
  disabled?: unknown;
  transport?: unknown;
  url?: unknown;
  headers?: unknown;
  messageUrl?: unknown;
  message_url?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
}

export interface McpServerConfigBase extends RawObject {
  disabled: boolean;
  oauth?: { clientId?: string; scope?: string };
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  transport: "stdio";
  command: string;
  args: string[];
  env: RawObject;
  cwd: string;
}

export interface McpSseServerConfig extends McpServerConfigBase {
  transport: "sse";
  url: string;
  headers: HeaderMap;
  messageUrl: string;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  transport: "http";
  url: string;
  headers: HeaderMap;
}

export type NormalizedMcpServerConfig = McpStdioServerConfig | McpSseServerConfig | McpHttpServerConfig;
export type McpServerConfigMap = Record<string, NormalizedMcpServerConfig>;

export interface BuiltinCredentialSpec {
  key: string;
  label?: string;
  placeholder?: string;
  secret?: boolean;
}

export interface SanitizedBuiltinCredentialSpec {
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
  value: string;
}

export interface BuiltinMcpServer {
  name: string;
  label: string;
  group?: string;
  description: string;
  docsUrl: string;
  transport: McpTransport;
  config: RawMcpServerConfig;
  credentialFields: BuiltinCredentialSpec[];
  hint?: string;
  /** English twins; the manager picks by render locale. */
  labelEn?: string;
  descriptionEn?: string;
  hintEn?: string;
}

export interface BuiltinCredentialEntry extends RawObject {
  enabled?: unknown;
  credentials?: unknown;
}

export type BuiltinCredentialStore = Record<string, BuiltinCredentialEntry>;
export type CredentialValues = Record<string, unknown>;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export interface McpResource {
  name?: string;
  title?: string;
  uri?: string;
  [key: string]: unknown;
}

export interface McpListToolsResult {
  tools?: McpTool[];
}

export interface McpListResourcesResult {
  resources?: McpResource[];
}

export interface McpToolCallResult {
  content?: RawObject[];
  [key: string]: unknown;
}

export interface McpToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(toolCallId: string, args?: unknown): Promise<{ content: RawObject[] }>;
}

export interface McpServerState {
  oauth?: { clientId?: string; scope?: string };
  name: string;
  transport: McpTransport;
  disabled: boolean;
  command: string;
  args: string[];
  cwd: string;
  url: string;
  headers: HeaderMap;
  messageUrl: string;
  source: "builtin" | "local" | "discovered";
  sourcePath: string | string[] | null;
  builtin: boolean;
  label: string;
  docsUrl: string;
  connected: boolean;
  lastError: string | null;
  toolCount: number;
  resourceCount: number;
  tools: Array<{ name: string; description: string }>;
  resources: Array<{ name: string | undefined; uri: string }>;
}

export interface McpBuiltinState {
  name: string;
  label: string;
  group: string;
  description: string;
  docsUrl: string;
  hint: string;
  /** English twins; renderers pick by UI locale. */
  labelEn?: string;
  descriptionEn?: string;
  hintEn?: string;
  transport: McpTransport;
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  lastError: string | null;
  toolCount: number;
  resourceCount: number;
  tools: McpServerState["tools"];
  resources: McpServerState["resources"];
  credentialFields: SanitizedBuiltinCredentialSpec[];
}

export interface SaveBuiltinCredentialsPayload {
  credentials?: CredentialValues;
  enabled?: boolean;
}

export interface McpTestServerResult {
  ok: true;
  toolCount: number;
  resourceCount: number;
  tools: Array<{ name: string; description: string }>;
  resources: Array<{ name: string | undefined; uri: string }>;
}

export type JsonRpcId = string | number | null;

export interface JsonRpcErrorPayload {
  message?: string;
  [key: string]: unknown;
}

export interface JsonRpcResponsePayload {
  jsonrpc?: "2.0" | string;
  id?: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

export interface JsonRpcOutboundPayload {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

export interface PendingJsonRpcRequest {
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
}

export interface HttpPostOptions {
  notification?: boolean;
}

export const BUILTIN_SERVERS = MCP_BUILTIN_SERVERS as unknown as Record<string, BuiltinMcpServer>;
export const DISCOVERY_PATHS = MCP_DISCOVERY_PATHS as unknown as string[];

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function normalizeHeaders(value: unknown): HeaderMap {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, headerValue]) => headerValue !== undefined && headerValue !== null && headerValue !== "")
      .map(([key, headerValue]) => [key, String(headerValue)]),
  );
}

export function normalizeArgs(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

export function cloneDeep<T>(value: T): T | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function replaceCredentialPlaceholders(value: unknown, credentials: CredentialValues): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
      const credentialValue = credentials?.[String(key).trim()];
      return credentialValue === undefined || credentialValue === null ? "" : String(credentialValue);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceCredentialPlaceholders(item, credentials));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceCredentialPlaceholders(item, credentials)]),
    );
  }
  return value;
}

export function normalizeServerConfig(raw: RawMcpServerConfig = {}): NormalizedMcpServerConfig {
  const base = {
    disabled: raw.disabled === true,
    ...(raw.oauth && typeof raw.oauth === "object" && !Array.isArray(raw.oauth) ? { oauth: {
      clientId: String((raw.oauth as RawObject).clientId || ""), scope: String((raw.oauth as RawObject).scope || ""),
    } } : {}),
  };

  if (raw.transport === "http" || raw.transport === "streamable-http") {
    return {
      ...base,
      transport: "http",
      url: String(raw.url || "").trim(),
      headers: normalizeHeaders(raw.headers),
    };
  }

  if (raw.transport === "sse" || raw.url) {
    return {
      ...base,
      transport: "sse",
      url: String(raw.url || "").trim(),
      headers: normalizeHeaders(raw.headers),
      messageUrl: (raw.messageUrl || raw.message_url || "") as string,
    };
  }

  return {
    ...base,
    transport: "stdio",
    command: String(raw.command || "").trim(),
    args: normalizeArgs(raw.args),
    env: raw.env && typeof raw.env === "object" ? raw.env as RawObject : {},
    cwd: raw.cwd ? String(raw.cwd).trim() : "",
  };
}

export function serializeServerConfig(config: RawMcpServerConfig = {}): RawMcpServerConfig {
  const normalized = normalizeServerConfig(config);
  if (normalized.transport === "http") {
    return {
      transport: "http",
      url: normalized.url,
      ...(normalized.oauth ? { oauth: normalized.oauth } : {}),
      ...(Object.keys(normalized.headers || {}).length > 0 ? { headers: normalized.headers } : {}),
      ...(normalized.disabled ? { disabled: true } : {}),
    };
  }
  if (normalized.transport === "sse") {
    return {
      transport: "sse",
      url: normalized.url,
      ...(normalized.oauth ? { oauth: normalized.oauth } : {}),
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

export function resolveDiscoveryPath(lynnHome: string, relativePath: string): string {
  const homeDir = path.dirname(lynnHome);
  return path.join(homeDir, relativePath);
}

export function sanitizeBuiltinCredentialFields(
  fields: BuiltinCredentialSpec[] = [],
  credentials: CredentialValues = {},
): SanitizedBuiltinCredentialSpec[] {
  return fields.map((field) => ({
    key: field.key,
    label: field.label || field.key,
    placeholder: field.placeholder || "",
    secret: field.secret !== false,
    value: credentials?.[field.key] ? String(credentials[field.key]) : "",
  }));
}

export function parseCompatConfig(rawPath: string): McpServerConfigMap {
  try {
    if (!fs.existsSync(rawPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(rawPath, "utf-8")) as {
      servers?: unknown;
      mcpServers?: unknown;
      mcp_servers?: unknown;
    };
    const rawServers = parsed?.servers || parsed?.mcpServers || parsed?.mcp_servers || {};
    if (!rawServers || typeof rawServers !== "object") return {};

    const servers: McpServerConfigMap = {};
    for (const [name, rawConfig] of Object.entries(rawServers)) {
      if (!rawConfig || typeof rawConfig !== "object") continue;
      const normalized = normalizeServerConfig(rawConfig as RawMcpServerConfig);
      if (normalized.transport === "sse" && !normalized.url) continue;
      if (normalized.transport === "stdio" && !normalized.command) continue;
      servers[name] = normalized;
    }
    return servers;
  } catch (err) {
    log.log(`compat config parse failed (${rawPath}): ${errorMessage(err)}`);
    return {};
  }
}

export function deriveSseMessageUrl(url: unknown): string {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "";
  if (/\/sse\/?$/i.test(trimmed)) {
    return trimmed.replace(/\/sse\/?$/i, "/messages");
  }
  return `${trimmed.replace(/\/+$/, "")}/messages`;
}

export function parseSseEvent(block: unknown): { eventName: string; data: string } {
  let eventName = "message";
  const dataLines: string[] = [];
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
