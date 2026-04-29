/**
 * sanitize.ts — 统一的 HTML 消毒工具
 *
 * 使用 DOMPurify 防止 XSS 攻击。
 * 所有 dangerouslySetInnerHTML 的外部内容（模型输出、Bridge 消息、
 * DOCX/XLSX 渲染、频道消息等）都必须经过此模块处理。
 */

import DOMPurify from 'dompurify';

type PurifyLike = {
  sanitize: (dirty: string, config?: Record<string, unknown>) => string;
};

let cachedPurify: PurifyLike | null = null;
let cachedWindow: Window | null = null;

function getPurify(): PurifyLike {
  const candidate = DOMPurify as unknown as PurifyLike & ((win: Window) => PurifyLike);
  if (typeof candidate.sanitize === 'function') return candidate;

  const win = typeof window !== 'undefined'
    ? window
    : (globalThis as typeof globalThis & { window?: Window }).window;
  if (!win) {
    throw new Error('DOMPurify requires a DOM window. Tests should provide jsdom before calling sanitize helpers.');
  }
  if (!cachedPurify || cachedWindow !== win) {
    cachedPurify = candidate(win);
    cachedWindow = win;
  }
  return cachedPurify;
}

const MARKDOWN_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'hr',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code',
  'a', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'img', 'figure', 'figcaption',
  'div', 'span',
  'details', 'summary',
  'dl', 'dt', 'dd',
  'abbr', 'kbd', 'var', 'samp',
  // KaTeX 需要的标签
  'math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'munder', 'mover',
  'semantics', 'annotation',
];

const MARKDOWN_ATTRS = [
  'href', 'src', 'alt', 'title', 'class', 'id',
  'width', 'height', 'align', 'valign',
  'colspan', 'rowspan',
  'target', 'rel',
  'style',
  // KaTeX
  'mathvariant', 'encoding',
];

const SAFE_FORBID_TAGS = ['script', 'iframe', 'object', 'embed', 'form', 'textarea', 'select', 'button'];
const SAFE_FORBID_ATTR = ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur'];

/**
 * 消毒 HTML —— 允许常见的 Markdown 渲染标签，
 * 但移除所有 script、事件处理器（onerror/onload 等）、iframe 等。
 */
export function sanitizeHtml(dirty: string): string {
  return getPurify().sanitize(dirty, {
    USE_PROFILES: { html: true },
    ALLOWED_TAGS: MARKDOWN_TAGS,
    ALLOWED_ATTR: MARKDOWN_ATTRS,
    FORBID_TAGS: SAFE_FORBID_TAGS,
    FORBID_ATTR: SAFE_FORBID_ATTR,
    // Allow task-list checkbox inputs (disabled by default from markdown-it-task-lists)
    ADD_TAGS: ['input'],
    ADD_ATTR: ['type', 'checked', 'disabled'],
  });
}

/**
 * 消毒完整 HTML Artifact —— 用于 iframe srcDoc 预览。
 *
 * 与普通 Markdown HTML 不同，报告/海报类 artifact 往往是完整文档，
 * 需要保留 html/head/body/meta/style 等结构；但脚本、事件属性和危险
 * URL 仍然必须被移除。
 */
export function sanitizeHtmlArtifact(dirty: string): string {
  return getPurify().sanitize(dirty, {
    USE_PROFILES: { html: true },
    WHOLE_DOCUMENT: true,
    ALLOWED_TAGS: [
      ...MARKDOWN_TAGS,
      'html', 'head', 'body', 'meta', 'title', 'style', 'link',
      'main', 'section', 'article', 'aside', 'header', 'footer', 'nav',
    ],
    ALLOWED_ATTR: [
      ...MARKDOWN_ATTRS,
      'charset', 'name', 'content', 'lang', 'dir',
      'rel', 'href', 'media', 'property',
      'role', 'aria-label', 'aria-hidden',
      'data-label',
    ],
    ADD_TAGS: ['input'],
    ADD_ATTR: ['type', 'checked', 'disabled'],
    FORBID_TAGS: SAFE_FORBID_TAGS,
    FORBID_ATTR: SAFE_FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * 消毒 SVG —— 仅允许安全的 SVG 标签和属性（用于图标等可信内容的额外保护）
 */
export function sanitizeSvg(dirty: string): string {
  return getPurify().sanitize(dirty, {
    USE_PROFILES: { svg: true },
  });
}
