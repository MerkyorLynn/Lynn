/**
 * incremental-tts-segmenter.ts — Lynn V0.79 P0-① 2026-05-01
 *
 * LLM token streaming → 句切 → 立即吐 segment 给 voice-ws SPEAK_TEXT_APPEND。
 *
 * 切句规则(中英文):
 *   1. 硬终止符 `。!?！？；;` 或双换行 → 立即吐
 *   2. 软切点 `,，:、` 当累计字符 ≥ minSegmentChars(默认 12)时吐
 *   3. cumulative > maxSegmentChars(默认 60)强制吐(就近 sep 切;无 sep 硬切)
 *   4. finish() 强制吐出剩余 buffer
 *
 * Markdown 不在 segmenter 内 strip:server 端 splitTextForTts 会再 clean 一遍
 * (见 voice-ws.js:cleanTextForTts),client 只负责"找句子边界"。
 *
 * 业界参考:Pipecat TextAggregationMode.SENTENCE / LiveKit text aggregator,
 * 但他们的默认 regex `[.!?]` 不识别中文标点(pipecat issue #1548)— 我们重写。
 */

const HARD_BREAK_RE = /[。!?！？；;]/;
const SOFT_BREAK_RE = /[,，:、]/;
// 一个 segment 必须含至少一个汉字 / 拉丁字母 / 数字才有意义;纯标点丢弃
const MEANINGFUL_RE = /[\p{L}\p{N}]/u;

export interface IncrementalTtsSegmenterOptions {
  /** 软切点最小字符门槛(防"嗯,"这种过短的段) */
  minSegmentChars?: number;
  /** 硬上限,无 sep 也强切 */
  maxSegmentChars?: number;
  /** segment 吐出回调 */
  onSegment: (segment: string) => void;
}

export class IncrementalTtsSegmenter {
  private buffer = '';
  private finished = false;
  private readonly minChars: number;
  private readonly maxChars: number;
  private readonly onSegment: (segment: string) => void;
  private emittedSegments = 0;

  constructor(opts: IncrementalTtsSegmenterOptions) {
    this.minChars = opts.minSegmentChars ?? 12;
    this.maxChars = opts.maxSegmentChars ?? 60;
    this.onSegment = opts.onSegment;
  }

  /**
   * 追加 token text,内部决定是否触发 emit。可调多次。
   * finish() 后调 feed 是 no-op(防止 retry text 在 turn_end 后流入)。
   */
  feed(text: string): void {
    if (this.finished) return;
    if (!text) return;
    this.buffer += text;
    this.tryEmit();
  }

  /**
   * 强制吐出剩余 buffer 并标记结束。turn_end 时调用。
   * 重复调安全。
   */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const tail = this.buffer.trim();
    this.buffer = '';
    if (tail && MEANINGFUL_RE.test(tail)) {
      this.emittedSegments += 1;
      this.onSegment(tail);
    }
  }

  /** 测试用:当前 buffered 字符数 */
  bufferedChars(): number {
    return this.buffer.length;
  }

  /** 测试用:已吐出的 segment 计数 */
  emittedCount(): number {
    return this.emittedSegments;
  }

  /** 测试用:重置(供同一实例多 turn 复用) */
  reset(): void {
    this.buffer = '';
    this.finished = false;
    this.emittedSegments = 0;
  }

  isFinished(): boolean {
    return this.finished;
  }

  // ── 内部:扫描 buffer,把可吐的部分切出 ──

  private emitOne(seg: string): void {
    if (!seg) return;
    if (!MEANINGFUL_RE.test(seg)) return; // 纯标点 / 纯空白丢弃
    this.emittedSegments += 1;
    this.onSegment(seg);
  }

  private tryEmit(): void {
    let progress = true;
    while (progress) {
      progress = false;

      // 1. 双换行
      const dn = this.buffer.indexOf('\n\n');
      if (dn >= 0) {
        const seg = this.buffer.slice(0, dn).trim();
        this.buffer = this.buffer.slice(dn + 2);
        this.emitOne(seg);
        progress = true;
        continue;
      }

      // 2. 硬终止符 — 找最早的位置
      const hard = this.findFirstMatch(this.buffer, HARD_BREAK_RE);
      if (hard >= 0) {
        const seg = this.buffer.slice(0, hard + 1).trim();
        this.buffer = this.buffer.slice(hard + 1);
        this.emitOne(seg);
        progress = true;
        continue;
      }

      // 3. 累积超过 maxChars,强切(优先就近 soft sep,否则硬切)
      if (this.buffer.length > this.maxChars) {
        const window = this.buffer.slice(0, this.maxChars);
        const lastSoft = this.findLastMatch(window, SOFT_BREAK_RE);
        const cut = lastSoft >= Math.floor(this.maxChars * 0.45) ? lastSoft + 1 : this.maxChars;
        const seg = this.buffer.slice(0, cut).trim();
        this.buffer = this.buffer.slice(cut);
        this.emitOne(seg);
        progress = true;
        continue;
      }

      // 4. 累积达到 minChars,找第一个落在 [minChars-1, ∞) 区间的 soft sep
      if (this.buffer.length >= this.minChars) {
        const soft = this.findFirstMatchAfter(this.buffer, SOFT_BREAK_RE, this.minChars - 1);
        if (soft >= 0) {
          const seg = this.buffer.slice(0, soft + 1).trim();
          this.buffer = this.buffer.slice(soft + 1);
          this.emitOne(seg);
          progress = true;
          continue;
        }
      }
    }
  }

  private findFirstMatch(value: string, re: RegExp): number {
    const m = re.exec(value);
    return m ? m.index : -1;
  }

  private findFirstMatchAfter(value: string, re: RegExp, minIndex: number): number {
    const global = new RegExp(re.source, 'g');
    let m;
    while ((m = global.exec(value)) !== null) {
      if (m.index >= minIndex) return m.index;
    }
    return -1;
  }

  private findLastMatch(value: string, re: RegExp): number {
    let last = -1;
    const global = new RegExp(re.source, 'g');
    let m;
    while ((m = global.exec(value)) !== null) {
      last = m.index;
    }
    return last;
  }
}
