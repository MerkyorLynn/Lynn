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

export interface MarkdownPostprocessContext {
  stateKey?: string;
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

const TASK_CHECKBOX_STATE = new Map<string, boolean>();

function checkboxStateKey(stateKey: string | undefined, index: number): string | null {
  if (!stateKey) return null;
  return `${stateKey}:${index}`;
}

/**
 * 给 md-content 里的代码块注入复制按钮，以及仅在真正代码片段上显示写入按钮。
 */
export function injectCopyButtons(container: HTMLElement): void {
  const t = window.t ?? ((p: string) => p);
  const tt = (key: string, fallback: string) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  };
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

    // Paste 按钮：把代码直接送回输入框，方便继续追问、改写或执行。
    // eslint-disable-next-line no-restricted-syntax -- paste button injected into rendered Markdown HTML, outside React tree
    const pasteBtn = document.createElement('button');
    pasteBtn.className = 'copy-btn paste-btn';
    pasteBtn.textContent = tt('common.pasteToInput', '粘贴');
    pasteBtn.title = tt('common.pasteToInputTitle', '粘贴到输入框');
    pasteBtn.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('hana-paste-to-input', {
        detail: { text: text || '', source: 'code-block', language },
      }));
      pasteBtn.textContent = tt('common.pastedToInput', '已粘贴');
      setTimeout(() => { pasteBtn.textContent = tt('common.pasteToInput', '粘贴'); }, 1200);
    });
    btnGroup.appendChild(pasteBtn);

    if (looksLikeCommandBlock(text, language)) {
      // Run 按钮（仅 shell/命令块）
      // eslint-disable-next-line no-restricted-syntax -- run button injected into rendered Markdown HTML, outside React tree
      const runBtn = document.createElement('button');
      runBtn.className = 'copy-btn run-btn';
      runBtn.textContent = t('common.run') || 'Run';
      runBtn.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('hana-run-command', {
          detail: { command: text || '', language },
        }));
      });
      btnGroup.appendChild(runBtn);
    } else {
      // Apply 只保留给真正代码块
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

/**
 * 让 task-list checkbox 可交互（点击切换勾选状态）
 */
export function injectCheckboxHandlers(container: HTMLElement, stateKey?: string): void {
  const checkboxes = container.querySelectorAll<HTMLInputElement>(
    'li.task-list-item input[type="checkbox"]',
  );
  for (const [index, cb] of Array.from(checkboxes).entries()) {
    const derivedKey = checkboxStateKey(stateKey, index);
    if (derivedKey && TASK_CHECKBOX_STATE.has(derivedKey)) {
      cb.checked = TASK_CHECKBOX_STATE.get(derivedKey) === true;
    }
    if (cb.dataset.interactive) continue;
    cb.dataset.interactive = '1';
    cb.disabled = false;
    cb.addEventListener('change', () => {
      const li = cb.closest('li');
      if (derivedKey) {
        TASK_CHECKBOX_STATE.set(derivedKey, cb.checked);
      }
      if (!li) return;
      if (cb.checked) {
        li.classList.add('is-checked');
      } else {
        li.classList.remove('is-checked');
      }
    });
  }
}

/**
 * 给表格注入列排序功能
 */
export function injectTableSort(container: HTMLElement): void {
  const tables = container.querySelectorAll('table');
  for (const table of tables) {
    if (table.dataset.sortable) continue;
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    if (!thead || !tbody) continue;

    const ths = thead.querySelectorAll('th');
    if (ths.length === 0) continue;

    table.dataset.sortable = '1';

    // 首次提示：表格可排序（只显示一次）
    if (!localStorage.getItem('hana-table-sort-seen')) {
      localStorage.setItem('hana-table-sort-seen', '1');
      // eslint-disable-next-line no-restricted-syntax -- one-time hint tooltip
      const hint = document.createElement('div');
      hint.textContent = (window.t?.('hint.tableSort') as string) || '💡 点击表头可排序';
      hint.style.cssText = 'position:absolute;top:-28px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;font-size:11px;padding:3px 10px;border-radius:4px;white-space:nowrap;z-index:10;opacity:0.9;pointer-events:none;';
      table.style.position = 'relative';
      table.appendChild(hint);
      setTimeout(() => { hint.style.transition = 'opacity 0.5s'; hint.style.opacity = '0'; }, 4000);
      setTimeout(() => hint.remove(), 5000);
    }

    ths.forEach((th, colIdx) => {
      th.classList.add('sortable');
      th.addEventListener('click', () => {
        const rows = Array.from(tbody.querySelectorAll('tr'));
        if (rows.length === 0) return;

        // Determine sort direction
        const wasAsc = th.classList.contains('sort-asc');
        ths.forEach(h => { h.classList.remove('sort-asc', 'sort-desc'); });
        const asc = !wasAsc;
        th.classList.add(asc ? 'sort-asc' : 'sort-desc');

        // Detect column type from first non-empty value
        let isNumeric = true;
        rows.forEach((row) => {
          const cells = row.querySelectorAll('td');
          const text = (cells[colIdx]?.textContent || '').trim();
          if (text && isNaN(Number(text))) isNumeric = false;
        });

        rows.sort((a, b) => {
          const cellsA = a.querySelectorAll('td');
          const cellsB = b.querySelectorAll('td');
          const va = (cellsA[colIdx]?.textContent || '').trim();
          const vb = (cellsB[colIdx]?.textContent || '').trim();
          let cmp: number;
          if (isNumeric) {
            cmp = (Number(va) || 0) - (Number(vb) || 0);
          } else {
            cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
          }
          return asc ? cmp : -cmp;
        });

        for (const row of rows) tbody.appendChild(row);
      });
    });
  }
}

type MarkdownPlugin = (container: HTMLElement, context?: MarkdownPostprocessContext) => void;

const MARKDOWN_PLUGINS: MarkdownPlugin[] = [
  (container) => injectCopyButtons(container),
  (container, context) => injectCheckboxHandlers(container, context?.stateKey),
  (container) => injectTableSort(container),
];

export function postprocessMarkdown(container: HTMLElement, context?: MarkdownPostprocessContext): void {
  for (const plugin of MARKDOWN_PLUGINS) {
    plugin(container, context);
  }
}
