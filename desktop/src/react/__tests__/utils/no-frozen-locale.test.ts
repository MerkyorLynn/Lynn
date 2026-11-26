// @vitest-environment jsdom
/**
 * No locale-dependent value may be computed at module scope.
 *
 * `D(zh, en)` / `L(zh, en)` / `localeText(...)` read the *current* locale. A
 * module-level `const X = D('中文', 'English')` therefore runs once, at import
 * time, and freezes whichever language happened to be active then. Switching
 * to English afterwards leaves that string Chinese — exactly how
 * `百炼 Coding Plan` kept appearing in an English UI.
 *
 * This scans the renderer for such calls outside any function body. Function
 * declarations are fine: they only evaluate when called.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../..');

const LOCALE_CALL = /\b(?:D|L|localeText|copyText|isChineseLocale|currentLocale)\s*\(/;
const SKIP_DIRS = new Set(['node_modules', 'locales', 'public', '__tests__']);

/** Strip strings and line comments so brace counting is not confused. */
function sanitize(line: string): string {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

type Violation = { file: string; line: number; text: string };

function scan(): Violation[] {
  const out: Violation[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;

      const rel = path.relative(SRC, p).replace(/\\/g, '/');
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      let depth = 0;
      let inBlockComment = false;

      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();

        if (inBlockComment) {
          if (trimmed.includes('*/')) inBlockComment = false;
          continue;
        }
        if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
          inBlockComment = true;
          continue;
        }

        const atModuleScope = depth === 0;
        const isComment = trimmed.startsWith('//') || trimmed.startsWith('*');

        if (atModuleScope && !isComment && LOCALE_CALL.test(raw)) {
          // A function/arrow *declaration* is lazy — only its call site matters.
          // Covers `function f()`, `const f = () => ...`, and generic arrows such
          // as `const D = <T,>(zh: T, en: T): T => (...)`.
          const declaresFunction =
            /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*[<(]/.test(raw)
            || /=>/.test(trimmed)
            || /^\s*(?:export\s+)?const\s+\w+\s*(?::[^=]+)?=/.test(raw)
               && /=>/.test(raw);
          if (!declaresFunction) {
            out.push({ file: rel, line: i + 1, text: trimmed.slice(0, 150) });
          }
        }

        const code = sanitize(raw);
        depth += (code.match(/[{([]/g) || []).length;
        depth -= (code.match(/[})\]]/g) || []).length;
        if (depth < 0) depth = 0;
      }
    }
  };

  walk(SRC);
  return out;
}

describe('no locale snapshot is frozen at module scope', () => {
  it('evaluates every locale-dependent value inside a function or hook', () => {
    const violations = scan();
    const report = violations.map((v) => `${v.file}:${v.line}  ${v.text}`);
    expect(report, `locale-dependent value at module scope:\n${report.join('\n')}`).toEqual([]);
  });

  it('detects the old failure shape (self-check)', () => {
    // Guard against the scanner silently matching nothing.
    const sample = "const LABEL = D('本地模型', 'Local model');";
    const declaresFunction =
      /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*[<(]/.test(sample)
      || /=>\s*$/.test(sample.trim());
    expect(LOCALE_CALL.test(sample)).toBe(true);
    expect(declaresFunction).toBe(false);
  });
});
