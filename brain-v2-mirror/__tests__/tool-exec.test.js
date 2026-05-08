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
