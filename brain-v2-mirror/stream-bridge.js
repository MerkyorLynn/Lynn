// Brain v2 · stream-bridge
// 把 router emit 的标准 Chunk 转成 OpenAI compat SSE
// 也支持 Lynn 客户端 ws 协议(如果未来需要)
//
// Chunk 类型:
//   { type: 'reasoning', delta: string }
//   { type: 'content',   delta: string }
//   { type: 'tool_call_delta', delta: Array<{index, id?, function?: {name?, arguments?}}> }
//   { type: 'finish',    reason: string }

export function makeSSEEmitter(res, { id, model = 'lynn-v2' } = {}) {
  const created = Math.floor(Date.now() / 1000);
  let currentModel = model;
  let writableEnded = false;

  function write(payload) {
    if (writableEnded) return;
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  }

  // OpenAI compat first chunk: role=assistant
  function emitRole() {
    write({
      id, object: 'chat.completion.chunk', created, model: currentModel,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
  }

  function emitChunk(chunk, meta = {}) {
    if (meta.providerId) currentModel = meta.providerId;
    if (chunk.type === 'reasoning') {
      write({
        id, object: 'chat.completion.chunk', created, model: currentModel,
        choices: [{ index: 0, delta: { reasoning_content: chunk.delta }, finish_reason: null }],
      });
    } else if (chunk.type === 'content') {
      write({
        id, object: 'chat.completion.chunk', created, model: currentModel,
        choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null }],
      });
    } else if (chunk.type === 'tool_call_delta') {
      write({
        id, object: 'chat.completion.chunk', created, model: currentModel,
        choices: [{ index: 0, delta: { tool_calls: chunk.delta }, finish_reason: null }],
      });
    } else if (chunk.type === 'finish') {
      write({
        id, object: 'chat.completion.chunk', created, model: currentModel,
        choices: [{ index: 0, delta: {}, finish_reason: chunk.reason || 'stop' }],
      });
    }
  }

  function emitError(message, errors = null) {
    write({ error: message, errors });
  }

  function done() {
    if (writableEnded) return;
    res.write('data: [DONE]\n\n');
    res.end();
    writableEnded = true;
  }

  return { emitRole, emitChunk, emitError, done };
}
