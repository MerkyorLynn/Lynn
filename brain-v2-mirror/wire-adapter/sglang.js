// Brain v2 · SGLang wire adapter
// Qwen3.6-A3B-FP8 + qwen3_coder parser native tool_calls + reasoning_content
// 关键:enable_thinking 永远 true(brain 不替模型决定要不要 thinking)
import { parseOpenAISSE } from './_sse-parser.js';

export async function* call({ provider, messages, tools, signal, log, extraBody }) {
  const body = {
    model: provider.model,
    messages,
    max_tokens: 32000,
    temperature: 0.4,
    stream: true,
    ...(extraBody && typeof extraBody === 'object' ? extraBody : {}),
    chat_template_kwargs: { enable_thinking: true },
  };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const resp = await fetch(provider.endpoint + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (provider.apiKey || 'none'),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error('sglang HTTP ' + resp.status + ' ' + errText.slice(0, 200));
  }
  yield* parseOpenAISSE(resp.body);
}

export const wireMeta = {
  id: 'sglang',
  desc: 'SGLang Qwen3.6-A3B FP8 with reasoning_content + native tool_calls',
};
