/**
 * McpTab pure data + transform helpers — builtin MCP server states & fallbacks,
 * group metadata, presets, draft<->server<->payload transforms, builtin-error
 * humanizer. Extracted from McpTab.tsx (GUI monolith decomposition). No React/
 * hooks/JSX/CSS/i18n — pure, unit-testable.
 */

import { isChineseLocale } from '../../utils/locale';

export type McpServerState = {
  env?: Record<string, unknown>;
  oauth?: { clientId?: string; scope?: string };
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  disabled?: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  messageUrl?: string;
  source?: 'local' | 'discovered' | 'builtin';
  sourcePath?: string | null;
  connected?: boolean;
  lastError?: string | null;
  toolCount?: number;
  resourceCount?: number;
  tools?: Array<{ name: string; description?: string }>;
  resources?: Array<{ name: string; uri?: string }>;
};

export type McpBuiltinField = {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  value?: string;
};

export type McpBuiltinState = {
  name: string;
  label: string;
  group?: 'docs' | 'search' | 'vision' | 'other';
  description?: string;
  docsUrl?: string;
  hint?: string;
  transport: 'stdio' | 'sse' | 'http';
  configured?: boolean;
  enabled?: boolean;
  connected?: boolean;
  lastError?: string | null;
  toolCount?: number;
  resourceCount?: number;
  tools?: Array<{ name: string; description?: string }>;
  resources?: Array<{ name: string; uri?: string }>;
  credentialFields: McpBuiltinField[];
};

