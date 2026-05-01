/**
 * voice-text-stream-bus 单测 — Lynn V0.79 P0-① 2026-05-01
 *
 * 验证:
 *   - subscribe 注册 + 返回 unsubscribe + dispatch 触发
 *   - 白名单过滤(只 dispatch text_delta / turn_end / thinking_* / error / stream_event_close)
 *   - dispatch 出错不冒泡(只 console.warn)
 *   - reset 清空所有 handler
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { voiceTextStreamBus, type VoiceStreamEvent } from '../desktop/src/react/services/voice-text-stream-bus';

describe('voiceTextStreamBus', () => {
  beforeEach(() => {
    voiceTextStreamBus.reset();
  });

  afterEach(() => {
    voiceTextStreamBus.reset();
  });

  it('dispatches text_delta to all subscribed handlers', () => {
    const a = vi.fn();
    const b = vi.fn();
    voiceTextStreamBus.subscribe(a);
    voiceTextStreamBus.subscribe(b);

    voiceTextStreamBus.dispatch({ type: 'text_delta', delta: '你好', sessionPath: '/foo' });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0][0]).toMatchObject({ type: 'text_delta', delta: '你好', sessionPath: '/foo' });
  });

  it('unsubscribe stops further dispatches to that handler', () => {
    const handler = vi.fn();
    const off = voiceTextStreamBus.subscribe(handler);
    voiceTextStreamBus.dispatch({ type: 'text_delta', delta: '一' });
    off();
    voiceTextStreamBus.dispatch({ type: 'text_delta', delta: '二' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('only dispatches whitelisted event types', () => {
    const handler = vi.fn();
    voiceTextStreamBus.subscribe(handler);

    // 白名单内
    voiceTextStreamBus.dispatch({ type: 'text_delta', delta: 'a' });
    voiceTextStreamBus.dispatch({ type: 'thinking_start' });
    voiceTextStreamBus.dispatch({ type: 'thinking_end' });
    voiceTextStreamBus.dispatch({ type: 'turn_end' });
    voiceTextStreamBus.dispatch({ type: 'error', message: 'x' });
    voiceTextStreamBus.dispatch({ type: 'stream_event_close' });

    // 白名单外(应被过滤)
    voiceTextStreamBus.dispatch({ type: 'tool_start', name: 'bash' });
    voiceTextStreamBus.dispatch({ type: 'mood_text', delta: '心情' });
    voiceTextStreamBus.dispatch({ type: 'xing_text', delta: 'reflect' });
    voiceTextStreamBus.dispatch({ type: 'browser_status' });

    const types = handler.mock.calls.map((call) => (call[0] as VoiceStreamEvent).type);
    expect(types).toEqual([
      'text_delta',
      'thinking_start',
      'thinking_end',
      'turn_end',
      'error',
      'stream_event_close',
    ]);
  });

  it('handler that throws does not break sibling handlers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error('handler boom');
    });
    const good = vi.fn();
    voiceTextStreamBus.subscribe(bad);
    voiceTextStreamBus.subscribe(good);

    expect(() => voiceTextStreamBus.dispatch({ type: 'text_delta', delta: 'x' })).not.toThrow();
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ignores invalid input(no type field, null, etc)', () => {
    const handler = vi.fn();
    voiceTextStreamBus.subscribe(handler);
    voiceTextStreamBus.dispatch(null as unknown as VoiceStreamEvent);
    voiceTextStreamBus.dispatch(undefined as unknown as VoiceStreamEvent);
    voiceTextStreamBus.dispatch({ delta: 'no type' } as unknown as VoiceStreamEvent);
    voiceTextStreamBus.dispatch({ type: 42 } as unknown as VoiceStreamEvent);
    expect(handler).not.toHaveBeenCalled();
  });

  it('reset clears all handlers', () => {
    const a = vi.fn();
    const b = vi.fn();
    voiceTextStreamBus.subscribe(a);
    voiceTextStreamBus.subscribe(b);
    expect(voiceTextStreamBus.size()).toBe(2);
    voiceTextStreamBus.reset();
    expect(voiceTextStreamBus.size()).toBe(0);
    voiceTextStreamBus.dispatch({ type: 'text_delta', delta: 'gone' });
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('passes through full event payload(streamId / seq / sessionPath)', () => {
    const handler = vi.fn();
    voiceTextStreamBus.subscribe(handler);
    voiceTextStreamBus.dispatch({
      type: 'text_delta',
      delta: '你好',
      sessionPath: '/sess/abc',
      streamId: 'stream-123',
      seq: 7,
    });
    expect(handler).toHaveBeenCalledWith({
      type: 'text_delta',
      delta: '你好',
      sessionPath: '/sess/abc',
      streamId: 'stream-123',
      seq: 7,
    });
  });
});
