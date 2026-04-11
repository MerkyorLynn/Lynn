export const MCP_BUILTIN_SERVERS = {
  "tencent-docs": {
    name: "tencent-docs",
    label: "腾讯文档",
    group: "docs",
    description: "填一次 Token，就能把腾讯文档工具直接接进 Lynn。",
    docsUrl: "https://docs.qq.com/open/auth/mcp.html",
    transport: "http",
    config: {
      transport: "http",
      url: "https://docs.qq.com/openapi/mcp",
      headers: {
        Authorization: "Bearer ${token}",
      },
    },
    credentialFields: [
      {
        key: "token",
        label: "Token",
        placeholder: "docs_xxx",
        secret: true,
      },
    ],
    hint: "在腾讯文档开放平台生成 MCP Token 后填入即可。",
  },
  "minimax-enhanced": {
    name: "minimax-enhanced",
    label: "MiniMax 搜索增强",
    group: "search",
    description: "填一次 Token，即可启用 MiniMax 的网页搜索和图片理解增强。",
    docsUrl: "https://platform.minimaxi.com/docs/token-plan/mcp-guide",
    transport: "stdio",
    config: {
      transport: "stdio",
      command: "uvx",
      args: ["minimax-coding-plan-mcp", "-y"],
      env: {
        MINIMAX_API_KEY: "${token}",
        MINIMAX_API_HOST: "https://api.minimaxi.com",
        MINIMAX_API_RESOURCE_MODE: "url",
      },
    },
    credentialFields: [
      {
        key: "token",
        label: "Token",
        placeholder: "sk-xxx",
        secret: true,
      },
    ],
    hint: "需先安装 uv / uvx。启用后会同时提供 web_search 和 understand_image 两个增强工具。",
  },
  "zhipu-search": {
    name: "zhipu-search",
    label: "智谱联网搜索增强",
    group: "search",
    description: "填一次 Z_AI_API_KEY，即可启用智谱专属联网搜索 MCP。",
    docsUrl: "https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server",
    transport: "http",
    config: {
      transport: "http",
      url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      headers: {
        Authorization: "Bearer ${token}",
      },
    },
    credentialFields: [
      {
        key: "token",
        label: "Z_AI_API_KEY",
        placeholder: "sk-xxx",
        secret: true,
      },
    ],
    hint: "GLM Coding Plan 用户专享。适合需要更强实时检索、技术资料搜索时启用。",
  },
  "zhipu-reader": {
    name: "zhipu-reader",
    label: "智谱网页读取增强",
    group: "search",
    description: "填一次 Z_AI_API_KEY，即可启用网页正文读取与结构化提取。",
    docsUrl: "https://docs.bigmodel.cn/cn/coding-plan/mcp/reader-mcp-server",
    transport: "http",
    config: {
      transport: "http",
      url: "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
      headers: {
        Authorization: "Bearer ${token}",
      },
    },
    credentialFields: [
      {
        key: "token",
        label: "Z_AI_API_KEY",
        placeholder: "sk-xxx",
        secret: true,
      },
    ],
    hint: "GLM Coding Plan 用户专享。适合长网页深读、正文提取、调研资料清洗。",
  },
  "zhipu-zread": {
    name: "zhipu-zread",
    label: "智谱开源仓库增强",
    group: "search",
    description: "填一次 Z_AI_API_KEY，即可启用开源仓库搜索与仓库内容读取。",
    docsUrl: "https://docs.bigmodel.cn/cn/coding-plan/mcp/zread-mcp-server",
    transport: "http",
    config: {
      transport: "http",
      url: "https://open.bigmodel.cn/api/mcp/zread/mcp",
      headers: {
        Authorization: "Bearer ${token}",
      },
    },
    credentialFields: [
      {
        key: "token",
        label: "Z_AI_API_KEY",
        placeholder: "sk-xxx",
        secret: true,
      },
    ],
    hint: "GLM Coding Plan 用户专享。适合代码库问答、开源项目结构理解和资料检索。",
  },
  "zhipu-vision": {
    name: "zhipu-vision",
    label: "智谱视觉增强",
    group: "vision",
    description: "填一次 Z_AI_API_KEY，即可启用截图诊断、OCR、图表与界面理解增强。",
    docsUrl: "https://docs.bigmodel.cn/cn/coding-plan/mcp/vision-mcp-server",
    transport: "stdio",
    config: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@z_ai/mcp-server"],
      env: {
        Z_AI_API_KEY: "${token}",
        Z_AI_MODE: "ZHIPU",
      },
    },
    credentialFields: [
      {
        key: "token",
        label: "Z_AI_API_KEY",
        placeholder: "sk-xxx",
        secret: true,
      },
    ],
    hint: "GLM Coding Plan 用户专享。需本机安装 Node.js 18+ 与 npx，适合截图报错、UI 对比、OCR 和图表分析。",
  },
};

export const MCP_DISCOVERY_PATHS = [
  ".cursor/mcp.json",
  ".codex/mcp.json",
  ".vscode/mcp.json",
  "claude_desktop_config.json",
];
