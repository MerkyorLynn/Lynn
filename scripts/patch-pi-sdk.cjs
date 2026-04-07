/**
 * patch-pi-sdk.cjs — postinstall 补丁
 *
 * 修复 Pi SDK createAgentSession() 没有把 options.tools 作为
 * baseToolsOverride 传给 AgentSession 的问题。
 *
 * AgentSession 本身支持 baseToolsOverride，但 createAgentSession()
 * 只取了 tool name 列表，丢弃了实际的 tool 对象，导致 session
 * 回退到 SDK 内置默认工具。Windows 上内置 bash 工具找不到 shell，
 * 所有命令返回 exit code 1 + 空输出。
 *
 * See: https://github.com/anthropics/openhanako/issues/221
 */

const fs = require("fs");
const path = require("path");

const target = path.join(
  __dirname, "..",
  "node_modules", "@mariozechner", "pi-coding-agent",
  "dist", "core", "sdk.js"
);

if (!fs.existsSync(target)) {
  console.log("[patch-pi-sdk] sdk.js not found, skipping");
  process.exit(0);
}

let code = fs.readFileSync(target, "utf8");

if (code.includes('import { streamSimple } from "@mariozechner/pi-ai";')) {
  console.log("[patch-pi-sdk] sdk.js import patch already applied");
} else if (code.includes('import { Agent } from "@mariozechner/pi-agent-core";')) {
  code = code.replace(
    'import { Agent } from "@mariozechner/pi-agent-core";',
    'import { Agent } from "@mariozechner/pi-agent-core";\nimport { streamSimple } from "@mariozechner/pi-ai";'
  );
  console.log("[patch-pi-sdk] patched sdk.js → imported streamSimple for request header passthrough");
} else {
  console.warn("[patch-pi-sdk] sdk.js structure changed, cannot apply import patch");
}

if (code.includes("baseToolsOverride")) {
  console.log("[patch-pi-sdk] sdk.js already patched, skipping patch 1");
} else {
  const needle = "        initialActiveToolNames,\n        extensionRunnerRef,";
  const replacement =
    "        initialActiveToolNames,\n" +
    "        baseToolsOverride: options.tools\n" +
    "            ? Object.fromEntries(options.tools.map(t => [t.name, t]))\n" +
    "            : undefined,\n" +
    "        extensionRunnerRef,";

  if (!code.includes(needle)) {
    console.warn(
      "[patch-pi-sdk] sdk.js structure changed, cannot apply patch 1 " +
      "— custom bash tools may not work on Windows"
    );
  } else {
    code = code.replace(needle, replacement);
    console.log("[patch-pi-sdk] patched createAgentSession → baseToolsOverride wired through");
  }
}

if (code.includes("streamFn: (options.requestHeaders || options.requestMetadata)")) {
  console.log("[patch-pi-sdk] sdk.js request header passthrough already applied");
} else {
  const requestNeedle =
    "        transport: settingsManager.getTransport(),\n" +
    "        thinkingBudgets: settingsManager.getThinkingBudgets(),\n" +
    "        maxRetryDelayMs: settingsManager.getRetrySettings().maxDelayMs,";
  const requestReplacement =
    "        transport: settingsManager.getTransport(),\n" +
    "        streamFn: (options.requestHeaders || options.requestMetadata)\n" +
    "            ? (model, context, streamOptions) => streamSimple(model, context, {\n" +
    "                ...streamOptions,\n" +
    "                headers: {\n" +
    "                    ...(streamOptions?.headers || {}),\n" +
    "                    ...(options.requestHeaders || {}),\n" +
    "                },\n" +
    "                metadata: {\n" +
    "                    ...(streamOptions?.metadata || {}),\n" +
    "                    ...(options.requestMetadata || {}),\n" +
    "                },\n" +
    "            })\n" +
    "            : undefined,\n" +
    "        thinkingBudgets: settingsManager.getThinkingBudgets(),\n" +
    "        maxRetryDelayMs: settingsManager.getRetrySettings().maxDelayMs,";

  if (!code.includes(requestNeedle)) {
    console.warn("[patch-pi-sdk] sdk.js structure changed, cannot apply request header passthrough patch");
  } else {
    code = code.replace(requestNeedle, requestReplacement);
    console.log("[patch-pi-sdk] patched sdk.js → request headers/metadata flow into Pi providers");
  }
}

fs.writeFileSync(target, code, "utf8");

// ── Patch 2: pi-ai openai-completions.js ──
// dashscope/volcengine 等 API 不接受 tools: []（空数组返回 400）。
// Pi SDK 在对话历史有 tool_calls 但当前 turn 无工具时发 tools: []，
// 这是为了兼容 Anthropic proxy，但对其他 API 有害。
// 另外，智谱 / GLM reasoning 模型要求 `thinking: { type: "enabled|disabled" }`，
// 不能误发成 Qwen 风格的 `enable_thinking`。
const completionsTarget = path.join(
  __dirname, "..",
  "node_modules", "@mariozechner", "pi-ai",
  "dist", "providers", "openai-completions.js"
);

