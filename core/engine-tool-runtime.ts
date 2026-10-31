import { createSandboxedTools } from "../lib/sandbox/index.js";
import { SECURITY_MODE_CONFIG } from "../shared/security-mode.js";
import path from "node:path";
import { PathGuard } from "../lib/sandbox/path-guard.js";
import { deriveSandboxPolicy } from "../lib/sandbox/policy.js";
import { isSensitiveFilePath } from "../shared/sensitive-file-path.js";

type AnyRecord = Record<string, any>;

export type ToolLike = AnyRecord & {
  name: string;
  execute?: (...args: any[]) => any;
  parameters?: {
    properties?: Record<string, { type?: string }>;
    required?: string[];
    [key: string]: any;
  };
  _guarded?: boolean;
  _aliasOf?: string;
};

interface WrapToolGuardOptions {
  getSessionPath?: () => string | null;
}

export type BuildToolsOptions = AnyRecord & {
  activeMcpServers?: Set<string>;
  agentDir?: string;
  workspace?: string | null;
  mode?: string;
  getSessionPath?: () => string | null;
};

interface BuildEngineToolRuntimeOptions {
  cwd: string;
  customTools?: ToolLike[];
  agentTools?: ToolLike[];
  pluginTools?: ToolLike[];
  mcpTools?: ToolLike[];
  agentDir: string;
  workspace: string | null;
  sandboxEnabled: boolean;
  securityMode: string;
  explicitMode?: string;
  trustedRoots: string[];
  lynnHome: string;
  confirmStore?: unknown;
  emitEvent: (event: unknown, sessionPath: unknown) => void;
  getSessionPath?: () => string | null;
}

export function selectMcpTools(
  tools: ToolLike[] = [],
  activeMcpServers?: Set<string>,
  autoLoad = false,
): ToolLike[] {
  if (activeMcpServers && activeMcpServers.size > 0) {
    return tools.filter((tool) => {
      const m = String(tool.name || "").match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
      return !!m && activeMcpServers.has(m[1]);
    });
  }
  return autoLoad ? tools : [];
}

function coerceParam(value: any, schema?: { type?: string }) {
  if (value === undefined || value === null) return value;
  const type = schema?.type;
  if (!type) return value;
  if (type === "number" || type === "integer") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (type === "boolean") {
    if (value === "true" || value === 1) return true;
    if (value === "false" || value === 0) return false;
    return value;
  }
  return value;
}

const SENSITIVE_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/\.ssh[/\\]/i, "SSH 密钥目录"],
  [/\.gnupg[/\\]/i, "GPG 密钥目录"],
  [/\.aws[/\\]credentials/i, "AWS 凭证文件"],
  [/\.env$/i, "环境变量文件"],
  [/\.env\.\w+$/i, "环境变量文件"],
  [/\.npmrc$/i, "npm token 文件"],
  [/\.pypirc$/i, "PyPI token 文件"],
  [/\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b/i, "SSH 私钥文件"],
  [/\.kube[/\\]config/i, "Kubernetes 配置"],
  [/\.docker[/\\]config\.json/i, "Docker 凭证"],
  [/keychain|keystore|\.p12$|\.pfx$/i, "密钥库文件"],
  [/\.git[/\\]config$/i, "Git 配置（可能含 token）"],
  [/\/etc\/shadow/i, "系统密码文件"],
  [/\/etc\/passwd/i, "系统用户文件"],
];

export function detectSensitiveParams(toolName: string, params: any) {
  if (!params) return null;
  const text = JSON.stringify(params);
  for (const [pattern, label] of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(text)) {
      return { label, toolName, matched: text.match(pattern)?.[0] };
    }
  }
  return null;
}

const DEFAULT_TOOL_INFLIGHT_TTL_MS = 45_000;
const TOOL_INFLIGHT_TTL_MS = Math.max(1_000, Number(process.env.LYNN_TOOL_INFLIGHT_TTL_MS || DEFAULT_TOOL_INFLIGHT_TTL_MS));
const MAX_INFLIGHT_KEY_CHARS = 8_000;
const inflightToolCalls = new Map<string, number>();

