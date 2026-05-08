// Brain v2 · Generic OpenAI-compat wire adapter
// 用于 DeepSeek (V4-flash / V4-pro) / GLM / Kimi / 大部分云模型
import { parseOpenAISSE } from './_sse-parser.js';

export async function* call({ provider, messages, tools, signal, log, extraBody }) {
  const body = {
    model: provider.model,
    messages,
    max_tokens: provider.max_tokens || 4096,
    temperature: provider.temperature ?? 0.6,
    stream: true,
    ...(extraBody && typeof extraBody === 'object' ? extraBody : {}),
  };
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