function builtinFallbackData(zh: boolean): McpBuiltinState[] {
  return [
  {
    name: 'tencent-docs',
    label: zh ? '腾讯文档' : 'Tencent Docs',
    group: 'docs',
    description: zh
      ? '填一次 Token，就能把腾讯文档工具直接接进 Lynn。'
      : 'Add a token once and Tencent Docs tools plug straight into Lynn.',
    docsUrl: 'https://docs.qq.com/open/auth/mcp.html',
    hint: zh
      ? '在腾讯文档开放平台生成 MCP Token 后填入即可。'
      : 'Generate an MCP token on the Tencent Docs open platform and paste it here.',
    transport: 'http',
    configured: false,
    enabled: false,
    connected: false,
    lastError: null,
    toolCount: 0,
    resourceCount: 0,
    tools: [],
    resources: [],
    credentialFields: [
      {
        key: 'token',
        label: 'Token',
        placeholder: 'docs_xxx',
        secret: true,
        value: '',
      },
    ],
  },
  {
    name: 'minimax-enhanced',
    label: zh ? 'MiniMax 搜索增强' : 'MiniMax search boost',
    group: 'search',
    description: zh
      ? '填一次 Token，即可启用 MiniMax 的网页搜索和图片理解增强。'
      : 'Add a token once to enable MiniMax web search and image understanding.',
    docsUrl: 'https://platform.minimaxi.com/docs/token-plan/mcp-guide',
    hint: zh
      ? '需先安装 uv / uvx。启用后会同时提供 web_search 和 understand_image 两个增强工具。'
      : 'Requires uv / uvx. Once enabled it provides both the web_search and understand_image tools.',
    transport: 'stdio',
    configured: false,
    enabled: false,
    connected: false,
    lastError: null,
    toolCount: 0,
    resourceCount: 0,
    tools: [],
    resources: [],
    credentialFields: [
      {
        key: 'token',
        label: 'Token',
        placeholder: 'sk-xxx',
        secret: true,
        value: '',
      },
    ],
  },
  {
    name: 'zhipu-search',
    label: zh ? '智谱联网搜索增强' : 'Zhipu web search boost',
    group: 'search',
    description: zh
      ? '填一次 Z_AI_API_KEY，即可启用智谱专属联网搜索 MCP。'
      : 'Add a Z_AI_API_KEY once to enable the Zhipu web-search MCP.',
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server',
    hint: zh
      ? 'GLM Coding Plan 用户专享。适合需要更强实时检索、技术资料搜索时启用。'
      : 'For GLM Coding Plan users. Enable it when you need stronger realtime retrieval and technical search.',
    transport: 'http',
    configured: false,
    enabled: false,
    connected: false,
    lastError: null,
    toolCount: 0,
    resourceCount: 0,
    tools: [],
    resources: [],
    credentialFields: [
      {
        key: 'token',
        label: 'Z_AI_API_KEY',
        placeholder: 'sk-xxx',
        secret: true,
        value: '',
      },
    ],
  },
  {
    name: 'zhipu-reader',
    label: zh ? '智谱网页读取增强' : 'Zhipu page reader boost',
    group: 'search',
    description: zh
      ? '填一次 Z_AI_API_KEY，即可启用网页正文读取与结构化提取。'
      : 'Add a Z_AI_API_KEY once to enable page-body reading and structured extraction.',
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/mcp/reader-mcp-server',
    hint: zh
      ? 'GLM Coding Plan 用户专享。适合长网页深读、正文提取、调研资料清洗。'
      : 'For GLM Coding Plan users. Good for deep-reading long pages, extracting body text and cleaning research material.',
    transport: 'http',
    configured: false,
    enabled: false,
    connected: false,
    lastError: null,
    toolCount: 0,
    resourceCount: 0,
    tools: [],
    resources: [],
    credentialFields: [
      {
        key: 'token',
        label: 'Z_AI_API_KEY',
        placeholder: 'sk-xxx',
        secret: true,
        value: '',
      },
    ],
  },
  {
    name: 'zhipu-zread',
    label: zh ? '智谱开源仓库增强' : 'Zhipu repo reader boost',
    group: 'search',
    description: zh
      ? '填一次 Z_AI_API_KEY，即可启用开源仓库搜索与内容读取。'
      : 'Add a Z_AI_API_KEY once to enable repository search and content reading.',
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/mcp/zread-mcp-server',
    hint: zh
      ? 'GLM Coding Plan 用户专享。适合代码库问答、开源项目结构理解和资料检索。'
      : 'For GLM Coding Plan users. Good for codebase Q&A, understanding open-source layouts and finding references.',
    transport: 'http',
    configured: false,
    enabled: false,
    connected: false,
    lastError: null,
    toolCount: 0,
    resourceCount: 0,
    tools: [],
    resources: [],
    credentialFields: [
      {
        key: 'token',
        label: 'Z_AI_API_KEY',
        placeholder: 'sk-xxx',
        secret: true,
        value: '',
      },
    ],
  },
  {
    name: 'zhipu-vision',
    label: zh ? '智谱视觉增强' : 'Zhipu vision boost',
    group: 'vision',
    description: zh
      ? '填一次 Z_AI_API_KEY，即可启用截图诊断、OCR、图表与界面理解增强。'
      : 'Add a Z_AI_API_KEY once to enable screenshot diagnosis, OCR, chart and UI understanding.',
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/mcp/vision-mcp-server',
    hint: zh
      ? 'GLM Coding Plan 用户专享。需本机安装 Node.js 18+ 与 npx，适合截图报错、UI 对比、OCR 和图表分析。'
      : 'For GLM Coding Plan users. Requires Node.js 18+ and npx locally; good for screenshot errors, UI comparison, OCR and chart analysis.',
    transport: 'stdio',
    configured: false,
    enabled: false,
    connected: false,
    lastError: null,
    toolCount: 0,
    resourceCount: 0,
    tools: [],
    resources: [],
    credentialFields: [
      {
        key: 'token',
        label: 'Z_AI_API_KEY',
        placeholder: 'sk-xxx',
        secret: true,
        value: '',
      },
    ],
  },
  ];
}

/**
 * Built-in MCP server card fallbacks.
 *
 * This module is pure (no React), so the getter resolves the current locale on
 * each read instead of freezing one language at module load.
 */
export function getBuiltinFallbacks(): McpBuiltinState[] {
  return builtinFallbackData(isChineseLocale());
}

/** Snapshot for module-scope consumers; refreshed via getBuiltinFallbacks(). */
export const BUILTIN_FALLBACKS: McpBuiltinState[] = builtinFallbackData(isChineseLocale());

