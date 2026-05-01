/**
 * voice-text-stream-bus.ts — Lynn V0.79 P0-① 增量 TTS 接力
 *
 * 桥接 chat WS 的 text_delta / turn_end 事件流到 voice runtime,
 * 让 JarvisRuntimeOverlay 可以"边出 token 边切句喂 TTS",而不是
 * 等整个 assistant message 完整才调 speakText(可砍 1.5-2.5s 首音延迟)。
 *
 * 设计:
 *   - 简单 pub-sub,handler 接收原始 chat event 自己 filter
 *   - dispatch 出错只 console.warn 不 throw,保证不污染聊天主链
 *   - ws-message-handler.ts 在 streamBufferManager.handle(msg) 后调 dispatch
 *
 * 不存任何状态(无累积 buffer),那是 IncrementalTtsSegmenter 的事。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- WS 事件 schema 由 shared/ws-events 验证,这里只透传 */

export interface VoiceStreamEvent {
  type: string;
  sessionPath?: string;
  delta?: string;
  streamId?: string;
  seq?: number;
  // 其他字段(如 turn_end 的 streamSource)透传给 handler
  [key: string]: unknown;
}

export type VoiceTextStreamHandler = (msg: VoiceStreamEvent) => void;

/**
 * 关心的事件类型白名单。其他事件(tool_start / mood_text / ...)不 dispatch,
 * 减少 handler filter 负担。
 */
const RELEVANT_TYPES = new Set([
  'text_delta',
  'thinking_start',
  'thinking_end',
  'turn_end',
  'error',
  'stream_event_close', // server 主动关流(从 ws-events.js 的事件列表)
]);

class VoiceTextStreamBus {
  private handlers = new Set<VoiceTextStreamHandler>();

  /**
   * 注册 handler。返回 unsubscribe 函数。
   *
   * Handler 可能在同一 turn 内被调用多次 text_delta + 1 次 turn_end。
   * 每个 voice turn 应该用独立的 handler(注册时进入 THINKING,unsubscribe
   * 在 turn_end 或 voice session 切换时)。
   */
  subscribe(handler: VoiceTextStreamHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * ws-message-handler 调入。只 dispatch 白名单类型,handler 自己 filter
   * sessionPath / streamId 等。
   */
  dispatch(msg: any): void {
    if (!msg || typeof msg.type !== 'string') return;
    if (!RELEVANT_TYPES.has(msg.type)) return;
    for (const handler of this.handlers) {
      try {
        handler(msg as VoiceStreamEvent);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[voice-text-bus] handler threw:', err);
      }
    }
  }

  /** 测试用:清空所有 handler。生产代码不用。 */
  reset(): void {
    this.handlers.clear();
  }

  /** 测试用:当前 handler 数。 */
  size(): number {
    return this.handlers.size;
  }
}

export const voiceTextStreamBus = new VoiceTextStreamBus();
