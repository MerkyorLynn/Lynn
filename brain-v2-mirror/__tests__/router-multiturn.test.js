// Brain v2 · Router multi-turn server-side tool execution tests
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  cooldown: new Set(),
  providers: {},
  adapterFn: null,
  adapterCalls: 0,
}));

vi.mock('../provider-registry.js', () => ({
  universalOrder: ['p-mimo', 'p-spark'],
  getProvider: (id) => mockState.providers[id] || null,
  isInCooldown: (id) => mockState.cooldown.has(id),
  markUnhealthy: (id) => mockState.cooldown.add(id),
  clearUnhealthy: (id) => mockState.cooldown.delete(id),
  PROVIDERS: mockState.providers,
}));

vi.mock('../wire-adapter/index.js', () => ({
  getAdapter: () => mockState.adapterFn,
  ADAPTERS: {},
}));

vi.mock('../tool-exec/index.js', () => ({
  isServerTool: (name) => name === 'web_search',
  executeServerTool: vi.fn(async (name, argsStr) => 'mocked-result-for-' + name + ':' + argsStr),
  mergeWithServerTools: (tools) => {
    const list = Array.isArray(tools) ? [...tools] : [];
    const seen = new Set(list.filter(t => t?.function?.name).map(t => t.function.name));
    if (!seen.has('web_search')) list.push({ type: 'function', function: { name: 'web_search', parameters: {} } });
    return list;
  },
}));

import { run, __testing__ } from '../router.js';

function makeProvider(id) {
  return {
    id, wire: 'mock', endpoint: 'http://mock', apiKey: 'k', model: 'm',
    capability: { vision: false, audio: false, tools: true, thinking: true },
  };
}

beforeEach(() => {
  mockState.cooldown.clear();
  mockState.providers = { 'p-mimo': makeProvider('p-mimo'), 'p-spark': makeProvider('p-spark') };
  mockState.adapterCalls = 0;
  mockState.adapterFn = null;
});

