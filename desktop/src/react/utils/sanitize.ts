/**
 * sanitize.ts — 统一的 HTML 消毒工具
 *
 * 使用 DOMPurify 防止 XSS 攻击。
 * 所有 dangerouslySetInnerHTML 的外部内容（模型输出、Bridge 消息、
 * DOCX/XLSX 渲染、频道消息等）都必须经过此模块处理。
 */

import DOMPurify from 'dompurify';

/**
 * 消毒 HTML —— 允许常见的 Markdown 渲染标签，
 * 但移除所有 script、事件处理器（onerror/onload 等）、iframe 等。
 */
export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    USE_PROFILES: { html: true },
    ALLOWED_TAGS: [
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
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'title', 'class', 'id',
      'width', 'height', 'align', 'valign',
      'colspan', 'rowspan',
      'target', 'rel',
      'style',
      // KaTeX
      'mathvariant', 'encoding',
    ],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'textarea', 'select', 'button'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
    // Allow task-list checkbox inputs (disabled by default from markdown-it-task-lists)
    ADD_TAGS: ['input'],
    ADD_ATTR: ['type', 'checked', 'disabled'],
  });
}

/**
 * 消毒 SVG —— 仅允许安全的 SVG 标签和属性（用于图标等可信内容的额外保护）
 */
export function sanitizeSvg(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    USE_PROFILES: { svg: true },
  });
}
