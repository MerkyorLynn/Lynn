import { afterEach, describe, expect, it } from 'vitest';
import {
  __testing__,
  compactToolResults,
  readToolResultCompactionConfigFromEnv,
} from '../context-compact.js';

afterEach(() => {
  delete process.env.BRAIN_V2_TOOL_RESULT_CAP;
  delete process.env.BRAIN_V2_TOOL_RESULT_KEEP_LATEST;
});

describe('context compaction', () => {
  it('defaults to a conservative enabled cap', () => {
    expect(readToolResultCompactionConfigFromEnv()).toEqual({
      capChars: 12000,
      keepLatest: 1,
    });
  });

  it('does nothing when cap is disabled', () => {
    const messages = [{ role: 'tool', content: 'x'.repeat(20) }];
    expect(compactToolResults(messages, { capChars: 0, keepLatest: 1 })).toBe(messages);
  });

  it('keeps the latest tool result complete and compacts older large ones', () => {
    const older = 'a'.repeat(20);
    const latest = 'b'.repeat(20);
    const messages = [
      { role: 'user', content: 'q' },
      { role: 'tool', tool_call_id: 'old', content: older },
      { role: 'assistant', content: 'more' },
      { role: 'tool', tool_call_id: 'latest', content: latest },
    ];

    const compacted = compactToolResults(messages, { capChars: 5, keepLatest: 1 });

    expect(compacted).not.toBe(messages);
    expect(compacted[1].content).toContain(__testing__.COMPACTED_MARKER);
    expect(compacted[1].content).toContain('original_chars=20');
    expect(compacted[1].content).toContain('aaaaa');
    expect(compacted[3].content).toBe(latest);
  });

  it('is idempotent for already compacted tool results', () => {
    const messages = [
      { role: 'tool', tool_call_id: 'old', content: 'x'.repeat(20) },
      { role: 'tool', tool_call_id: 'latest', content: 'short' },
    ];
    const once = compactToolResults(messages, { capChars: 5, keepLatest: 1 });
    const twice = compactToolResults(once, { capChars: 5, keepLatest: 1 });

    expect(twice).toBe(once);
  });

  it('does not compact non-tool messages', () => {
    const content = 'a'.repeat(20);
    const messages = [{ role: 'assistant', content }];
    expect(compactToolResults(messages, { capChars: 5, keepLatest: 1 })).toBe(messages);
  });

  it('supports keeping multiple latest tool results', () => {
    const messages = [
      { role: 'tool', tool_call_id: '1', content: 'a'.repeat(20) },
      { role: 'tool', tool_call_id: '2', content: 'b'.repeat(20) },
      { role: 'tool', tool_call_id: '3', content: 'c'.repeat(20) },
    ];
    const compacted = compactToolResults(messages, { capChars: 5, keepLatest: 2 });

    expect(compacted[0].content).toContain(__testing__.COMPACTED_MARKER);
    expect(compacted[1].content).toBe(messages[1].content);
    expect(compacted[2].content).toBe(messages[2].content);
  });
});
