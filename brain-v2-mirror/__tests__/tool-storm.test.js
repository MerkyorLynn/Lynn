import { afterEach, describe, expect, it } from 'vitest';
import {
  buildToolStormReflection,
  createToolStormState,
  observeToolCallStorm,
  readToolStormConfigFromEnv,
  toolCallSignature,
} from '../tool-storm.js';

function toolCall(name, args) {
  return {
    id: 'tc-1',
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

afterEach(() => {
  delete process.env.BRAIN_V2_STORM_DETECT;
  delete process.env.BRAIN_V2_STORM_THRESHOLD;
  delete process.env.BRAIN_V2_STORM_WINDOW;
  delete process.env.BRAIN_V2_STORM_MAX;
});

describe('tool storm guard', () => {
  it('keeps signatures stable for equivalent JSON argument order', () => {
    expect(toolCallSignature('web_search', '{"query":"杭州天气","limit":3}'))
      .toBe(toolCallSignature('web_search', '{"limit":3,"query":"杭州天气"}'));
  });

  it('defaults to disabled unless explicitly enabled', () => {
    expect(readToolStormConfigFromEnv()).toMatchObject({
      enabled: false,
      threshold: 2,
      windowSize: 3,
      maxStorms: 3,
    });
  });

  it('suppresses repeated identical tool calls when enabled', () => {
    const state = createToolStormState();
    const config = { enabled: true, threshold: 2, windowSize: 3, maxStorms: 3 };

    const first = observeToolCallStorm(state, toolCall('unit_convert', { query: '100公里' }), config);
    const second = observeToolCallStorm(state, toolCall('unit_convert', { query: '100公里' }), config);

    expect(first.storm).toBe(false);
    expect(second).toMatchObject({
      storm: true,
      seen: 2,
      stormCount: 1,
      maxStormsReached: false,
    });
  });

  it('does not suppress changed arguments inside the sliding window', () => {
    const state = createToolStormState();
    const config = { enabled: true, threshold: 2, windowSize: 3, maxStorms: 3 };

    observeToolCallStorm(state, toolCall('unit_convert', { query: '100公里' }), config);
    const changed = observeToolCallStorm(state, toolCall('unit_convert', { query: '200公里' }), config);

    expect(changed.storm).toBe(false);
  });

  it('reports maxStormsReached after repeated suppressed calls', () => {
    const state = createToolStormState();
    const config = { enabled: true, threshold: 2, windowSize: 3, maxStorms: 2 };

    observeToolCallStorm(state, toolCall('unit_convert', { query: '100公里' }), config);
    const second = observeToolCallStorm(state, toolCall('unit_convert', { query: '100公里' }), config);
    const third = observeToolCallStorm(state, toolCall('unit_convert', { query: '100公里' }), config);

    expect(second.maxStormsReached).toBe(false);
    expect(third).toMatchObject({ storm: true, stormCount: 2, maxStormsReached: true });
  });

  it('builds a tool-role reflection payload for the model', () => {
    const state = createToolStormState();
    const config = { enabled: true, threshold: 2, windowSize: 3, maxStorms: 3 };
    observeToolCallStorm(state, toolCall('web_search', { query: '杭州天气' }), config);
    const verdict = observeToolCallStorm(state, toolCall('web_search', { query: '杭州天气' }), config);
    const payload = JSON.parse(buildToolStormReflection(verdict));

    expect(payload).toMatchObject({
      ok: false,
      error: 'tool_call_storm_suppressed',
      tool: 'web_search',
      repeat_count: 2,
    });
    expect(payload.message).toContain('Do not call it again');
  });
});
