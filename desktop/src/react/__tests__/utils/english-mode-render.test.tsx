// @vitest-environment jsdom
/**
 * Proves the *component-level* fixes work: with the locale set to English, the
 * modules that used to leak Chinese must return English.
 *
 * Covers the exact failures reported from the packaged app:
 *   - provider names (百炼 / 火山引擎 / default model)
 *   - the default-model compliance copy
 *   - the settings preset labels (were frozen at import time)
 *   - the translate-thinking target language
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BRAIN_COMPLIANCE_NOTE_EN,
  BRAIN_DEFAULT_DISPLAY_NAME_EN,
  BRAIN_DEFAULT_META_LABEL_EN,
  BRAIN_USER_NOTICE_EN,
  getBrainComplianceNote,
  getBrainDisplayMetaLabel,
  getBrainDisplayName,
  getBrainUserNotice,
} from '../../../../../shared/brain-provider.js';
import { brainComplianceNote, brainDisplayMetaLabel, brainDisplayName, brainUserNotice } from '../../utils/brain-models';
import { getProviderPresets } from '../../settings/helpers';
import { localQwenProviderLabel } from '../../settings/tabs/providers/ProviderDetail.helpers';

const CJK = /[\u4e00-\u9fff]/;

/** Point the renderer at a locale, the way lib/i18n.js does at runtime. */
function setLocale(locale: string) {
  (window as unknown as { i18n?: { locale?: string } }).i18n = { locale };
  document.documentElement.lang = locale;
}

describe('English mode produces English provider copy', () => {
  beforeEach(() => setLocale('en'));

  it('localizes the default-model name', () => {
    expect(brainDisplayName()).toBe(BRAIN_DEFAULT_DISPLAY_NAME_EN);
    expect(CJK.test(brainDisplayName())).toBe(false);
  });

  it('localizes the compliance and user notices', () => {
    expect(brainComplianceNote()).toBe(BRAIN_COMPLIANCE_NOTE_EN);
    expect(brainUserNotice()).toBe(BRAIN_USER_NOTICE_EN);
    expect(CJK.test(brainComplianceNote())).toBe(false);
    expect(CJK.test(brainUserNotice())).toBe(false);
  });

  it('localizes the meta label', () => {
    expect(brainDisplayMetaLabel()).toBe(BRAIN_DEFAULT_META_LABEL_EN);
  });

  it('localizes the local model provider label', () => {
    expect(localQwenProviderLabel()).toBe('Local Qwen3.8-27B Coder390');
    expect(CJK.test(localQwenProviderLabel())).toBe(false);
  });

  it('gives every provider preset a Chinese-free label in English mode', () => {
    const presets = getProviderPresets();
    const zhLabels = presets.filter((p) => CJK.test(p.label));
    expect(zhLabels.map((p) => `${p.value}=${p.label}`)).toEqual([]);
  });

  it('does not freeze preset labels across a locale switch', () => {
    setLocale('zh');
    const zhLabels = getProviderPresets().map((p) => p.label);
    setLocale('en');
    const enLabels = getProviderPresets().map((p) => p.label);

    // Chinese mode keeps the vendor's Chinese name...
    expect(zhLabels.some((l) => CJK.test(l))).toBe(true);
    // ...and English mode never does, even though the module was imported
    // while Chinese was active (the old bug froze this).
    expect(enLabels.filter((l) => CJK.test(l))).toEqual([]);
    // same providers, same order
    expect(enLabels.length).toBe(zhLabels.length);
  });
});

describe('Chinese mode is unchanged', () => {
  beforeEach(() => setLocale('zh'));

  it('still shows the original Chinese copy', () => {
    expect(brainDisplayName()).toBe('默认模型');
    expect(CJK.test(brainComplianceNote())).toBe(true);
    expect(localQwenProviderLabel()).toBe('本地 Qwen3.8-27B Coder390');
    expect(getProviderPresets().some((p) => CJK.test(p.label))).toBe(true);
  });

  it('localizes to Chinese for zh-TW too', () => {
    setLocale('zh-TW');
    expect(brainDisplayName()).toBe('默认模型');
  });
});