export function mergeBuiltinStates(nextBuiltin: McpBuiltinState[]): McpBuiltinState[] {
  const byName = new Map<string, McpBuiltinState>();
  for (const builtin of BUILTIN_FALLBACKS) byName.set(builtin.name, builtin);
  for (const builtin of nextBuiltin || []) {
    byName.set(builtin.name, {
      ...(byName.get(builtin.name) || {}),
      ...builtin,
      credentialFields: builtin.credentialFields?.length
        ? builtin.credentialFields
        : byName.get(builtin.name)?.credentialFields || [],
    });
  }
  return [...byName.values()];
}

export type McpBuiltinGroupMeta = {
  id: NonNullable<McpBuiltinState['group']>;
  title: string;
  copy: string;
};

export function getBuiltinGroupMeta(zh = isChineseLocale()): McpBuiltinGroupMeta[] {
  return [
    {
      id: 'docs',
      title: zh ? '内置文档服务' : 'Built-in document services',
      copy: zh
        ? '先把日常办公和文档协作工具接进来，普通用户最容易马上用上的能力放在最上面。'
        : 'Everyday office and document-collaboration tools come first, since those are what most people can use right away.',
    },
    {
      id: 'search',
      title: zh ? '搜索与深读增强' : 'Search and deep-reading boosts',
      copy: zh
        ? '这组更适合调研、网页深读和代码资料检索。GLM Coding Plan 用户可填写同一个 Z_AI_API_KEY 按需启用。'
        : "This group suits research, deep page reading and code reference lookups. GLM Coding Plan users can reuse the same Z_AI_API_KEY and enable them on demand.",
    },
    {
      id: 'vision',
      title: zh ? '图片与视觉增强' : 'Image and vision boosts',
      copy: zh
        ? '截图报错、OCR、图表和界面理解都放在这里。适合需要更强视觉能力时再开启。'
        : 'Screenshot errors, OCR, charts and UI understanding live here. Turn them on when you need stronger vision.',
    },
    {
      id: 'other',
      title: zh ? '其他增强' : 'Other boosts',
      copy: zh
        ? '这里放补充型能力，不影响 Lynn 默认工作流。'
        : "Supplementary capabilities that never change Lynn's default workflow.",
    },
  ];
}

/** Snapshot for module-scope consumers; use getBuiltinGroupMeta() for live locale. */
export const BUILTIN_GROUP_META: McpBuiltinGroupMeta[] = getBuiltinGroupMeta();

export function humanizeBuiltinError(name: string, rawMessage?: string | null) {
  const message = String(rawMessage || '').trim();
  if (!message) return '';
  const zh = isChineseLocale();
  if (/missing required credentials/i.test(message)) {
    return zh
      ? '请先填写必要的 Token / API Key 后再测试。'
      : 'Fill in the required token / API key before testing.';
  }
  if (/spawn uvx ENOENT/i.test(message)) {
    if (name === 'minimax-enhanced') {
      return zh
        ? '未检测到 uvx。请先安装 uv / uvx 后，再测试 MiniMax 搜索增强。'
        : 'uvx was not found. Install uv / uvx first, then test the MiniMax search boost.';
    }
    return zh
      ? '未检测到 uvx。请先安装 uv / uvx。'
      : 'uvx was not found. Please install uv / uvx first.';
  }
  if (/spawn npx ENOENT/i.test(message)) {
    if (name === 'zhipu-vision') {
      return zh
        ? '未检测到 npx。请先安装 Node.js 18+ 并确保 npx 可用，再测试智谱视觉增强。'
        : 'npx was not found. Install Node.js 18+ and make sure npx is available, then test the Zhipu vision boost.';
    }
    return zh
      ? '未检测到 npx。请先安装 Node.js 18+ 并确保 npx 可用。'
      : 'npx was not found. Install Node.js 18+ and make sure npx is available.';
  }
  return message;
}

