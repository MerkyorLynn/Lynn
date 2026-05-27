// Brain v2 · MiMo wire adapter
// enable_search:true 内置 web search(memory feedback_mimo_token_plan.md)
// F10 fix (2026-05-23): reasoning_effort 全档位都翻译到 MiMo thinking schema,不再 silently drop
//   - low/minimal/off/none → { type: 'disabled' }
//   - medium/high/xhigh    → { type: 'enabled' }  (MiMo server default budget)
//   - undefined/其他       → 不动 body.thinking,由 extraBody 或 server default 决定
//   BYOK-equality:caller 显式 thinking via extraBody 总是 win(在 spread 之后我们才 set)
//
// 2026-05-27 multimodal: messages 含 image/audio content 时自动切到 mimo-v2.5(或
// MIMO_MULTIMODAL_MODEL env 指定的变体如 mimo-v2-omni)。纯文本仍走 provider.model
// 配置的 mimo-v2.5-pro(chat-optimized)。MiMo 文档:
//   - https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/multimodal-understanding/image-understanding
//   - https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/multimodal-understanding/audio-understanding
import { parseOpenAISSE } from './_sse-parser.js';
import type { ChatMessage, ModelId, StreamChunk, ToolDefinition, WireAdapterOptions } from '../types.js';

type MimoThinking = { type: 'disabled' | 'enabled' };
type MimoRequestBody = Record<string, unknown> & {
  model: ModelId;
  messages?: ChatMessage[];
  enable_search: boolean;
  max_completion_tokens: number;
  temperature: number;
  stream: boolean;
  reasoning_effort?: string | null;
  thinking?: MimoThinking;
  tools?: ToolDefinition[];
  tool_choice?: 'auto';
};

function reasoningEffortToMimoThinking(effort?: string | null): MimoThinking {
  // 用户拍板 2026-05-23: caller 不显式传 → 默认 'xhigh'(MiMo thinking 全开)
  const v = String(effort || 'xhigh').toLowerCase();
  if (v === 'low' || v === 'minimal' || v === 'off' || v === 'none') return { type: 'disabled' };
  // medium / high / xhigh / max / 任何未知值 → enabled
  return { type: 'enabled' };
}

// 多模态 content part 识别。OpenAI 标准 + MiMo 兼容:
//   image: { type: 'image_url' | 'input_image', ... }
//   audio: { type: 'input_audio' | 'audio_url', ... }
function hasMultimodalContent(messages?: ChatMessage[]): boolean {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    const c = m?.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (!part || typeof part !== 'object') continue;
      const typedPart = part as { type?: string };
      const t = typedPart.type;
      if (t === 'image_url' || t === 'input_image') return true;
      if (t === 'input_audio' || t === 'audio_url') return true;
    }
  }
  return false;
}

function pickModel(provider: { model: ModelId }, messages?: ChatMessage[]): ModelId {
  if (!hasMultimodalContent(messages)) return provider.model;
  // Multimodal:env 可以指定 mimo-v2-omni;默认 mimo-v2.5
  const mm = (process.env.MIMO_MULTIMODAL_MODEL || 'mimo-v2.5') as ModelId;
  return mm;
}

export async function* call({ provider, messages, tools, signal, extraBody, reasoningEffort }: WireAdapterOptions): AsyncGenerator<StreamChunk> {
  // 多模态自动切 model:image/audio content → mimo-v2.5(或 MIMO_MULTIMODAL_MODEL)
  // 纯文本走 provider.model 配置的 mimo-v2.5-pro
  const selectedModel = pickModel(provider, messages);
  const body: MimoRequestBody = {
    model: selectedModel,
    messages,
    enable_search: true,
    max_completion_tokens: 32768,
    temperature: 0.6,
    stream: true,
    // extraBody spread 末尾 = 客户端可 override
    ...(extraBody && typeof extraBody === 'object' ? extraBody : {}),
  };
  // reasoning_effort 翻译:Lynn ThinkingLevelButton 通过 reasoningEffort 参数传入
  // F10: 也认 extraBody.reasoning_effort,不让 caller intent silently drop
  // 优先级:caller 显式 body.thinking > reasoningEffort 参数 > extraBody.reasoning_effort
  const effortSource = reasoningEffort || body.reasoning_effort;
  const translatedThinking = reasoningEffortToMimoThinking(effortSource);
  if (translatedThinking && !body.thinking) body.thinking = translatedThinking;
  // MiMo 不识别 OpenAI 标准 reasoning_effort 字段,删除避免 400(翻译已上抬到 thinking)
  delete body.reasoning_effort;

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
    throw new Error('mimo HTTP ' + resp.status + ' ' + errText.slice(0, 200));
  }
  yield* parseOpenAISSE(resp.body);
}

export const wireMeta = {
  id: 'mimo',
  desc: 'MiMo with native enable_search:true (xiaomimimo.com token-plan)',
};

// for tests
export const __testing__ = { reasoningEffortToMimoThinking, hasMultimodalContent, pickModel };
