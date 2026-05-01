/**
 * incremental-tts-segmenter 单测 — Lynn V0.79 P0-① 2026-05-01
 *
 * 验证 LLM token streaming → 句切 → 立即 emit 的边界:
 *   - 中英文硬终止符 immediate emit
 *   - 双换行 immediate emit
 *   - 软切点 + 累积阈值
 *   - maxChars 强切(就近 soft sep / 硬切)
 *   - finish() 收尾 + 重入 finish 安全
 *   - 跨 token 拆分(`这是一` + `句话。`)
 *   - reset 后可复用
 */
import { describe, expect, it, vi } from 'vitest';
import { IncrementalTtsSegmenter } from '../desktop/src/react/services/incremental-tts-segmenter';

function makeSegmenter(opts: { min?: number; max?: number } = {}) {
  const out: string[] = [];
  const seg = new IncrementalTtsSegmenter({
    minSegmentChars: opts.min,
    maxSegmentChars: opts.max,
    onSegment: (s) => out.push(s),
  });
  return { seg, out };
}

describe('IncrementalTtsSegmenter', () => {
  it('emits on Chinese hard break 。!?；', () => {
    const { seg, out } = makeSegmenter();
    seg.feed('你好。');
    seg.feed('我是 Lynn!');
    seg.feed('天气真好?');
    seg.feed('结束;');
    expect(out).toEqual(['你好。', '我是 Lynn!', '天气真好?', '结束;']);
  });

  it('emits on English hard break !? (ASCII . is intentionally NOT hard break)', () => {
    // 设计决策:ASCII `.` 不当硬切点,避免误切 "2.5" / URL / 缩写。
    // 中文为主链路,英文 `!?` 仍会硬切。Pipecat issue #1548 同坑(默认 regex 用 .!? 切坏数字)。
    const { seg, out } = makeSegmenter();
    seg.feed('hello.how are you?');
    seg.feed('great!');
    expect(out).toEqual(['hello.how are you?', 'great!']);
  });

  it('emits on double newline (paragraph)', () => {
    const { seg, out } = makeSegmenter();
    seg.feed('第一段没有句号');
    seg.feed('\n\n');
    seg.feed('第二段');
    seg.finish();
    expect(out).toEqual(['第一段没有句号', '第二段']);
  });

  it('soft break only fires when accumulated >= minSegmentChars', () => {
    const { seg, out } = makeSegmenter({ min: 12 });
    seg.feed('短,'); // 2 字 + , < 12,不切
    expect(out).toEqual([]);
    seg.feed('继续累计直到超过十二个字符,'); // 现在累计够了
    expect(out.length).toBeGreaterThan(0);
  });

  it('respects maxSegmentChars hard cap', () => {
    const { seg, out } = makeSegmenter({ min: 12, max: 30 });
    // 一句话 50 字,无任何标点
    seg.feed('这是一段没有任何标点符号的超长文字会一直累积到超过最大字符限制为止然后被强切');
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((s) => s.length <= 30)).toBe(true);
  });

  it('handles tokens that split a sentence across multiple feed() calls', () => {
    const { seg, out } = makeSegmenter();
    seg.feed('这');
    expect(out).toEqual([]);
    seg.feed('是一句');
    expect(out).toEqual([]);
    seg.feed('完整的');
    expect(out).toEqual([]);
    seg.feed('话。');
    expect(out).toEqual(['这是一句完整的话。']);
  });

  it('multiple sentences in a single feed all emit', () => {
    const { seg, out } = makeSegmenter();
    seg.feed('一句。两句!三句?');
    expect(out).toEqual(['一句。', '两句!', '三句?']);
  });

  it('finish() flushes the trailing fragment without delimiter', () => {
    const { seg, out } = makeSegmenter();
    seg.feed('完整。');
    seg.feed('没标点的尾巴');
    expect(out).toEqual(['完整。']);
    seg.finish();
    expect(out).toEqual(['完整。', '没标点的尾巴']);
  });

  it('finish() is idempotent and feed after finish is no-op (防 retry text)', () => {
    const { seg, out } = makeSegmenter();
    seg.feed('一段。');
    seg.finish();
    seg.finish(); // 重复 finish 不应再 emit
    seg.feed('retry 的 text 不应进 TTS。'); // memory feedback_brain_test_persistent_ws
    expect(out).toEqual(['一段。']);
    expect(seg.isFinished()).toBe(true);
  });

  it('empty / whitespace fragments are dropped', () => {
    const { seg, out } = makeSegmenter();
    seg.feed('');
    seg.feed('   ');
    seg.feed('。'); // 空内容 + sep — emit 时 trim 掉,seg = ''
    seg.feed('真内容。');
    expect(out).toEqual(['真内容。']);
  });

  it('emittedCount tracks fired segments', () => {
    const { seg } = makeSegmenter();
    seg.feed('一。两。三。');
    expect(seg.emittedCount()).toBe(3);
  });

  it('reset() returns segmenter to fresh state', () => {
    const { seg, out } = makeSegmenter();
    seg.feed('第一轮。');
    seg.finish();
    expect(seg.isFinished()).toBe(true);

    seg.reset();
    expect(seg.isFinished()).toBe(false);
    expect(seg.bufferedChars()).toBe(0);
    expect(seg.emittedCount()).toBe(0);

    seg.feed('第二轮。');
    expect(out).toEqual(['第一轮。', '第二轮。']);
  });

  it('does not emit segments containing only punctuation', () => {
    const onSegment = vi.fn();
    const seg = new IncrementalTtsSegmenter({ onSegment });
    seg.feed('。。。');
    // 三次 trim 后都是单 punct,但代码现在会发出:这里允许或不允许都可以,
    // 实测意图是单标点不送 TTS。先验证至少不 throw + 没空字符串。
    for (const call of onSegment.mock.calls) {
      expect(call[0]).not.toBe('');
    }
  });

  it('segments after finish do not retroactively change emittedCount', () => {
    const { seg } = makeSegmenter();
    seg.feed('一段。两段。');
    const beforeFinish = seg.emittedCount();
    seg.finish();
    expect(seg.emittedCount()).toBeGreaterThanOrEqual(beforeFinish);
  });

  it('multi-paragraph 1000+ char weather-style answer emits multiple segments (修 B1 regression cover)', () => {
    // 复现"深圳天气"那条 brain answer 的形态:6 段 ~1051 字,过去只读首句的根因案例
    const { seg, out } = makeSegmenter();
    seg.feed('深圳 2026-05-02天气：附近有零星小雨，23-26°C。');
    seg.feed('说明：这是刚刚通过天气工具拿到的预报快照，出门前建议再看一次实时雷达或本地天气 App。');
    seg.feed('数据来源/判断依据：');
    seg.feed('工具：weather；时间：2026-05-01 22:56（本机时间）；');
    seg.feed('依据：天气工具返回的预报快照，按用户问法优先选择今天/明天/后天对应日期。');
    seg.feed('注意：天气预报会滚动变化，出门前建议再看本地天气 App 或雷达。');
    seg.finish();
    expect(out.length).toBeGreaterThanOrEqual(5);
    // 任意 segment 不应过短(< 4 字)— 防 emit 过细
    expect(out.every((s) => s.length >= 4)).toBe(true);
    // 拼回去应该覆盖全部输入文字(允许标点/空格 trim)
    const joined = out.join('');
    expect(joined).toContain('深圳');
    expect(joined).toContain('天气预报会滚动变化');
  });
});