export type DraftState = {
  env?: Record<string, unknown>;
  oauthEnabled?: boolean;
  oauthClientId?: string;
  oauthScope?: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command: string;
  argsText: string;
  cwd: string;
  url: string;
  headersText: string;
  messageUrl: string;
  disabled: boolean;
};

export const PRESETS: Array<{ id: string; label: string; build: () => DraftState }> = [
  {
    id: 'filesystem',
    label: 'Filesystem',
    build: () => ({
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      argsText: '@modelcontextprotocol/server-filesystem /Users/lynn',
      cwd: '',
      url: '',
      headersText: '',
      messageUrl: '',
      disabled: false,
    }),
  },
  {
    id: 'github',
    label: 'GitHub',
    build: () => ({
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      argsText: '@modelcontextprotocol/server-github',
      cwd: '',
      url: '',
      headersText: '{\n  "Authorization": "Bearer ghp_xxx"\n}',
      messageUrl: '',
      disabled: false,
    }),
  },
  {
    id: 'notion',
    label: 'Notion',
    build: () => ({
      name: 'notion',
      transport: 'sse',
      command: '',
      argsText: '',
      cwd: '',
      url: 'https://mcp.notion.so/sse',
      headersText: '{\n  "Authorization": "Bearer ntn_xxx"\n}',
      messageUrl: '',
      disabled: false,
    }),
  },
  {
    id: 'slack',
    label: 'Slack',
    build: () => ({
      name: 'slack',
      transport: 'sse',
      command: '',
      argsText: '',
      cwd: '',
      url: 'https://mcp.slack.com/sse',
      headersText: '{\n  "Authorization": "Bearer xapp-xxx"\n}',
      messageUrl: '',
      disabled: false,
    }),
  },
  {
    id: 'jira',
    label: 'Jira',
    build: () => ({
      name: 'jira',
      transport: 'sse',
      command: '',
      argsText: '',
      cwd: '',
      url: 'https://mcp.atlassian.com/jira/sse',
      headersText: '{\n  "Authorization": "Bearer jira_xxx"\n}',
      messageUrl: '',
      disabled: false,
    }),
  },
];

export function emptyDraft(): DraftState {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    argsText: '',
    cwd: '',
    url: '',
    headersText: '',
    messageUrl: '',
    disabled: false,
  };
}

export function argsFromText(value: string): string[] {
  return value
    .split(/\r?\n|,/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function headersFromText(value: string): Record<string, string> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]));
  } catch {
    return Object.fromEntries(
      trimmed
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf(':');
          if (index < 0) return [line, ''];
          return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        })
        .filter(([key]) => key),
    );
  }
}

export function draftFromServer(server: McpServerState | null): DraftState {
  if (!server) return emptyDraft();
  return {
    oauthEnabled: !!server.oauth, oauthClientId: server.oauth?.clientId || '', oauthScope: server.oauth?.scope || '',
    name: server.name || '',
    transport: server.transport === 'http' ? 'http' : server.transport === 'sse' ? 'sse' : 'stdio',
    env: server.env,
    command: server.command || '',
    argsText: (server.args || []).join('\n'),
    cwd: server.cwd || '',
    url: server.url || '',
    headersText: server.headers && Object.keys(server.headers).length > 0
      ? JSON.stringify(server.headers, null, 2)
      : '',
    messageUrl: server.messageUrl || '',
    disabled: server.disabled === true,
  };
}

export function buildPayload(draft: DraftState) {
  if (draft.transport === 'sse' || draft.transport === 'http') {
    return {
      transport: draft.transport,
      ...(draft.oauthEnabled ? { oauth: { clientId: draft.oauthClientId || '', scope: draft.oauthScope || '' } } : {}),
      url: draft.url.trim(),
      headers: headersFromText(draft.headersText),
      messageUrl: draft.messageUrl.trim(),
      disabled: draft.disabled,
    };
  }
  return {
    command: draft.command.trim(),
    ...(draft.env ? { env: draft.env } : {}),
    args: argsFromText(draft.argsText),
    cwd: draft.cwd.trim(),
    disabled: draft.disabled,
  };
}
