import { describe, expect, it } from 'vitest';
import {
  DEEP_RESEARCH_FETCH_TIMEOUT_MS,
  DEEP_RESEARCH_TIMEOUT_MS,
  formatDeepResearchAssistantText,
  normalizeDeepResearchArtifact,
  normalizeDeepResearchErrorMessage,
} from './deep-research';

describe('deep-research helpers', () => {
  it('keeps frontend fetch timeout longer than the server-side deep research timeout', () => {
    expect(DEEP_RESEARCH_TIMEOUT_MS).toBe(180_000);
    expect(DEEP_RESEARCH_FETCH_TIMEOUT_MS).toBeGreaterThan(DEEP_RESEARCH_TIMEOUT_MS);
  });

  it('formats completion status without exposing scoring metadata', () => {
    const text = formatDeepResearchAssistantText({
      text: 'A3B 通常指每次推理激活约 3B 参数。',
      winnerProviderId: 'deepseek-chat',
    });

    expect(text).toContain('A3B 通常指每次推理激活约 3B 参数。');
    expect(text).toContain('**深度调研**：完成 · 输出来源：deepseek-chat');
    expect(text).not.toContain('推荐来源');
    expect(text).not.toMatch(/\d+\.\d{2}/u);
  });

  it('does not invent fallback text when deep research returns an empty model answer', () => {
    const text = formatDeepResearchAssistantText({
      text: '',
      winnerProviderId: 'deepseek-chat',
    });

    expect(text).toBe('---\n**深度调研**：完成 · 输出来源：deepseek-chat');
    expect(text).not.toContain('没有返回可见答案');
  });

  it('normalizes raw AbortSignal wording into a user-readable timeout message', () => {
    expect(normalizeDeepResearchErrorMessage(new Error('signal is aborted without reason'))).toContain('超过等待时间');
    expect(normalizeDeepResearchErrorMessage(new Error('hanaFetch /api/deep-research: 请求超时（190 秒）'))).toContain('超过等待时间');
  });

  it('normalizes deep research HTML artifacts for chat preview cards', () => {
    expect(normalizeDeepResearchArtifact({
      artifactId: 'deep-1',
      type: 'html',
      title: '深度调研报告',
      content: '<!DOCTYPE html><html></html>',
    })).toEqual({
      artifactId: 'deep-1',
      artifactType: 'html',
      title: '深度调研报告',
      content: '<!DOCTYPE html><html></html>',
      language: 'html',
    });
    expect(normalizeDeepResearchArtifact({ content: '' })).toBeNull();
    expect(normalizeDeepResearchArtifact(null)).toBeNull();
  });

  it('preserves non-timeout failures for debugging', () => {
    expect(normalizeDeepResearchErrorMessage(new Error('deep_research_upstream_error'))).toBe('deep_research_upstream_error');
  });
});
