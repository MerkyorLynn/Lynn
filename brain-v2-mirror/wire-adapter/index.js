// Brain v2 · wire-adapter dispatch
// 原则:provider.wire string → adapter call function
import { call as callMimo, wireMeta as mimoMeta } from './mimo.js';
import { call as callSGLang, wireMeta as sglangMeta } from './sglang.js';
import { call as callOpenAI, wireMeta as openaiMeta } from './openai-compat.js';

export const ADAPTERS = {
  mimo: callMimo,
  sglang: callSGLang,
  openai: callOpenAI,
  'openai-compat': callOpenAI,
};

export const WIRE_META = {
  mimo: mimoMeta,
  sglang: sglangMeta,
  openai: openaiMeta,
};

export function getAdapter(wireName) {
  return ADAPTERS[wireName] || ADAPTERS.openai;
}

export { parseOpenAISSE } from './_sse-parser.js';
