// Brain v2 · MiMo wire adapter
// enable_search:true 内置 web search(memory feedback_mimo_token_plan.md)
// v0.77.7:
//   - extraBody 透传(OpenAI 标准),客户端可传 thinking:{type:"disabled"} 关思考
//   - reasoning_effort: low/minimal/off → 自动翻译成 MiMo 的 thinking:{type:"disabled"}
//     (MiMo 不识别 OpenAI 标准 reasoning_effort 字段,Lynn ThinkingLevelButton 'off' 走这条路径)
import { parseOpenAISSE } from './_sse-parser.js';

function reasoningEffortToMimoThinking(effort) {
  if (!effort) return undefined;
  const v = String(effort).toLowerCase();
  if (v === 'low' || v === 'minimal' || v === 'off' || v === 'none') return { type: 'disabled' };
  return undefined;
}

export async function* call({ provider, messages, tools, signal, log, extraBody, reasoningEffort }) {
  const body = {
    model: provider.model,
    messages,
    enable_search: true,
    max_completion_tokens: 32768,
    temperature: 0.6,
    stream: true,
    // extraBody spread 末尾 = 客户端可 override
    ...(extraBody && typeof extraBody === 'object' ? extraBody : {}),
  };
  // reasoning_effort 翻译:Lynn ThinkingLevelButton 'off' → low → MiMo thinking:{type:disabled}
  // 注意:此翻译在 extraBody spread 后,如果客户端显式传 thinking 字段会被这里 override
  const translatedThinking = reasoningEffortToMimoThinking(reasoningEffort);
  if (translatedThinking && !body.thinking) body.thinking = translatedThinking;
  // MiMo 不识别 OpenAI 标准 reasoning_effort 字段,删除避免 400
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
export const __testing__ = { reasoningEffortToMimoThinking };
