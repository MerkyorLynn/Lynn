// Brain v2 · Shared OpenAI-compat SSE parser
// 原则:wire-format 事实层(SSE chunk → 标准 Chunk),不做内容判断
//
// 标准 Chunk:
//   { type: 'reasoning', delta: string }
//   { type: 'content',   delta: string }
//   { type: 'tool_call_delta', delta: Array<{index, id?, function?: {name?, arguments?}}> }
//   { type: 'finish',    reason: string }

export async function* parseOpenAISSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      const choice = parsed.choices && parsed.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      // reasoning_content (thinking 模型) — 兼容多种字段名
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning != null && reasoning !== '') {
        yield { type: 'reasoning', delta: String(reasoning) };
      }
      if (delta.content != null && delta.content !== '') {
        yield { type: 'content', delta: String(delta.content) };
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        yield { type: 'tool_call_delta', delta: delta.tool_calls };
      }
      if (choice.finish_reason) {
        yield { type: 'finish', reason: choice.finish_reason };
      }
    }
  }
}
