import { describe, expect, it } from 'vitest';
import {
  DEEP_RESEARCH_FETCH_TIMEOUT_MS,
  DEEP_RESEARCH_TIMEOUT_MS,
  formatDeepResearchAssistantText,
  normalizeDeepResearchErrorMessage,
} from './deep-research';

describe('deep-research helpers', () => {
  it('keeps frontend fetch timeout longer than the server-side deep research timeout', () => {
    expect(DEEP_RESEARCH_TIMEOUT_MS).toBe(180_000);
    expect(DEEP_RESEARCH_FETCH_TIMEOUT_MS).toBeGreaterThan(DEEP_RESEARCH_TIMEOUT_MS);
  });

  it('formats verifier status and top candidate scores', () => {
    const text = formatDeepResearchAssistantText({
      text: 'A3B 通常指每次推理激活约 3B 参数。',
      winnerProviderId: 'deepseek-chat',
      rankedScores: [
        { providerId: 'deepseek-chat', avg: 1.3333 },
        { providerId: 'mimo', avg: 2 },
        { provider: 'glm', average: 3.5 },
        { providerId: 'ignored', avg: 1 },
      ],
    });

    expect(text).toContain('A3B 通常指每次推理激活约 3B 参数。');
    expect(text).toContain('**Deep Research**：已通过质量复核 · winner: deepseek-chat');
    expect(text).toContain('- deepseek-chat: 1.33');
    expect(text).toContain('- mimo: 2.00');
    expect(text).toContain('- glm: 3.50');
    expect(text).not.toContain('ignored');
  });

  it('normalizes raw AbortSignal wording into a user-readable timeout message', () => {
    expect(normalizeDeepResearchErrorMessage(new Error('signal is aborted without reason'))).toContain('超过等待时间');
    expect(normalizeDeepResearchErrorMessage(new Error('hanaFetch /api/deep-research: 请求超时（190 秒）'))).toContain('超过等待时间');
  });

  it('preserves non-timeout failures for debugging', () => {
    expect(normalizeDeepResearchErrorMessage(new Error('deep_research_upstream_error'))).toBe('deep_research_upstream_error');
  });
});
