// @vitest-environment jsdom
/**
 * Locale contract for provider labels and default-model copy.
 *
 * These are the seams that used to leak Chinese into English mode:
 *   - `lib/providers/*.ts` only carried a Chinese `displayName`
 *   - the settings presets froze `D(zh, en)` at module-import time, so the
 *     language active on first import won forever
 *   - the shared default-model copy had no English twin at all
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  BRAIN_COMPLIANCE_NOTE,
  BRAIN_COMPLIANCE_NOTE_EN,
  BRAIN_DEFAULT_DISPLAY_NAME,
  BRAIN_DEFAULT_DISPLAY_NAME_EN,
  BRAIN_DEFAULT_META_LABEL,
  BRAIN_DEFAULT_META_LABEL_EN,
  BRAIN_USER_NOTICE,
  BRAIN_USER_NOTICE_EN,
  getBrainComplianceNote,
  getBrainDisplayMetaLabel,
  getBrainDisplayName,
  getBrainUserNotice,
} from '../../../../../shared/brain-provider.js';
import { getProviderPresets } from '../../settings/helpers';

// desktop/src/react/__tests__/utils -> repo root is four levels up
const ROOT = path.resolve(__dirname, '../../../../..');
const CJK = /[\u4e00-\u9fff]/;

describe('default-model copy follows the locale', () => {
  it('returns the Chinese strings for Chinese locales and when no locale is given', () => {
    for (const locale of [undefined, null, '', 'zh', 'zh-CN', 'zh-TW']) {
      expect(getBrainDisplayName(locale)).toBe(BRAIN_DEFAULT_DISPLAY_NAME);
      expect(getBrainDisplayMetaLabel(locale)).toBe(BRAIN_DEFAULT_META_LABEL);
      expect(getBrainComplianceNote(locale)).toBe(BRAIN_COMPLIANCE_NOTE);
      expect(getBrainUserNotice(locale)).toBe(BRAIN_USER_NOTICE);
    }
  });

  it('returns the English strings for every non-Chinese locale', () => {
    for (const locale of ['en', 'en-US', 'ja', 'ko', 'fr']) {
      expect(getBrainDisplayName(locale)).toBe(BRAIN_DEFAULT_DISPLAY_NAME_EN);
      expect(getBrainDisplayMetaLabel(locale)).toBe(BRAIN_DEFAULT_META_LABEL_EN);
      expect(getBrainComplianceNote(locale)).toBe(BRAIN_COMPLIANCE_NOTE_EN);
      expect(getBrainUserNotice(locale)).toBe(BRAIN_USER_NOTICE_EN);
    }
  });

  it('has no Chinese left in the English twins', () => {
    for (const value of [
      BRAIN_DEFAULT_DISPLAY_NAME_EN,
      BRAIN_DEFAULT_META_LABEL_EN,
      BRAIN_COMPLIANCE_NOTE_EN,
      BRAIN_USER_NOTICE_EN,
    ]) {
      expect(value).toBeTruthy();
      expect(CJK.test(value)).toBe(false);
    }
  });

  it('keeps the Chinese originals intact for the server and CLI', () => {
    expect(BRAIN_DEFAULT_DISPLAY_NAME).toBe('默认模型');
    expect(CJK.test(BRAIN_COMPLIANCE_NOTE)).toBe(true);
  });
});

describe('provider presets are resolved per call, not frozen at import', () => {
  it('is a function so module import order cannot pin the language', () => {
    expect(typeof getProviderPresets).toBe('function');
  });

  it('covers every provider the settings list renders', () => {
    const presets = getProviderPresets();
    const ids = new Set(presets.map((p) => p.value));
    for (const id of [
      'brain', 'openai', 'deepseek', 'moonshot', 'zhipu', 'volcengine',
      'ollama', 'siliconflow', 'groq', 'mistral', 'openrouter',
      'minimax-coding', 'kimi-coding', 'zhipu-coding', 'stepfun-coding',
      'tencent-coding', 'dashscope-coding', 'volcengine-coding',
    ]) {
      expect(ids.has(id), `missing preset: ${id}`).toBe(true);
    }
  });

  it('gives every preset a non-empty label', () => {
    for (const preset of getProviderPresets()) {
      expect(preset.label, `empty label for ${preset.value}`).toBeTruthy();
    }
  });

  it('labels the default provider with an English-able value', () => {
    const brain = getProviderPresets().find((p) => p.value === 'brain');
    expect(brain).toBeTruthy();
    // Chinese is fine here (the harness runs with the zh default), but the
    // helper it calls must be able to produce English too.
    expect(typeof brain!.label).toBe('string');
    expect(getBrainDisplayName('en')).toBe('Default model');
  });
});

describe('every provider plugin ships an English display name', () => {
  it('has displayNameEn for each plugin with a Chinese displayName', () => {
    const dir = path.join(ROOT, 'lib/providers');
    const files = fs.readdirSync(dir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(10);

    const missing: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      const zh = /displayName:\s*"([^"]*)"/.exec(src);
      if (!zh || !CJK.test(zh[1])) continue;
      const en = /displayNameEn:\s*"([^"]*)"/.exec(src);
      if (!en) {
        missing.push(file);
        continue;
      }
      expect(CJK.test(en[1]), `${file}: displayNameEn still has Chinese`).toBe(false);
    }
    expect(missing, `plugins without displayNameEn: ${missing.join(', ')}`).toEqual([]);
  });

  it('forwards displayNameEn through the registry and the providers API', () => {
    const registry = fs.readFileSync(
      path.join(ROOT, 'core/provider-registry.ts'), 'utf8');
    expect(registry).toMatch(/displayNameEn:\s*plugin\.displayNameEn/);

    const route = fs.readFileSync(
      path.join(ROOT, 'server/routes/providers.ts'), 'utf8');
    expect(route).toMatch(/display_name_en\?:\s*string/);
    expect(route).toMatch(/display_name_en:\s*entry\.displayNameEn/);
  });
});

describe('the translate-thinking action targets the UI language', () => {
  it('does not hardcode a Chinese target language', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'desktop/src/react/components/chat/ThinkingBlock.tsx'), 'utf8');
    expect(src).not.toMatch(/targetLanguage:\s*['"]中文['"]/);
    expect(src).toMatch(/resolveTranslateTarget/);
    // each supported locale has an explicit target label
    for (const label of ['繁体中文', '中文', '日文', '韩文', '英文']) {
      expect(src).toContain(`label: '${label}'`);
    }
  });
});
