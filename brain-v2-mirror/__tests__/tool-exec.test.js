import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../tool-exec/web_search.js', () => ({
  webSearch: vi.fn(async (q) => 'mock results for: ' + q),
}));

import { executeServerTool, isServerTool, mergeWithServerTools, SERVER_TOOLS, SERVER_TOOL_NAMES } from '../tool-exec/index.js';
import { parallelResearch } from '../tool-exec/parallel_research.js';

describe('tool-exec dispatcher', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('routes web_search to webSearch handler', async () => {
    const r = await executeServerTool('web_search', '{"query":"hello"}');
    expect(r).toBe('mock results for: hello');
  });

  it('returns error for unknown tool', async () => {
    const r = await executeServerTool('not_a_tool', '{}');
    expect(JSON.parse(r).error).toMatch(/not handled by brain server/);
  });

  it('handles invalid JSON args gracefully', async () => {
    const r = await executeServerTool('web_search', 'not json');
    expect(JSON.parse(r).error).toMatch(/invalid tool args/);
  });

  it('accepts already-parsed args object', async () => {
    const r = await executeServerTool('web_search', { query: 'parsed' });
    expect(r).toBe('mock results for: parsed');
  });

  it('isServerTool returns true for known and false for unknown', () => {
    expect(isServerTool('web_search')).toBe(true);
    expect(isServerTool('bash')).toBe(false);
  });
});

describe('mergeWithServerTools', () => {
  it('appends serverTools to client tools', () => {
    const merged = mergeWithServerTools([{ type: 'function', function: { name: 'bash' } }]);
    const names = merged.map(t => t.function.name);
    expect(names).toContain('bash');
    expect(names).toContain('web_search');
  });
  it('does not duplicate server tools when client already has them', () => {
    const merged = mergeWithServerTools([{ type: 'function', function: { name: 'web_search' } }]);
    const wsCount = merged.filter(t => t.function.name === 'web_search').length;
    expect(wsCount).toBe(1);
  });
  it('handles null client tools', () => {
    const merged = mergeWithServerTools(null);
    expect(merged.map(t => t.function.name)).toContain('web_search'); expect(merged.length).toBeGreaterThan(5);
  });
});

describe('mergeWithServerTools document-intent gating', () => {
  const names = (clientTools, messages) => mergeWithServerTools(clientTools, messages).map(t => t.function.name);

  it('injects all server tools when messages omitted (back-compat)', () => {
    const n = names(null);
    expect(n).toContain('create_report');
    expect(n).toContain('create_pptx');
    expect(n).toContain('create_pdf');
    expect(n).toContain('create_artifact');
  });

  it('gates out the document generators on a plain turn', () => {
    const n = names(null, [{ role: 'user', content: '今天北京天气怎么样' }]);
    expect(n).toContain('web_search');
    expect(n).toContain('web_fetch');
    expect(n).toContain('weather');
    expect(n).not.toContain('create_report');
    expect(n).not.toContain('create_pptx');
    expect(n).not.toContain('create_pdf');
    expect(n).not.toContain('create_artifact');
  });

  it('injects the document generators on explicit intent (zh)', () => {
    expect(names(null, [{ role: 'user', content: '帮我做个PPT介绍这个项目' }])).toContain('create_pptx');
    expect(names(null, [{ role: 'user', content: '整理成一份分析报告' }])).toContain('create_report');
    expect(names(null, [{ role: 'user', content: '导出成PDF' }])).toContain('create_pdf');
  });

  it('injects the document generators on explicit intent (en)', () => {
    const n = names(null, [{ role: 'user', content: 'generate a PDF report of the results' }]);
    expect(n).toContain('create_pdf');
    expect(n).toContain('create_report');
    expect(names(null, [{ role: 'user', content: 'make a powerpoint deck' }])).toContain('create_pptx');
  });

  it('keeps web_search / web_fetch available regardless of intent', () => {
    const n = names(null, [{ role: 'user', content: 'hello there' }]);
    expect(n).toContain('web_search');
    expect(n).toContain('web_fetch');
  });

  it('detects intent across the recent user turns, not just the last', () => {
    const n = names(null, [
      { role: 'user', content: '研究一下这家公司' },
      { role: 'assistant', content: '好的,这是初步分析…' },
      { role: 'user', content: '做成PPT' },
    ]);
    expect(n).toContain('create_pptx');
  });
});

describe('SERVER_TOOLS schema', () => {
  it('has web_search with required query parameter', () => {
    const ws = SERVER_TOOLS.find(t => t.function.name === 'web_search');
    expect(ws).toBeDefined();
    expect(ws.function.parameters.required).toEqual(['query']);
  });
  it('SERVER_TOOL_NAMES set matches array', () => {
    expect(SERVER_TOOL_NAMES.size).toBe(SERVER_TOOLS.length);
  });
});

describe('parallelResearch', () => {
  it('returns early with partial results once enough sub-queries settle', async () => {
    const startedAt = Date.now();
    const resultText = await parallelResearch({
      queries: [
        { label: 'fast-1', tool: 'web_search', args: { ms: 10, value: 'A' } },
        { label: 'fast-2', tool: 'web_search', args: { ms: 20, value: 'B' } },
        { label: 'slow-3', tool: 'web_search', args: { ms: 2000, value: 'C' } },
      ],
    }, {
      dispatchFn: (_tool, args) => new Promise(resolve => {
        setTimeout(() => resolve(JSON.stringify({ value: args.value })), args.ms);
      }),
    });
    const elapsed = Date.now() - startedAt;
    const data = JSON.parse(resultText);
    expect(elapsed).toBeLessThan(1000);
    expect(data.parallel).toBe(true);
    expect(data.partial).toBe(true);
    expect(data.returned).toBe(2);
    expect(data.results.map(r => r.label)).toEqual(['fast-1', 'fast-2']);
  });
});