describe('Router multi-turn server-side tool execution', () => {
  it('executes server-side web_search and continues with same provider', async () => {
    let turn = 0;
    mockState.adapterFn = async function* ({ messages }) {
      turn++;
      mockState.adapterCalls++;
      if (turn === 1) {
        // Turn 1: model emits web_search tool_call
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'call-1', function: { name: 'web_search', arguments: '{\"query\":\"weather\"}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        // Turn 2: with tool result in messages, model produces final answer
        // Verify the messages include the assistant tool_calls + tool result
        expect(messages.find(m => m.role === 'tool')).toBeDefined();
        expect(messages.find(m => m.role === 'assistant' && m.tool_calls)).toBeDefined();
        yield { type: 'content', delta: 'final answer' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.iterations).toBe(2);
    expect(mockState.adapterCalls).toBe(2);
    expect(chunks.find(c => c.type === 'content' && c.delta === 'final answer')).toBeDefined();
    // lynn_tool_progress markers emitted
    const markers = chunks.filter(c => c.type === 'content' && c.delta?.includes('lynn_tool_progress')).map(c => c.delta);
    expect(markers.some(m => m.includes('event=\"start\" name=\"web_search\"'))).toBe(true);
    expect(markers.some(m => m.includes('event=\"end\" name=\"web_search\"'))).toBe(true);
  });

  it('forwards client-side tool_calls and stops loop', async () => {
    mockState.adapterFn = async function* () {
      mockState.adapterCalls++;
      yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'call-c', function: { name: 'bash', arguments: '{\"cmd\":\"ls\"}' } }] };
      yield { type: 'finish', reason: 'tool_calls' };
    };
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async () => {},
    });
    expect(result.forwardedToClient).toBe(true);
    expect(result.clientToolCalls).toBe(1);
    expect(mockState.adapterCalls).toBe(1);  // only one round
  });

  it('mixed server+client tool_calls: forward to client (no server exec)', async () => {
    mockState.adapterFn = async function* () {
      mockState.adapterCalls++;
      yield { type: 'tool_call_delta', delta: [
        { index: 0, id: 'srv', function: { name: 'web_search', arguments: '{}' } },
        { index: 1, id: 'cli', function: { name: 'bash', arguments: '{}' } },
      ] };
      yield { type: 'finish', reason: 'tool_calls' };
    };
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async () => {},
    });
    expect(result.forwardedToClient).toBe(true);
    expect(mockState.adapterCalls).toBe(1);
  });

  // [REGRESSION 2026-05-06] 撞 MAX_ITERATIONS 后强合成轮: 不再 silently return,而是 tools=null 再走一轮
  // 让模型基于已有工具结果给最终答案。原 bug: 3 轮全在调 parallel_research,撞顶后模型最后 emit
  // 的 progress 文字 ("继续深挖/需要抓取") 成了 final answer,用户看到的"答非所问"就是这么来的。
  it('forces a synthesis round (tools=null) when iter cap is hit', async () => {
    let lastTools;
    let lastSystemContent;
    mockState.adapterFn = async function* ({ tools, messages }) {
      mockState.adapterCalls++;
      lastTools = tools;
      lastSystemContent = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
      // 6 轮工具调用循环 + 第 7 轮合成: 合成轮 tools=null 模型给文字
      if (mockState.adapterCalls <= 6) {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-' + mockState.adapterCalls, function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield { type: 'content', delta: 'synthesized final answer based on prior tool results' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.hitMaxIterations).toBe(true);
    expect(result.synthesisRound).toBe(true);
    expect(result.iterations).toBe(7);  // 6 工具轮 + 1 合成轮
    expect(mockState.adapterCalls).toBe(7);
    // 合成轮必须 tools=null,且 system 消息要求直接合成用户可见结果
    expect(lastTools).toBeNull();
    expect(lastSystemContent).toContain('资料收集阶段');
    expect(lastSystemContent).toContain('不要提及工具被禁用');
    // 最终内容真的 emit 出来了
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('synthesized final answer'))).toBeDefined();
    // reasoning heartbeat 告诉用户进入合成
    expect(chunks.find(c => c.type === 'reasoning' && c.delta?.includes('已用完') && c.delta?.includes('轮工具调用预算'))).toBeDefined();
  });

  it('injects synthesis instruction into the first system message instead of appending a tail system message', () => {
    const messages = [
      { role: 'system', content: '原始系统约束' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ];
    const next = __testing__.withSynthesisSystemMessage(messages, '合成轮约束');
    expect(next).toHaveLength(3);
    expect(next[0].role).toBe('system');
    expect(next[0].content).toContain('原始系统约束');
    expect(next[0].content).toContain('合成轮约束');
    expect(next.slice(1).some(m => m.role === 'system')).toBe(false);
  });

  it('prepends synthesis instruction when no system message exists', () => {
    const next = __testing__.withSynthesisSystemMessage([{ role: 'user', content: 'q' }], '合成轮约束');
    expect(next[0]).toEqual({ role: 'system', content: '合成轮约束' });
    expect(next[1]).toEqual({ role: 'user', content: 'q' });
  });

  it('falls back gracefully if synthesis round itself fails', async () => {
    mockState.adapterFn = async function* () {
      mockState.adapterCalls++;
      if (mockState.adapterCalls <= 6) {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-' + mockState.adapterCalls, function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        throw new Error('synthesis upstream blew up');
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.hitMaxIterations).toBe(true);
    expect(result.synthesisRound).toBeUndefined();
    expect(result.iterations).toBe(6);
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('工具结果合成失败'))).toBeDefined();
  });

  it('falls through to the next provider when synthesis emits reasoning but no visible content', async () => {
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls++;
      if (mockState.adapterCalls <= 6) {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-' + mockState.adapterCalls, function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else if (provider.id === 'p-mimo') {
        yield { type: 'reasoning', delta: 'still thinking, no answer' };
        yield { type: 'finish', reason: 'stop' };
      } else {
        yield { type: 'content', delta: 'fallback provider synthesized final answer' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.synthesisRound).toBe(true);
    expect(result.providerId).toBe('p-spark');
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('fallback provider synthesized'))).toBeDefined();
    expect(chunks.find(c => c.type === 'finish' && c.reason === 'stop')).toBeDefined();
  });

  it('rejects pseudo tool XML content from synthesis before emitting it', async () => {
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls++;
      if (mockState.adapterCalls <= 6) {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-' + mockState.adapterCalls, function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else if (provider.id === 'p-mimo') {
        yield { type: 'content', delta: '<tool_call>\n<function=create_docx>\n<parameter=title>报告</parameter>' };
        yield { type: 'finish', reason: 'stop' };
      } else {
        yield { type: 'content', delta: 'fallback provider wrote the actual research report' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c) => chunks.push(c),
    });
    const visible = chunks.filter(c => c.type === 'content').map(c => c.delta).join('');
    expect(result.synthesisRound).toBe(true);
    expect(result.providerId).toBe('p-spark');
    expect(visible).not.toContain('<tool_call>');
    expect(visible).not.toContain('create_docx');
    expect(visible).toContain('actual research report');
  });

  it('suppresses hallucinated tool calls from the synthesis round and falls through', async () => {
    mockState.adapterFn = async function* ({ provider }) {
      mockState.adapterCalls++;
      if (mockState.adapterCalls <= 6) {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-' + mockState.adapterCalls, function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else if (provider.id === 'p-mimo') {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'hallucinated', function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield { type: 'content', delta: 'fallback provider synthesized final answer after hallucinated tool call' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.hitMaxIterations).toBe(true);
    expect(result.synthesisRound).toBe(true);
    expect(result.iterations).toBe(7);
    expect(result.providerId).toBe('p-spark');
    const leakedToolCalls = chunks.filter(c => c.type === 'tool_call_delta');
    expect(leakedToolCalls).toHaveLength(6);
    expect(leakedToolCalls.some(c => JSON.stringify(c).includes('hallucinated'))).toBe(false);
    expect(chunks.filter(c => c.type === 'finish' && c.reason === 'tool_calls')).toHaveLength(6);
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('fallback provider synthesized'))).toBeDefined();
    expect(chunks.find(c => c.type === 'finish' && c.reason === 'stop')).toBeDefined();
  });

  it('forces synthesis when a multi-round tool task stops with only short progress narration', async () => {
    let lastTools;
    let lastSystemContent;
    mockState.adapterFn = async function* ({ tools, messages }) {
      mockState.adapterCalls++;
      lastTools = tools;
      lastSystemContent = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
      if (mockState.adapterCalls <= 2) {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-' + mockState.adapterCalls, function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else if (mockState.adapterCalls === 3) {
        yield { type: 'content', delta: '搜索结果较简略，继续深挖具体数据。' };
        yield { type: 'finish', reason: 'stop' };
      } else {
        yield { type: 'content', delta: '这是基于已有工具结果整理出的完整最终报告。' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.synthesisRound).toBe(true);
    expect(result.synthesisReason).toBe('short_stop');
    expect(result.iterations).toBe(4);
    expect(mockState.adapterCalls).toBe(4);
    expect(lastTools).toBeNull();
    expect(lastSystemContent).toContain('资料收集');
    expect(lastSystemContent).toContain('不要提及工具被禁用');
    expect(chunks.find(c => c.type === 'reasoning' && c.delta?.includes('短进度文字'))).toBeDefined();
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('搜索结果较简略'))).toBeUndefined();
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('完整最终报告'))).toBeDefined();
  });

  it('adds research plan and evidence ledger when synthesizing a deep research report', async () => {
    let lastSystemContent = '';
    mockState.adapterFn = async function* ({ messages }) {
      mockState.adapterCalls++;
      lastSystemContent = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
      if (mockState.adapterCalls <= 2) {
        yield { type: 'tool_call_delta', delta: [{
          index: 0,
          id: 'tc-' + mockState.adapterCalls,
          function: {
            name: 'web_search',
            arguments: mockState.adapterCalls === 1
              ? '{"query":"红松 糖豆 老年 用户画像"}'
              : '{"query":"美篇 App 中老年 受众 调研"}',
          },
        }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else if (mockState.adapterCalls === 3) {
        yield { type: 'content', delta: '初步搜索拿到了方向，但摘要太粗，继续深挖。' };
        yield { type: 'finish', reason: 'stop' };
      } else {
        yield { type: 'content', delta: '完整调研报告：一、红松与糖豆用户画像... 二、美篇用户画像... 三、交集与差异... 四、内容传播建议...' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: [
        '为我调研：',
        '1. 红松、糖豆的主要老年受众是哪些群体；',
        '2. 美篇等App的受众是哪些群体；',
        '3. 1和2的群体有哪些交集和差异；',
        '基于以上话题，深入调研和分析，形成docx格式的调研报告。',
      ].join('\n') }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.synthesisRound).toBe(true);
    expect(result.synthesisReason).toBe('short_stop');
    expect(mockState.adapterCalls).toBe(4);
    expect(lastSystemContent).toContain('研究拆题清单');
    expect(lastSystemContent).toContain('红松、糖豆的主要老年受众');
    expect(lastSystemContent).toContain('证据账本');
    expect(lastSystemContent).toContain('红松 糖豆 老年 用户画像');
    expect(lastSystemContent).toContain('美篇 App 中老年 受众 调研');
    expect(lastSystemContent).toContain('合成门禁');
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('初步搜索'))).toBeUndefined();
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('完整调研报告'))).toBeDefined();
  });

  it('does not accept a too-short docx research answer after multiple tool rounds', async () => {
    mockState.adapterFn = async function* () {
      mockState.adapterCalls++;
      if (mockState.adapterCalls <= 2) {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-' + mockState.adapterCalls, function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else if (mockState.adapterCalls === 3) {
        yield { type: 'content', delta: '报告摘要：中老年用户偏好陪伴、健康和娱乐内容。' };
        yield { type: 'finish', reason: 'stop' };
      } else {
        yield { type: 'content', delta: '最终完整报告正文：'.padEnd(1200, '详') };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    const result = await run({
      messages: [{ role: 'user', content: '请深入调研中老年互联网内容生态，并形成 docx 格式完整调研报告。' }],
      onChunk: async (c) => chunks.push(c),
    });
    expect(result.synthesisRound).toBe(true);
    expect(result.synthesisReason).toBe('short_stop');
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('报告摘要：'))).toBeUndefined();
    expect(chunks.find(c => c.type === 'content' && c.delta?.includes('最终完整报告正文'))).toBeDefined();
  });

  it('does not force synthesis for a legitimate one-round short answer', async () => {
    mockState.adapterFn = async function* () {
      mockState.adapterCalls++;
      yield { type: 'content', delta: '是。' };
      yield { type: 'finish', reason: 'stop' };
    };
    const result = await run({
      messages: [{ role: 'user', content: 'q' }],
      onChunk: async () => {},
    });
    expect(result.synthesisRound).toBeUndefined();
    expect(result.iterations).toBe(1);
    expect(mockState.adapterCalls).toBe(1);
  });

  it('does not leak pre-tool progress narration from server-side tool rounds', async () => {
    let turn = 0;
    mockState.adapterFn = async function* () {
      turn++;
      if (turn === 1) {
        yield { type: 'content', delta: '我先搜索一下资料，继续深挖。' };
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'tc-progress', function: { name: 'web_search', arguments: '{}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield { type: 'content', delta: '最终答案已经整理完成。' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const chunks = [];
    await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async (c) => chunks.push(c) });
    const visible = chunks.filter(c => c.type === 'content').map(c => c.delta).join('');
    expect(visible).not.toContain('我先搜索一下资料');
    expect(visible).toContain('最终答案已经整理完成');
  });

  it('flushes buffered content when a tool-enabled round ends with a final answer', async () => {
    mockState.adapterFn = async function* () {
      yield { type: 'content', delta: '直接最终回答。' };
      yield { type: 'finish', reason: 'stop' };
    };
    const chunks = [];
    const result = await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async (c) => chunks.push(c) });
    expect(result.iterations).toBe(1);
    expect(chunks.find(c => c.type === 'content' && c.delta === '直接最终回答。')).toBeDefined();
    expect(chunks.find(c => c.type === 'finish' && c.reason === 'stop')).toBeDefined();
  });

  it('passes tool result content as role=tool message with correct tool_call_id', async () => {
    let capturedMessages = null;
    let turn = 0;
    mockState.adapterFn = async function* ({ messages }) {
      turn++;
      if (turn === 1) {
        yield { type: 'tool_call_delta', delta: [{ index: 0, id: 'specific-id-xyz', function: { name: 'web_search', arguments: '{\"query\":\"hi\"}' } }] };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        capturedMessages = messages;
        yield { type: 'content', delta: 'done' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async () => {} });
    const toolMsg = capturedMessages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('specific-id-xyz');
    expect(toolMsg.content).toContain('mocked-result-for-web_search');
  });

  it('plain content (no tool_calls) returns immediately after one round', async () => {
    mockState.adapterFn = async function* () {
      mockState.adapterCalls++;
      yield { type: 'content', delta: 'hi there' };
      yield { type: 'finish', reason: 'stop' };
    };
    const result = await run({ messages: [{ role: 'user', content: 'q' }], onChunk: async () => {} });
    expect(result.iterations).toBe(1);
    expect(mockState.adapterCalls).toBe(1);
    expect(result.hitMaxIterations).toBeUndefined();
    expect(result.forwardedToClient).toBeUndefined();
  });
});