if (fs.existsSync(completionsTarget)) {
  let completionsCode = fs.readFileSync(completionsTarget, "utf8");

  if (completionsCode.includes("/* patched: strip empty tools */")) {
    console.log("[patch-pi-sdk] openai-completions.js empty-tools patch already applied");
  } else {
    // 在 tools: [] 赋值之后，tool_choice 赋值之前，插入清理逻辑
    const toolsNeedle = '        params.tools = [];\n    }\n    if (options?.toolChoice) {';
    const toolsReplacement =
      '        params.tools = [];\n    }\n' +
      '    /* patched: strip empty tools */\n' +
      '    if (Array.isArray(params.tools) && params.tools.length === 0) {\n' +
      '        delete params.tools;\n' +
      '    }\n' +
      '    if (options?.toolChoice) {';

    if (completionsCode.includes(toolsNeedle)) {
      completionsCode = completionsCode.replace(toolsNeedle, toolsReplacement);
      console.log("[patch-pi-sdk] patched openai-completions.js → strip empty tools array");
    } else {
      console.warn("[patch-pi-sdk] openai-completions.js structure changed, cannot apply empty-tools patch");
    }
  }

  const thinkingNeedle =
    '    if ((compat.thinkingFormat === "zai" || compat.thinkingFormat === "qwen") && model.reasoning) {\n' +
    '        // Both Z.ai and Qwen use enable_thinking: boolean\n' +
    '        params.enable_thinking = !!options?.reasoningEffort;\n' +
    '    }\n' +
    '    else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {';
  const legacyThinkingNeedle =
    '    /* patched: zai-thinking-format */\n' +
    '    if (compat.thinkingFormat === "zai" && model.reasoning) {\n' +
    '        params.thinking = { type: options?.reasoningEffort ? "enabled" : "disabled" };\n' +
    '    }\n' +
    '    else if (compat.thinkingFormat === "qwen" && model.reasoning) {\n' +
    '        params.enable_thinking = !!options?.reasoningEffort;\n' +
    '    }\n' +
    '    else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {';
  // 另一种旧格式：无条件 disabled
  const legacyThinkingNeedle2 =
    '    /* patched: zai-thinking-format */\n' +
    '    if (compat.thinkingFormat === "zai" && model.reasoning) {\n' +
    '        params.thinking = { type: "disabled" };\n' +
    '    }\n' +
    '    else if (compat.thinkingFormat === "qwen" && model.reasoning) {\n' +
    '        params.enable_thinking = !!options?.reasoningEffort;\n' +
    '    }\n' +
    '    else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {';
  const thinkingReplacement =
    '    /* patched: zai-thinking-format */\n' +
    '    if (compat.thinkingFormat === "zai" && model.reasoning) {\n' +
    '        if (options?.reasoningEffort) {\n' +
    '            params.thinking = { type: "enabled" };\n' +
    '        }\n' +
    '        // reasoningEffort 为空时不发 thinking 参数，避免智谱 API 返回空响应\n' +
    '    }\n' +
    '    else if (compat.thinkingFormat === "qwen" && model.reasoning) {\n' +
    '        params.enable_thinking = !!options?.reasoningEffort;\n' +
    '    }\n' +
    '    else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {';

  if (completionsCode.includes(legacyThinkingNeedle)) {
    completionsCode = completionsCode.replace(legacyThinkingNeedle, thinkingReplacement);
    console.log("[patch-pi-sdk] upgraded openai-completions.js legacy zai-thinking patch");
  } else if (completionsCode.includes(legacyThinkingNeedle2)) {
    completionsCode = completionsCode.replace(legacyThinkingNeedle2, thinkingReplacement);
    console.log("[patch-pi-sdk] upgraded openai-completions.js legacy2 zai-thinking patch");
  } else if (completionsCode.includes(thinkingNeedle)) {
    completionsCode = completionsCode.replace(thinkingNeedle, thinkingReplacement);
    console.log("[patch-pi-sdk] patched openai-completions.js → use zai thinking payload for GLM");
  } else if (completionsCode.includes('if (options?.reasoningEffort) {\n            params.thinking = { type: "enabled" }')) {
    console.log("[patch-pi-sdk] openai-completions.js zai-thinking patch already applied");
  } else {
    console.warn("[patch-pi-sdk] openai-completions.js structure changed, cannot apply zai-thinking patch");
  }

  fs.writeFileSync(completionsTarget, completionsCode, "utf8");
} else {
  console.log("[patch-pi-sdk] openai-completions.js not found, skipping");
}
