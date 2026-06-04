/**
 * McpTab pure data + transform helpers — builtin MCP server states & fallbacks,
 * group metadata, presets, draft<->server<->payload transforms, builtin-error
 * humanizer. Extracted from McpTab.tsx (GUI monolith decomposition). No React/
 * hooks/JSX/CSS/i18n — pure, unit-testable.
 */

export type McpServerState = {
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

export const BUILTIN_FALLBACKS: McpBuiltinState[] = [
  {
    name: 'tencent-docs',
    label: '腾讯文档',
    group: 'docs',
    description: '填一次 Token，就能把腾讯文档工具直接接进 Lynn。',
    docsUrl: 'https://docs.qq.com/open/auth/mcp.html',
    hint: '在腾讯文档开放平台生成 MCP Token 后填入即可。',
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
    label: 'MiniMax 搜索增强',
    group: 'search',
    description: '填一次 Token，即可启用 MiniMax 的网页搜索和图片理解增强。',
    docsUrl: 'https://platform.minimaxi.com/docs/token-plan/mcp-guide',
    hint: '需先安装 uv / uvx。启用后会同时提供 web_search 和 understand_image 两个增强工具。',
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
    label: '智谱联网搜索增强',
    group: 'search',
    description: '填一次 Z_AI_API_KEY，即可启用智谱专属联网搜索 MCP。',
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server',
    hint: 'GLM Coding Plan 用户专享。适合需要更强实时检索、技术资料搜索时启用。',
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
    label: '智谱网页读取增强',
    group: 'search',
    description: '填一次 Z_AI_API_KEY，即可启用网页正文读取与结构化提取。',
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/mcp/reader-mcp-server',
    hint: 'GLM Coding Plan 用户专享。适合长网页深读、正文提取、调研资料清洗。',
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
    label: '智谱开源仓库增强',
    group: 'search',
    description: '填一次 Z_AI_API_KEY，即可启用开源仓库搜索与内容读取。',
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/mcp/zread-mcp-server',
    hint: 'GLM Coding Plan 用户专享。适合代码库问答、开源项目结构理解和资料检索。',
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
    label: '智谱视觉增强',
    group: 'vision',
    description: '填一次 Z_AI_API_KEY，即可启用截图诊断、OCR、图表与界面理解增强。',
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/mcp/vision-mcp-server',
    hint: 'GLM Coding Plan 用户专享。需本机安装 Node.js 18+ 与 npx，适合截图报错、UI 对比、OCR 和图表分析。',
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

export const BUILTIN_GROUP_META: Array<{
  id: NonNullable<McpBuiltinState['group']>;
  title: string;
  copy: string;
}> = [
  {
    id: 'docs',
    title: '内置文档服务',
    copy: '先把日常办公和文档协作工具接进来，普通用户最容易马上用上的能力放在最上面。',
  },
  {
    id: 'search',
    title: '搜索与深读增强',
    copy: '这组更适合调研、网页深读和代码资料检索。GLM Coding Plan 用户可填写同一个 Z_AI_API_KEY 按需启用。',
  },
  {
    id: 'vision',
    title: '图片与视觉增强',
    copy: '截图报错、OCR、图表和界面理解都放在这里。适合需要更强视觉能力时再开启。',
  },
  {
    id: 'other',
    title: '其他增强',
    copy: '这里放补充型能力，不影响 Lynn 默认工作流。',
  },
];

export function humanizeBuiltinError(name: string, rawMessage?: string | null) {
  const message = String(rawMessage || '').trim();
  if (!message) return '';
  if (/missing required credentials/i.test(message)) {
    return '请先填写必要的 Token / API Key 后再测试。 Missing required token / API key.';
  }
  if (/spawn uvx ENOENT/i.test(message)) {
    if (name === 'minimax-enhanced') {
      return '未检测到 uvx。请先安装 uv / uvx 后，再测试 MiniMax 搜索增强。 Missing uvx. Please install uv / uvx first.';
    }
    return '未检测到 uvx。请先安装 uv / uvx。 Missing uvx. Please install uv / uvx first.';
  }
  if (/spawn npx ENOENT/i.test(message)) {
    if (name === 'zhipu-vision') {
      return '未检测到 npx。请先安装 Node.js 18+ 并确保 npx 可用，再测试智谱视觉增强。 Missing npx. Please install Node.js 18+ and ensure npx is available.';
    }
    return '未检测到 npx。请先安装 Node.js 18+ 并确保 npx 可用。 Missing npx. Please install Node.js 18+ and ensure npx is available.';
  }
  return message;
}

export type DraftState = {
  name: string;
  transport: 'stdio' | 'sse';
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
    name: server.name || '',
    transport: server.transport === 'sse' ? 'sse' : 'stdio',
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
  if (draft.transport === 'sse') {
    return {
      transport: 'sse',
      url: draft.url.trim(),
      headers: headersFromText(draft.headersText),
      messageUrl: draft.messageUrl.trim(),
      disabled: draft.disabled,
    };
  }
  return {
    command: draft.command.trim(),
    args: argsFromText(draft.argsText),
    cwd: draft.cwd.trim(),
    disabled: draft.disabled,
  };
}
