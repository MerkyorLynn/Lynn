import { describe, expect, it } from 'vitest';
import {
  buildVoiceRequestText,
  extractAssistantSpeechText,
  jarvisPrimaryLabel,
  resolveJarvisPrimaryAction,
} from '../desktop/src/react/components/voice/JarvisRuntimeOverlay';
import { VOICE_STATE } from '../desktop/src/react/services/voice-ws-client';

describe('JarvisRuntimeOverlay action policy', () => {
  it('uses start as the default action', () => {
    expect(resolveJarvisPrimaryAction(VOICE_STATE.IDLE)).toBe('start');
    expect(resolveJarvisPrimaryAction(VOICE_STATE.DEGRADED)).toBe('start');
    expect(jarvisPrimaryLabel('start')).toBe('开始');
  });

  it('ends the turn while listening', () => {
    expect(resolveJarvisPrimaryAction(VOICE_STATE.LISTENING)).toBe('end-turn');
    expect(jarvisPrimaryLabel('end-turn')).toBe('完成');
  });

  it('interrupts before half-duplex capture while speaking', () => {
    expect(resolveJarvisPrimaryAction(VOICE_STATE.SPEAKING)).toBe('interrupt-listen');
    expect(jarvisPrimaryLabel('interrupt-listen')).toBe('插话');
  });

  it('interrupts current thinking without starting capture', () => {
    expect(resolveJarvisPrimaryAction(VOICE_STATE.THINKING)).toBe('interrupt');
    expect(jarvisPrimaryLabel('interrupt')).toBe('中断');
  });
});

describe('JarvisRuntimeOverlay chat integration helpers', () => {
  it('extracts speakable text from the final assistant chat message', () => {
    expect(extractAssistantSpeechText({
      id: 'a1',
      role: 'assistant',
      blocks: [
        { type: 'text', html: '<p>深圳明天局部多云。</p>', plainText: '深圳明天局部多云。' },
        { type: 'text', html: '<p>气温二十一到二十六度。</p>', plainText: '气温二十一到二十六度。' },
      ],
    })).toBe('深圳明天局部多云。\n\n气温二十一到二十六度。');
  });
});

describe('buildVoiceRequestText — P1-② voice context prompt prefix (slim)', () => {
  it('prepends one-line prefix with short/colloquial/no-markdown/direct-tool signals', () => {
    const out = buildVoiceRequestText('帮我查深圳明天天气');
    expect(out).toContain('[语音对话');
    expect(out).toContain('短答');
    expect(out).toContain('markdown');
    expect(out).toMatch(/工具.*直接|直接.*执行/);
    expect(out).toContain('帮我查深圳明天天气');
  });

  it('trims surrounding whitespace from transcript', () => {
    const out = buildVoiceRequestText('  你好啊  ');
    expect(out).toMatch(/]\s*你好啊$/);
    expect(out).not.toContain('  你好');
  });

  it('keeps prefix under 80 chars to avoid per-turn token bloat', () => {
    const empty = buildVoiceRequestText('');
    expect(empty.length).toBeLessThan(80);
  });
});
