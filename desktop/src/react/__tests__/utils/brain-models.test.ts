import { describe, expect, it } from 'vitest';
import {
  collapseBrainModelChoices,
  formatCompactModelLabel,
  normalizeDisplayModelId,
  normalizeDisplayModelName,
  normalizeDisplayProviderLabel,
} from '../../utils/brain-models';

describe('brain-models', () => {
  it('把 brain 内部模型折叠成一个默认模型入口', () => {
    const collapsed = collapseBrainModelChoices([
      { id: 'deepseek-r1-distill-qwen-7b', name: 'DeepSeek R1 Distill Qwen 7B', provider: 'brain' },
      { id: 'glm-z1-9b-0414', name: 'Glm Z1.9b 0414', provider: 'brain', isCurrent: true },
      { id: 'glm-5.1', name: 'GLM-5.1', provider: 'zhipu' },
    ]);

    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]).toEqual(expect.objectContaining({
      id: 'step-3.5-flash-2603',
      provider: 'brain',
      name: '默认模型',
      isCurrent: true,
    }));
    expect(collapsed[1]).toEqual(expect.objectContaining({
      id: 'glm-5.1',
      provider: 'zhipu',
    }));
  });

  it('把 brain 当前模型显示成默认模型', () => {
    expect(normalizeDisplayModelId('glm-z1-9b-0414', 'brain')).toBe('step-3.5-flash-2603');
    expect(normalizeDisplayModelName({ id: 'lynn-brain-router', name: 'Lynn Brain Router', provider: 'brain' })).toBe('默认模型');
    expect(normalizeDisplayProviderLabel('brain')).toBe('默认模型');
    expect(formatCompactModelLabel({ id: 'lynn-brain-router', provider: 'brain' })).toBe('默认模型');
  });

  it('保留非 brain 模型的原始显示', () => {
    expect(normalizeDisplayModelId('glm-5.1', 'zhipu')).toBe('glm-5.1');
    expect(normalizeDisplayModelName({ id: 'glm-5.1', name: 'GLM-5.1', provider: 'zhipu' })).toBe('GLM-5.1');
    expect(normalizeDisplayProviderLabel('zhipu')).toBe('zhipu');
    expect(formatCompactModelLabel({ id: 'glm-5.1', provider: 'zhipu' })).toBe('zhipu / glm-5.1');
  });
});
