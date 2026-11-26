// @vitest-environment jsdom
/**
 * Regression guards for the second round of reported Chinese leaks.
 *
 * Each block corresponds to a screenshot from the packaged app:
 *   1. the composer showed a Chinese "默认工作模型" model pill
 *   2. the Agent tab's model dropdown showed "默认模型"
 *   3. the MCP tab's built-in server cards (腾讯文档, MiniMax 搜索增强) were
 *      Chinese even though English fallbacks existed
 *   4. a fresh agent's identity / ishiki / public-ishiki text was seeded in
 *      Chinese and displayed verbatim in settings
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  USER_FACING_MODEL_LABELS,
  USER_FACING_MODEL_LABELS_EN,
  getUserFacingModelAlias,
  getUserFacingRoleModelLabel,
  getUserFacingRoleModelLabels,
} from '../../../../../shared/assistant-role-models.js';

const ROOT = path.resolve(__dirname, '../../../../..');
const CJK = /[\u4e00-\u9fff]/;

describe('user-facing model labels follow the locale', () => {
  it('keeps Chinese by default (server/CLI callers unchanged)', () => {
    for (const locale of [undefined, null, '', 'zh', 'zh-CN', 'zh-TW']) {
      expect(getUserFacingRoleModelLabels(locale)).toBe(USER_FACING_MODEL_LABELS);
      expect(getUserFacingRoleModelLabel('lynn', 'chat', locale)).toBe('默认工作模型');
    }
  });

  it('returns English for non-Chinese locales', () => {
    for (const locale of ['en', 'en-US', 'ja', 'ko']) {
      expect(getUserFacingRoleModelLabels(locale)).toBe(USER_FACING_MODEL_LABELS_EN);
      expect(getUserFacingRoleModelLabel('lynn', 'chat', locale)).toBe('Default work model');
    }
  });

  it('has no Chinese in the English labels', () => {
    const chinese = Object.entries(USER_FACING_MODEL_LABELS_EN)
      .filter(([, v]) => CJK.test(v))
      .map(([k, v]) => `${k}=${v}`);
    expect(chinese).toEqual([]);
  });

  it('localizes every role and purpose, not just one', () => {
    for (const role of ['lynn', 'hanako', 'butter']) {
      expect(CJK.test(getUserFacingRoleModelLabel(role, 'chat', 'en')!)).toBe(false);
    }
    for (const purpose of ['utility', 'utility_large', 'review']) {
      expect(CJK.test(getUserFacingRoleModelLabel(null, purpose as never, 'en')!)).toBe(false);
    }
  });

  it('localizes the alias returned for a brain model reference', () => {
    // The composer pill goes through getUserFacingModelAlias, which used to
    // return the frozen Chinese label.
    const zh = getUserFacingModelAlias({
      modelId: 'lynn-brain-router', provider: 'brain', role: 'lynn', purpose: 'chat',
    });
    const en = getUserFacingModelAlias({
      modelId: 'lynn-brain-router', provider: 'brain', role: 'lynn', purpose: 'chat', locale: 'en',
    });
    expect(zh && CJK.test(zh)).toBe(true);
    expect(en).toBe('Default work model');
    expect(CJK.test(en!)).toBe(false);
  });
});

describe('built-in MCP cards follow the locale', () => {
  const catalog = fs.readFileSync(
    path.join(ROOT, 'lib/mcp/mcp-catalog.ts'), 'utf8');

  it('gives every built-in server an English label, description and hint', () => {
    const entries = [...catalog.matchAll(/name: "([^"]+)",[\s\S]*?\n  \},/g)];
    expect(entries.length).toBeGreaterThan(3);
    const missing: string[] = [];
    for (const m of entries) {
      const block = m[0];
      const name = m[1];
      for (const field of ['labelEn', 'descriptionEn', 'hintEn']) {
        if (!new RegExp(`${field}:\\s*"`).test(block)) missing.push(`${name}.${field}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('has no Chinese in the English copy', () => {
    const bad = [...catalog.matchAll(/(labelEn|descriptionEn|hintEn):\s*"([^"]*)"/g)]
      .filter((m) => CJK.test(m[2]))
      .map((m) => `${m[1]}=${m[2]}`);
    expect(bad).toEqual([]);
  });

  it('returns the locale copy from listBuiltinStates', () => {
    const client = fs.readFileSync(
      path.join(ROOT, 'lib/mcp-client.ts'), 'utf8');
    expect(client).toMatch(/listBuiltinStates\(locale\?:/);
    expect(client).toMatch(/english && builtin\.labelEn/);
    expect(client).toMatch(/english && builtin\.descriptionEn/);
    expect(client).toMatch(/english && builtin\.hintEn/);
  });

  it('never lets the server override the localized display copy', () => {
    const helpers = fs.readFileSync(
      path.join(ROOT, 'desktop/src/react/settings/tabs/McpTab.helpers.ts'), 'utf8');
    // The merge must take label/description/hint from the local fallback.
    expect(helpers).toMatch(/label: fallback\?\.label \|\| builtin\.label/);
    expect(helpers).toMatch(/description: fallback\?\.description \|\| builtin\.description/);
    expect(helpers).toMatch(/hint: fallback\?\.hint \|\| builtin\.hint/);
  });

  it('passes the active locale to the builtin endpoint', () => {
    const tab = fs.readFileSync(
      path.join(ROOT, 'desktop/src/react/settings/tabs/McpTab.tsx'), 'utf8');
    expect(tab).toMatch(/\/api\/mcp\/builtin\?locale=/);
    expect(tab).toMatch(/currentLocale/);
  });
});

describe('agent templates exist in English for every yuan', () => {
  const dirs = ['identity-templates', 'ishiki-templates', 'public-ishiki-templates'];
  const yuans = ['lynn', 'hanako', 'butter', 'kong'];

  it('ships an English file per template per yuan with no Chinese', () => {
    const problems: string[] = [];
    for (const dir of dirs) {
      for (const yuan of yuans) {
        const zh = path.join(ROOT, 'lib', dir, `${yuan}.md`);
        const en = path.join(ROOT, 'lib', dir, 'en', `${yuan}.md`);
        if (!fs.existsSync(zh)) { problems.push(`missing zh: ${dir}/${yuan}.md`); continue; }
        if (!fs.existsSync(en)) { problems.push(`missing en: ${dir}/en/${yuan}.md`); continue; }
        const text = fs.readFileSync(en, 'utf8');
        if (CJK.test(text)) problems.push(`Chinese in ${dir}/en/${yuan}.md`);
        if (!text.trim()) problems.push(`empty ${dir}/en/${yuan}.md`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('seeds the template in the saved locale', () => {
    const firstRun = fs.readFileSync(path.join(ROOT, 'core/first-run.ts'), 'utf8');
    // locale must reach the template lookup, with zh as the fallback path
    expect(firstRun).toMatch(/templateLangDir/);
    expect(firstRun).toMatch(/\$\{langDir\}\$\{spec\.yuan\}\.md/);
    expect(firstRun).toMatch(/readSavedLocale/);
  });
});