function stableSerialize(value: any, depth = 0): string {
  if (depth > 6) return '"[depth-limit]"';
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return JSON.stringify(value.length > 2_000 ? `${value.slice(0, 2_000)}…[${value.length} chars]` : value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function purgeExpiredInflightToolCalls(now = Date.now()) {
  for (const [key, startedAt] of inflightToolCalls.entries()) {
    if (now - startedAt > TOOL_INFLIGHT_TTL_MS) inflightToolCalls.delete(key);
  }
}

function buildInflightToolKey(toolName: string, params: any, sessionPath: string | null | undefined): string {
  const sessionKey = sessionPath || "global";
  const raw = `${sessionKey}\0${toolName}\0${stableSerialize(params)}`;
  return raw.length > MAX_INFLIGHT_KEY_CHARS ? raw.slice(0, MAX_INFLIGHT_KEY_CHARS) : raw;
}

export function wrapToolWithGuard(tool: ToolLike, opts: WrapToolGuardOptions = {}): ToolLike {
  if (!tool?.execute || tool._guarded) return tool;
  const originalExecute = tool.execute;
  const schema = tool.parameters;

  const guardedExecute = async (toolCallId: any, params: any, ...rest: any[]) => {
    let fixedParams = params || {};

    if (schema?.properties && typeof fixedParams === "object") {
      const coerced = { ...fixedParams };
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in coerced) {
          coerced[key] = coerceParam(coerced[key], propSchema);
        }
      }
      fixedParams = coerced;
    }

    const required = schema?.required || [];
    const missing = required.filter((k: string) => fixedParams[k] === undefined || fixedParams[k] === null);
    if (missing.length > 0) {
      return {
        content: [{ type: "text", text: `参数缺失 / Missing parameters: ${missing.join(", ")}。请补全后重试。` }],
      };
    }

    const sessionPath = opts.getSessionPath?.() || null;
    const inflightKey = buildInflightToolKey(tool.name, fixedParams, sessionPath);
    const startedAt = Date.now();
    purgeExpiredInflightToolCalls(startedAt);
    if (inflightToolCalls.has(inflightKey)) {
      return {
        content: [{
          type: "text",
          text: `已跳过重复的并发工具调用：${tool.name}。相同参数的调用正在执行中，请等待前一个结果。`,
        }],
        details: {
          deduped: true,
          tool: tool.name,
          sessionPath: sessionPath || undefined,
        },
      };
    }
    inflightToolCalls.set(inflightKey, startedAt);

    try {
      const sensitive = detectSensitiveParams(tool.name, fixedParams);
      if (sensitive) {
        console.warn(`[ClawAegis] 敏感路径检测: tool=${sensitive.toolName} target=${sensitive.label} match=${sensitive.matched}`);
        const result = await originalExecute(toolCallId, fixedParams, ...rest);
        const warningText = `⚠️ 安全提示：检测到访问${sensitive.label}（${sensitive.matched}）。请确认这是用户明确要求的操作。如非必要，不要读取或传输此类文件内容。`;
        if (result?.content?.[0]?.type === "text") {
          result.content[0].text = warningText + "\n\n" + result.content[0].text;
        }
        return result;
      }

      return await originalExecute(toolCallId, fixedParams, ...rest);
    } finally {
      if (inflightToolCalls.get(inflightKey) === startedAt) {
        inflightToolCalls.delete(inflightKey);
      }
    }
  };

  return { ...tool, execute: guardedExecute, _guarded: true };
}

const TOOL_ALIASES: Record<string, string> = {
  "web-search": "web_search",
  "websearch": "web_search",
  "web-fetch": "web_fetch",
  "webfetch": "web_fetch",
  "stock-market": "stock_market",
  "stockmarket": "stock_market",
  "live-news": "live_news",
  "livenews": "live_news",
  "sports-score": "sports_score",
  "sportsscore": "sports_score",
  "exchange-rate": "exchange_rate",
  "exchangerate": "exchange_rate",
  "unit-convert": "unit_convert",
  "unitconvert": "unit_convert",
  "express-tracking": "express_tracking",
  "expresstracking": "express_tracking",
  "search-memory": "search_memory",
  "searchmemory": "search_memory",
  "pin-memory": "pin_memory",
  "unpin-memory": "unpin_memory",
  "recall-experience": "recall_experience",
  "record-experience": "record_experience",
  "present-files": "present_files",
  "presentfiles": "present_files",
  "create-artifact": "create_artifact",
  "install-skill": "install_skill",
  "update-settings": "update_settings",
  "ask-agent": "ask_agent",
  "message-agent": "message_agent",
};

