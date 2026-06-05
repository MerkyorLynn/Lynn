// Brain v2 · Generic OpenAI-compat wire adapter
// 用于 DeepSeek (V4-flash / V4-pro) / GLM / Kimi / 大部分云模型
// F11 fix (2026-05-23): reasoning_effort 透传 (server.js 把它抽到独立 arg,这里 inject 回 body)
//   OpenAI 标准字段,DeepSeek/GLM/Kimi 都原生支持
// F12 fix (2026-05-27): reasoningEffort='auto'/null 时智能 detect thinking on/off
//   + max_tokens 动态调整(短答 512 / 长think 4096)。避免 default_thinking=false provider
//   被 ThinkingLevelButton 'auto' 一刀切打开 thinking。
import { parseOpenAISSE } from './_sse-parser.js';
import type { ChatMessage, ModelId, StreamChunk, ToolDefinition, WireAdapterOptions } from '../types.js';

// F12: 智能判断是否需要 thinking
// - 短问候/单一指令/简单查询 → false (节省 token + 降延迟)
// - 包含推理关键词 / 长问题(>80 字)→ true (深度思考)
function shouldAutoThink(messages?: ChatMessage[]): boolean {
  const last = messages?.[messages.length - 1];
  if (!last) return false;
  let text = '';
  if (typeof last.content === 'string') {
    text = last.content;
  } else if (Array.isArray(last.content)) {
    text = (last.content as Array<{ type?: string; text?: string }>)
      .map((c) => (typeof c?.text === 'string' ? c.text : ''))
      .join('');
  }
  text = (text || '').trim();
  if (!text) return false;
  // 简单问候/确认 → 不开
  if (/^(你好|您好|hi|hello|hey|嗨|早|早上好|晚安|谢谢|好的|是的|嗯|ok|okay)[!,。.?? ]*$/i.test(text)) {
    return false;
  }
  // 包含明确思考关键词 → 开
  if (/(为什么|如何|分析|推理|证明|计算|步骤|规划|设计|方案|对比|评估|论述|解释|思考|拆解|策略|架构|逻辑)/.test(text)) {
    return true;
  }
  // 数学/代码/算法/实现 → 开
  if (/(算法|代码|函数|实现|class |function |def |implement|算一下|求解|公式|方程|架构|系统|设计一个|写一个)/i.test(text)) {
    return true;
  }
  // 短问题(<30 字)→ 不开
  if (text.length < 30) return false;
  // 中长问题(>80 字)→ 开
  return text.length > 80;
}

type OpenAICompatRequestBody = Record<string, unknown> & {
  model: ModelId;
  messages?: ChatMessage[];
  max_tokens: number;
  temperature: number;
  stream: boolean;
  stream_options?: Record<string, unknown>;
  reasoning_effort?: string | null;
  chat_template_kwargs?: Record<string, unknown>;
  tools?: ToolDefinition[];
  tool_choice?: 'auto';
};

function shouldForwardReasoningEffort(provider: WireAdapterOptions['provider'], reasoningEffort?: string | null): boolean {
  if (!reasoningEffort) return false;
  if (provider.thinking_control === 'qwen_chat_template') return true;
  return reasoningEffort !== 'auto'
    && reasoningEffort !== 'off'
    && reasoningEffort !== 'none'
    && reasoningEffort !== 'disabled';
}

export async function* call({ provider, messages, tools, signal, extraBody, reasoningEffort }: WireAdapterOptions): AsyncGenerator<StreamChunk> {
  const effectiveReasoningEffort =
    provider.default_reasoning_effort && (!reasoningEffort || reasoningEffort === 'auto')
      ? provider.default_reasoning_effort
      : reasoningEffort;
  const body: OpenAICompatRequestBody = {
    model: provider.model,
    messages,
    max_tokens: provider.max_tokens || 4096,
    temperature: provider.temperature ?? 0.6,
    stream: true,
    stream_options: { include_usage: true },
    ...(extraBody && typeof extraBody === 'object' ? extraBody : {}),
  };
  // F11: reasoning_effort BYOK 透传 — server.js 抽到 arg,extraBody 没的话从 arg 回灌
  if (shouldForwardReasoningEffort(provider, effectiveReasoningEffort) && !body.reasoning_effort) {
    body.reasoning_effort = effectiveReasoningEffort;
  }
  // 2026-05-25: provider.default_thinking === false 时(例如 apex-spark Brain v2 fallback),
  // 默认关 thinking。避免短 max_tokens 工况下 35B 长 reasoning 吃光
  // 预算返回空 content。client 通过 reasoning_effort('low'/'medium'/'high'/'on')显式
  // opt-in,或 extraBody.chat_template_kwargs.enable_thinking 直接覆盖。
  if (provider.default_thinking === false
      && provider.thinking_control === 'qwen_chat_template'
      && body?.chat_template_kwargs?.enable_thinking === undefined) {
    // F12: 'auto' or null → 智能 detect (短答 off / 长 think on)
    // 显式 'high'/'xhigh'/'on'/'medium'/'low' → 强制 on
    // 'off'/'none'/'disabled' → 强制 off
    let wantsThinking: boolean;
    if (!effectiveReasoningEffort || effectiveReasoningEffort === 'auto') {
      wantsThinking = shouldAutoThink(messages);
    } else if (effectiveReasoningEffort === 'off' || effectiveReasoningEffort === 'none' || effectiveReasoningEffort === 'disabled') {
      wantsThinking = false;
    } else {
      wantsThinking = true;
    }
    const chatTemplateKwargs = body.chat_template_kwargs && typeof body.chat_template_kwargs === 'object'
      ? body.chat_template_kwargs
      : {};
    body.chat_template_kwargs = {
      ...chatTemplateKwargs,
      enable_thinking: wantsThinking,
    };
    // F12: 智能 max_tokens — 短答 512 节省;长 think 维持 provider.max_tokens || 4096
    // 用户/extraBody 显式传 max_tokens 时不覆盖(已在初始 body 里设过了,这里只在 default 情况下调小)
    const userOverridesMaxTokens = (extraBody && typeof extraBody === 'object' && 'max_tokens' in (extraBody as object));
    if (!wantsThinking && !userOverridesMaxTokens) {
      body.max_tokens = 512;
    }
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const resp = await fetch(provider.endpoint + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + provider.apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(provider.id + ' HTTP ' + resp.status + ' ' + errText.slice(0, 200));
  }
  yield* parseOpenAISSE(resp.body);
}

export const wireMeta = {
  id: 'openai-compat',
  desc: 'Generic OpenAI-compatible (DeepSeek / GLM / Kimi / etc.)',
};
