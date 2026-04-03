/**
 * 纯工具函数，从 modules/utils.js 平移为 TS module
 */

export function toSlash(s: string): string { return s.replace(/\\/g, '/'); }
export function baseName(s: string): string { return s.replace(/\\/g, '/').split('/').pop() || s; }

export function escapeHtml(str: string): string {
  // eslint-disable-next-line no-restricted-syntax -- escapeHtml utility, not React rendering
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        row.push(field); field = '';
        if (row.some(c => c !== '')) rows.push(row);
        row = [];
        if (ch === '\r') i++;
      } else field += ch;
    }
  }
  row.push(field);
  if (row.some(c => c !== '')) rows.push(row);
  return rows;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);

export function isImageFile(name: string): boolean {
  const ext = (name || '').toLowerCase().replace(/^.*(\.\w+)$/, '$1');
  return IMAGE_EXTS.has(ext);
}

export function formatSessionDate(isoStr: string): string {
  const t = window.t ?? ((p: string) => p);
  const date = new Date(isoStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return t('time.justNow');
  if (diffMin < 60) return t('time.minutesAgo', { n: diffMin });
  if (diffHr < 24) return t('time.hoursAgo', { n: diffHr });
  if (diffDay < 7) return t('time.daysAgo', { n: diffDay });

  const m = date.getMonth() + 1;
  const d = date.getDate();
  return t('time.dateFormat', { m, d });
}

export function cronToHuman(schedule: number | string): string {
  const t = window.t ?? ((p: string) => p);
  if (typeof schedule === 'number') {
    const h = Math.round(schedule / 3600000);
    return h > 0 ? t('cron.everyHours', { n: h }) : t('cron.everyMinutes', { n: Math.round(schedule / 60000) });
  }
  const s = String(schedule);
  const parts = s.split(' ');
  if (parts.length !== 5) return s;
  const [min, hour, , , dow] = parts;
  if (min.startsWith('*/') && hour === '*' && dow === '*') {
    return t('cron.everyMinutes', { n: min.slice(2) });
  }
  if (min === '0' && hour.startsWith('*/') && dow === '*') {
    return t('cron.everyHours', { n: hour.slice(2) });
  }
  if (min === '0' && hour === '*' && dow === '*') return t('cron.hourly');
  if (hour === '*' && dow === '*' && /^\d+$/.test(min)) return t('cron.hourly');
  if (dow === '*' && hour !== '*' && min !== '*') {
    return t('cron.dailyAt', { hour, min: min.padStart(2, '0') });
  }
  const dayNames: string[] = (window.t as (...args: unknown[]) => unknown)('cron.dayNames') as string[] || ['日', '一', '二', '三', '四', '五', '六'];
  const weekPrefix = t('cron.weekPrefix');
  if (dow !== '*' && hour !== '*') {
    const dayStr = dow.split(',').map(d => `${weekPrefix}${(Array.isArray(dayNames) ? dayNames : [])[+d] || d}`).join('/');
    return t('cron.weeklyAt', { days: dayStr, hour, min: min.padStart(2, '0') });
  }
  return s;
}

/**
 * 从 assistant 回复中解析 mood 区块
 */
export function parseMoodFromContent(content: string): { mood: string | null; text: string } {
  if (!content) return { mood: null, text: '' };
  const moodRe = /<(mood|pulse|reflect)>([\s\S]*?)<\/(?:mood|pulse|reflect)>/;
  const match = content.match(moodRe);
  if (!match) return { mood: null, text: content };
  const raw = match[2].trim()
    .replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '')
    .replace(/^\n+/, '').replace(/\n+$/, '');
  const text = content.replace(moodRe, '').replace(/^\n+/, '').trim();
  return { mood: raw, text };
}

const COMMAND_LANGUAGES = new Set([
  'bash',
  'bat',
  'cmd',
  'console',
  'dos',
  'fish',
  'powershell',
  'ps1',
  'sh',
  'shell',
  'shellscript',
  'terminal',
  'zsh',
]);

const COMMAND_PREFIX_RE = /^(?:sudo\s+)?(?:rm|mv|cp|cd|ls|cat|chmod|chown|git|npm|pnpm|yarn|bun|node|python(?:3)?|pip(?:3)?|uv|go|cargo|rustc|java|javac|brew|curl|wget|ssh|scp|docker|kubectl|helm|make|cmake|sed|awk|grep|find|tar|zip|unzip|touch|mkdir|rmdir|code)\b/;

function normalizeCommandLine(line: string): string {
  return line.trim().replace(/^(?:[$>#]\s*)+/, '');
}

function looksLikeCommandBlock(text: string, language?: string): boolean {
  const normalizedLanguage = (language || '').toLowerCase();
  if (COMMAND_LANGUAGES.has(normalizedLanguage)) return true;

  const lines = text
    .split(/\r?\n/)
    .map(normalizeCommandLine)
    .filter(Boolean);

  if (lines.length === 0 || lines.length > 3) return false;
  return lines.every((line) => COMMAND_PREFIX_RE.test(line));
}

/**
 * 给 md-content 里的代码块注入复制按钮，以及仅在真正代码片段上显示写入按钮。
 */
export function injectCopyButtons(container: HTMLElement): void {
  const t = window.t ?? ((p: string) => p);
  const pres = container.querySelectorAll('pre');
  for (const pre of pres) {
    if (pre.querySelector('.copy-btn')) continue;

    // 按钮容器
    // eslint-disable-next-line no-restricted-syntax -- button container injected into rendered Markdown HTML, outside React tree
    const btnGroup = document.createElement('div');
    btnGroup.className = 'code-btn-group';
    btnGroup.style.cssText = 'position:absolute;top:4px;right:4px;display:flex;gap:4px;z-index:1;';

    // Copy 按钮
    // eslint-disable-next-line no-restricted-syntax -- copy button injected into rendered Markdown HTML, outside React tree
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = t('attach.copy');
    const code = pre.querySelector('code');
    const text = code ? code.textContent || '' : pre.textContent || '';
    const langClass = code?.className?.match(/language-([A-Za-z0-9_+-]+)/);
    const language = langClass ? langClass[1].toLowerCase() : undefined;

    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(text || '').then(() => {
        copyBtn.textContent = t('attach.copied');
        setTimeout(() => { copyBtn.textContent = t('attach.copy'); }, 1500);
      });
    });

    btnGroup.appendChild(copyBtn);

    if (!looksLikeCommandBlock(text, language)) {
      // Apply 只保留给真正代码块，避免对 shell 命令产生误导。
      // eslint-disable-next-line no-restricted-syntax -- apply button injected into rendered Markdown HTML, outside React tree
      const applyBtn = document.createElement('button');
      applyBtn.className = 'copy-btn apply-btn';
      applyBtn.textContent = 'Apply';
      applyBtn.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('hana-apply-code', {
          detail: { code: text || '', language, anchorRect: applyBtn.getBoundingClientRect() },
        }));
      });
      btnGroup.appendChild(applyBtn);
    }

    pre.style.position = 'relative';
    pre.appendChild(btnGroup);
  }
}
