// Brain v2 · SGLang wire adapter
// Qwen3.6-A3B-FP8 + qwen3_coder parser native tool_calls + reasoning_content
// 关键:默认 no-think, caller 可显式 opt-in；避免把 thinking 过程泄漏成可见回复。
import { parseOpenAISSE } from './_sse-parser.js';

export async function* call({ provider, messages, tools, signal, log, extraBody }) {
  const {
    chat_template_kwargs: callerTemplateKwargs,
    ...restExtraBody
  } = extraBody && typeof extraBody === 'object' ? extraBody : {};
  const templateKwargs = callerTemplateKwargs && typeof callerTemplateKwargs === 'object'
    ? callerTemplateKwargs
    : {};
  const body = {
    model: provider.model,
    messages,
    max_tokens: 32000,
    temperature: 0.4,
    stream: true,
    ...restExtraBody,
    chat_template_kwargs: {
      ...templateKwargs,
      enable_thinking: templateKwargs.enable_thinking ?? false,
    },
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
