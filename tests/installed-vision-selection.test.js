import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isExpectedVisionColorAnswer, selectInstalledVisionModel } from '../scripts/installed-vision-selection.mjs';

const defaultModel = { provider: 'brain', id: 'step-5-preview', isCurrent: true, vision: true };
const alternative = { provider: 'mimo', id: 'mimo-v2.5', isCurrent: false, vision: true };

describe('installed vision answer validation', () => {
  it.each(['红色', '**红色**。', 'RED!'])('accepts the expected color: %s', text => {
    expect(isExpectedVisionColorAnswer(text, ['红', '红色', 'red'])).toBe(true);
  });

  it.each(['', '蓝色', '没有收到图片，不能判断是不是红色', 'If I had to guess, red'])('rejects wrong colors and guesses: %s', text => {
    expect(isExpectedVisionColorAnswer(text, ['红', '红色', 'red'])).toBe(false);
  });
});

describe('installed vision model selection', () => {
  it('tests the current default rather than a fixed provider', () => {
    expect(selectInstalledVisionModel({ models: [alternative, defaultModel] })).toBe(defaultModel);
  });

  it('follows a changed default without a hardcoded model name', () => {
    const changed = { provider: 'another-provider', id: 'future-model', isCurrent: true, vision: true };
    expect(selectInstalledVisionModel({ models: [alternative, changed] })).toBe(changed);
  });

  it('allows an explicitly requested model and provider', () => {
    expect(selectInstalledVisionModel({ models: [defaultModel, alternative] }, { modelId: alternative.id, provider: 'MiMo' })).toBe(alternative);
  });

  it('does not substitute a different vision model when the default lacks vision', () => {
    expect(() => selectInstalledVisionModel({ models: [{ ...defaultModel, vision: false }, alternative] })).toThrow('not vision-capable');
  });

  it.each([{}, { models: [] }, { models: [alternative] }])('rejects missing defaults: %j', payload => {
    expect(() => selectInstalledVisionModel(payload)).toThrow('found 0');
  });

  it('rejects ambiguous defaults', () => {
    expect(() => selectInstalledVisionModel({ models: [defaultModel, { ...alternative, isCurrent: true }] })).toThrow('found 2');
  });

  it('rejects incomplete capability metadata', () => {
    expect(() => selectInstalledVisionModel({ models: [{ ...defaultModel, vision: undefined }] })).toThrow('not vision-capable');
    expect(() => selectInstalledVisionModel({ models: [{ ...defaultModel, provider: '' }] })).toThrow('missing its provider');
  });

  it('does not fall back when an explicit selection is missing or ambiguous', () => {
    expect(() => selectInstalledVisionModel({ models: [defaultModel] }, { modelId: 'missing' })).toThrow('found 0');
    expect(() => selectInstalledVisionModel({ models: [defaultModel, { ...defaultModel, provider: 'other' }] }, { modelId: defaultModel.id })).toThrow('found 2');
  });

  it('does not inherit unrelated provider credentials or silently skip vision', () => {
    const runner = fs.readFileSync(new URL('../scripts/gate-installed-app.mjs', import.meta.url), 'utf8');
    expect(runner).not.toMatch(/MIMO_|mimo-v2|live vision skipped|REQUIRE_LIVE_VISION/);
    expect(runner).toContain('selectInstalledVisionModel(modelsPayload');
    expect(runner).toContain('await runLiveVisionGate(baseUrl, wsUrl, info.token)');
  });
});
