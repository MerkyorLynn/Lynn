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

  // ── Patch 3: Brain provider tolerant adapter ──
  // Brain 云端在部分链路下的 SSE 收尾不够标准，OpenAI SDK 严格流解析器
  // 会把已有内容消费成空消息。默认模型改为非流式兼容请求，再转回
  // Pi 的 AssistantMessageEventStream；其他供应商仍走原始流式路径。
  if (completionsCode.includes("function streamBrainTolerantOpenAICompletions")) {
    console.log("[patch-pi-sdk] openai-completions.js brain tolerant adapter already applied");
  } else {
    const helperNeedle = "export const streamOpenAICompletions = (model, context, options) => {\n";
    const helperCode =
`function streamBrainTolerantOpenAICompletions(model, context, options) {
    const stream = new AssistantMessageEventStream();
    (async () => {
        const output = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
        };
        const blockIndex = () => output.content.length - 1;
        const pushText = (text) => {
            const value = typeof text === "string" ? text : "";
            if (!value)
                return;
            const block = { type: "text", text: value };
            output.content.push(block);
            stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
            stream.push({ type: "text_delta", contentIndex: blockIndex(), delta: value, partial: output });
            stream.push({ type: "text_end", contentIndex: blockIndex(), content: value, partial: output });
        };
        const pushToolCall = (toolCall) => {
            const fn = toolCall?.function || {};
            const id = toolCall?.id || \`call_\${Math.random().toString(36).slice(2)}\`;
            const rawArgs = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {});
            const block = {
                type: "toolCall",
                id,
                name: fn.name || "",
                arguments: parseStreamingJson(rawArgs),
            };
            output.content.push(block);
            stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
            stream.push({ type: "toolcall_delta", contentIndex: blockIndex(), delta: rawArgs, partial: output });
            stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall: block, partial: output });
        };
        try {
            const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
            const params = buildParams(model, context, options);
            params.stream = false;
            delete params.stream_options;
            delete params.store;
            if (params.max_completion_tokens && !params.max_tokens) {
                params.max_tokens = params.max_completion_tokens;
                delete params.max_completion_tokens;
            }
            options?.onPayload?.(params);
            const headers = {
                "Content-Type": "application/json",
                ...(model.headers || {}),
                ...(options?.headers || {}),
            };
            if (apiKey && apiKey !== "local")
                headers.Authorization = \`Bearer \${apiKey}\`;
            const base = String(model.baseUrl || "").replace(/\\/+$/, "");
            const response = await fetch(\`\${base}/chat/completions\`, {
                method: "POST",
                headers,
                body: JSON.stringify(params),
                signal: options?.signal,
            });
            const raw = await response.text();
            let data = {};
            try {
                data = raw ? JSON.parse(raw) : {};
            }
            catch {
                throw new Error(raw.slice(0, 500) || \`Brain response is not JSON (\${response.status})\`);
            }
            if (!response.ok) {
                throw new Error(data?.error?.message || data?.error || \`Brain \${response.status}\`);
            }
            const choice = data.choices?.[0] || {};
            const message = choice.message || {};
            stream.push({ type: "start", partial: output });
            if (data.usage) {
                const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens || 0;
                const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens || 0;
                const input = (data.usage.prompt_tokens || 0) - cachedTokens;
                const outputTokens = (data.usage.completion_tokens || 0) + reasoningTokens;
                output.usage = {
                    input,
                    output: outputTokens,
                    cacheRead: cachedTokens,
                    cacheWrite: 0,
                    totalTokens: input + outputTokens + cachedTokens,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                };
                calculateCost(model, output.usage);
            }
            if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                output.stopReason = "toolUse";
                for (const toolCall of message.tool_calls)
                    pushToolCall(toolCall);
            }
            else {
                output.stopReason = mapStopReason(choice.finish_reason || "stop");
                const content = Array.isArray(message.content)
                    ? message.content.map((part) => typeof part === "string" ? part : (part?.text || "")).join("")
                    : (message.content || "");
                pushText(content);
            }
            stream.push({ type: "done", reason: output.stopReason, message: output });
            stream.end();
        }
        catch (error) {
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
            stream.push({ type: "error", reason: output.stopReason, error: output });
            stream.end();
        }
    })();
    return stream;
}

`;

    if (completionsCode.includes(helperNeedle)) {
      completionsCode = completionsCode.replace(helperNeedle, helperCode + helperNeedle);
      console.log("[patch-pi-sdk] patched openai-completions.js → Brain tolerant adapter helper");
    } else {
      console.warn("[patch-pi-sdk] openai-completions.js structure changed, cannot insert Brain tolerant helper");
    }
  }

  const brainBranchNeedle = "export const streamOpenAICompletions = (model, context, options) => {\n";
  const brainBranchReplacement =
    "export const streamOpenAICompletions = (model, context, options) => {\n" +
    "    if (model.provider === \"brain\" || String(model.baseUrl || \"\").includes(\"api.merkyorlynn.com\")) {\n" +
    "        return streamBrainTolerantOpenAICompletions(model, context, options);\n" +
    "    }\n";
  if (completionsCode.includes("return streamBrainTolerantOpenAICompletions(model, context, options);")) {
    console.log("[patch-pi-sdk] openai-completions.js brain tolerant branch already applied");
  } else if (completionsCode.includes(brainBranchNeedle)) {
    completionsCode = completionsCode.replace(brainBranchNeedle, brainBranchReplacement);
    console.log("[patch-pi-sdk] patched openai-completions.js → route Brain through tolerant adapter");
  } else {
    console.warn("[patch-pi-sdk] openai-completions.js structure changed, cannot insert Brain tolerant branch");
  }

  fs.writeFileSync(completionsTarget, completionsCode, "utf8");
} else {
  console.log("[patch-pi-sdk] openai-completions.js not found, skipping");
}
