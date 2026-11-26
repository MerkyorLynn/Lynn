// @vitest-environment jsdom
/**
 * Guards the `t('key') || '中文'` pattern.
 *
 * `t()` returns the key itself when a translation is missing, and a raw key is
 * truthy — so the `|| '中文'` fallback never fires and the user sees either a
 * raw key or Chinese. This bit us in the packaged build: `en.json` was missing
 * `settings.providers.ready`, and `settings.providers.defaultModelReadyHint`
 * rendered as its own key next to Chinese text.
 *
 * Two invariants, both enforced here:
 *   1. every key the renderer asks for exists in the English pack
 *   2. every such key has a non-Chinese English value
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../..');
const LOCALES = path.resolve(__dirname, '../../../locales');
const CJK = /[\u4e00-\u9fff]/;

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v as Record<string, unknown>, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

const enRaw = JSON.parse(fs.readFileSync(path.join(LOCALES, 'en.json'), 'utf8'));
const zhRaw = JSON.parse(fs.readFileSync(path.join(LOCALES, 'zh.json'), 'utf8'));
const en = flatten(enRaw);
const zh = flatten(zhRaw);

/** Some keys intentionally resolve to an object (e.g. `yuan.types`). */
function resolvesToObject(key: string): boolean {
  let node: unknown = enRaw;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return false;
    node = (node as Record<string, unknown>)[part];
  }
  return !!node && typeof node === 'object';
}

/** Ignore keys that only appear inside comments / doc examples. */
function isInComment(src: string, index: number): boolean {
  const lineStart = src.lastIndexOf('\n', index) + 1;
  const line = src.slice(lineStart, index).trimStart();
  return line.startsWith('//') || line.startsWith('*') || line.startsWith('/*');
}

/** Keys resolved by the inline `ui-i18n` table rather than the locale packs. */
const uiI18nSrc = fs.readFileSync(
  path.resolve(__dirname, '../../utils/ui-i18n.ts'), 'utf8');

const KEY_CALL =
  /\b(?:t|tt|tr|tf|tFn|label|labelOr|labelFor|settingsText|onboardingMessage)\s*\(\s*['"]([A-Za-z0-9_.\-]+)['"]/g;

/** Collect every literal key passed to a translation helper in the renderer. */
function collectKeys(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'locales', 'public', '__tests__'].includes(entry.name)) continue;
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      let m: RegExpExecArray | null;
      KEY_CALL.lastIndex = 0;
      while ((m = KEY_CALL.exec(src)) !== null) {
        if (isInComment(src, m.index)) continue;
        if (!found.has(m[1])) {
          found.set(m[1], path.relative(SRC, p).replace(/\\/g, '/'));
        }
      }
    }
  };
  walk(SRC);
  return found;
}

const keys = collectKeys();

describe('renderer translation keys resolve in English mode', () => {
  it('finds a meaningful number of keys', () => {
    expect(keys.size).toBeGreaterThan(500);
  });

  it('has every key the renderer uses in en.json (or the ui-i18n table)', () => {
    const missing: string[] = [];
    for (const [key, file] of keys) {
      if (key in en) continue;
      if (resolvesToObject(key)) continue;
      // thinking.* / chat.* copy can live in the inline ui-i18n table
      if (uiI18nSrc.includes(`'${key}'`)) continue;
      missing.push(`${key}  <- ${file}`);
    }
    expect(missing, `keys that would render raw:\n${missing.join('\n')}`).toEqual([]);
  });

  it('has no Chinese in any English value for a used key', () => {
    const chinese: string[] = [];
    for (const key of keys.keys()) {
      const value = en[key];
      if (typeof value === 'string' && CJK.test(value)) {
        chinese.push(`${key} -> ${value}`);
      }
    }
    expect(chinese, `English values containing Chinese:\n${chinese.join('\n')}`).toEqual([]);
  });

  it('keeps zh and en packs at exact key parity', () => {
    const enOnly = Object.keys(en).filter((k) => !(k in zh));
    const zhOnly = Object.keys(zh).filter((k) => !(k in en));
    expect(enOnly, `keys only in en: ${enOnly.join(', ')}`).toEqual([]);
    expect(zhOnly, `keys only in zh: ${zhOnly.join(', ')}`).toEqual([]);
  });

  it('has no flat dotted top-level keys in any pack (they are unreachable)', () => {
    for (const name of ['en', 'zh', 'ja', 'ko', 'zh-TW']) {
      const pack = JSON.parse(
        fs.readFileSync(path.join(LOCALES, `${name}.json`), 'utf8'));
      const flat = Object.keys(pack).filter((k) => k.includes('.'));
      expect(flat, `${name}.json has flat dotted keys: ${flat.join(', ')}`).toEqual([]);
    }
  });
});