export function normalizeToolAliasName(name: unknown): string {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  return TOOL_ALIASES[lower] || lower.replace(/-/g, "_");
}

export function createToolAliases(customTools: ToolLike[]): ToolLike[] {
  const nameSet = new Set(customTools.map((t) => t.name));
  const aliases: ToolLike[] = [];
  for (const tool of customTools) {
    for (const [alias, target] of Object.entries(TOOL_ALIASES)) {
      if (target === tool.name && !nameSet.has(alias)) {
        aliases.push({ ...tool, name: alias, _aliasOf: tool.name });
        nameSet.add(alias);
      }
    }
  }
  return aliases;
}

function resolveSandboxMode(explicitMode: string | undefined, sandboxEnabled: boolean, securityMode: string) {
  if (explicitMode) return explicitMode;
  if (!sandboxEnabled) return "full-access";
  const secConfig = SECURITY_MODE_CONFIG[securityMode as keyof typeof SECURITY_MODE_CONFIG];
  return secConfig ? secConfig.sandboxMode : "standard";
}

export function buildEngineToolRuntime(opts: BuildEngineToolRuntimeOptions) {
  const allTools = [
    ...(opts.customTools || opts.agentTools || []),
    ...(opts.pluginTools || []),
    ...(opts.mcpTools || []).map(tool => wrapMcpFilePaths(tool, opts)),
  ];

  const result = createSandboxedTools(opts.cwd, allTools, {
    agentDir: opts.agentDir,
    workspace: opts.workspace,
    trustedRoots: opts.trustedRoots,
    lynnHome: opts.lynnHome,
    mode: resolveSandboxMode(opts.explicitMode, opts.sandboxEnabled, opts.securityMode) as any,
    confirmStore: opts.confirmStore,
    emitEvent: opts.emitEvent as any,
    getSessionPath: opts.getSessionPath,
  });

  const guardedTools = ((result.customTools || []) as ToolLike[]).map((tool) => wrapToolWithGuard(tool, {
    getSessionPath: opts.getSessionPath,
  }));
  const aliases = createToolAliases(guardedTools);
  result.customTools = aliases.length > 0 ? [...guardedTools, ...aliases] : guardedTools;
  return result;
}

/** File-path parameters are capabilities, even when a tool runs in an MCP process. */
export function wrapMcpFilePaths(tool: ToolLike, opts: BuildEngineToolRuntimeOptions): ToolLike {
  if (!tool.execute) return tool;
  const execute = tool.execute;
  const guard = new PathGuard(deriveSandboxPolicy({ agentDir: opts.agentDir, workspace: opts.workspace,
    trustedRoots: opts.trustedRoots, lynnHome: opts.lynnHome, mode: 'standard' }));
  return { ...tool, execute: async (id: any, params: any, ...rest: any[]) => {
    const fixed = structuredClone(params || {});
    for (const fields of [fixed, fixed.params, fixed.arguments]) {
      if (!fields || typeof fields !== 'object') continue;
      for (const key of ['file_path', 'filepath']) {
        if (typeof fields[key] !== 'string' || !fields[key].trim()) continue;
        const target = path.resolve(opts.cwd, fields[key]);
        if (isSensitiveFilePath(target, opts.lynnHome) || !guard.check(target, 'write').allowed) {
          return { isError: true, content: [{ type: 'text', text: 'MCP file output denied: choose a file inside an explicitly approved workspace or the agent downloads directory.' }] };
        }
        fields[key] = target;
      }
    }
    return execute(id, fixed, ...rest);
  } };
}
