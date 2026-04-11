/**
 * message-parser.ts — 消息解析工具函数
 *
 * 从 app-messages-shim.ts 和 chat-render-shim.ts 提取，
 * 供 React 组件和 history-builder 共用。
 */

// ── Mood 解析 ──

const TAG_TO_YUAN: Record<string, string> = { mood: 'hanako', pulse: 'butter', reflect: 'lynn' };
const YUAN_LABEL_KEYS: Record<string, string> = {
  hanako: 'mood.hanakoLabel',
  butter: 'mood.butterLabel',
  lynn: 'mood.lynnLabel',
};
const YUAN_LABELS: Record<string, string> = { hanako: '✿ MOOD', butter: '❊ PULSE', lynn: '◈ REFLECT' };
const LOCALIZED_YUAN_LABELS: Record<'zh' | 'zh-TW' | 'ja' | 'ko' | 'en', Record<string, string>> = {
  zh: { hanako: '✿ 情绪', butter: '❊ 脉冲', lynn: '◈ 反思' },
  'zh-TW': { hanako: '✿ 情緒', butter: '❊ 脈衝', lynn: '◈ 反思' },
  ja: { hanako: '✿ ムード', butter: '❊ パルス', lynn: '◈ 振り返り' },
  ko: { hanako: '✿ 무드', butter: '❊ 펄스', lynn: '◈ 성찰' },
  en: YUAN_LABELS,
};
const KNOWN_TOOL_NAMES = new Set([
  'apply_patch',
  'ask_agent',
  'bash',
  'browser',
  'channel',
  'close_agent',
  'create_artifact',
  'cron',
  'delete_file',
  'delegate',
  'dm',
  'edit',
  'edit-diff',
  'execute_command',
  'fetch',
  'find',
  'glob',
  'grep',
  'image_gen',
  'install_skill',
  'list_dir',
  'ls',
  'message_agent',
  'notify',
  'pin_memory',
  'present_files',
  'preview_url',
  'read',
  'read_file',
  'recall_experience',
  'record_experience',
  'replace_in_file',
  'request_user_input',
  'resume_agent',
  'search_content',
  'search_memory',
  'send_input',
  'sports_score',
  'spawn_agent',
  'stock_market',
  'todo',
  'unpin_memory',
  'update_settings',
  'view_image',
  'wait_agent',
  'weather',
  'web_fetch',
  'web_search',
  'write',
  'write_to_file',
  'live_news',
]);
const KNOWN_TOOL_PREFIXES = [
  'web_',
  'search_',
  'pin_',
  'unpin_',
  'record_',
  'recall_',
  'create_',
  'message_',
  'request_',
  'spawn_',
  'send_',
  'wait_',
  'close_',
  'resume_',
];
const PSEUDO_TOOL_TAG_RE = /<(?:\/)?(?:tool[\w:-]*|read[\w:-]*|read_file[\w:-]*|invoke[\w:-]*|minimax:[\w:-]*|arg_value[\w:-]*|path[\w:-]*|function[\w:-]*|parameter[\w:-]*|command[\w:-]*|description[\w:-]*|query[\w:-]*|pattern[\w:-]*|limit[\w:-]*|路径|参数|命令|描述|查询|模式|限制)\b|<(?:function|parameter)=/iu;
const PSEUDO_SHELL_LINE_RE = /^\s*(?:(?:shell|bash|terminal|cmd|powershell)(?:\s*[:：])?\s*(?:[>》〉»›≫$#]+)|(?:\$|#)\s+(?:(?:ls|find|grep|rg|cat|pwd|read|python|node|npm|git|bash|sh)\b)).*$/iu;
const BARE_PSEUDO_COMMAND_LINE_RE = /^\s*(?:(?:find|ls|grep|rg|cat|pwd|glob|read|read_file|invoke|exec|bash)\b.*(?:\/Users\/|[A-Za-z]:\\|2>\/dev\/null|\|\||&&|-maxdepth|-name\b|pattern=|path=|command=).*)$/iu;

function normalizeLocale(locale?: string): 'zh' | 'zh-TW' | 'ja' | 'ko' | 'en' {
  const value = String(locale || '').trim();
  if (value === 'zh-TW' || value === 'zh-Hant') return 'zh-TW';
  if (value.startsWith('zh')) return 'zh';
  if (value.startsWith('ja')) return 'ja';
  if (value.startsWith('ko')) return 'ko';
  return 'en';
}

function localizeMoodSections(raw: string): string {
  const locale = normalizeLocale(globalThis?.window?.i18n?.locale);
  if (locale === 'en') return raw;

  const sectionMaps: Record<string, Record<string, string>> = {
    zh: {
      Premise: '前提 Premise：',
      Conduct: '推演 Conduct：',
      Reflection: '反思 Reflection：',
      Act: '行动 Act：',
    },
    'zh-TW': {
      Premise: '前提 Premise：',
      Conduct: '推演 Conduct：',
      Reflection: '反思 Reflection：',
      Act: '行動 Act：',
    },
    ja: {
      Premise: '前提 Premise:',
      Conduct: '検討 Conduct:',
      Reflection: '振り返り Reflection:',
      Act: '行動 Act:',
    },
    ko: {
      Premise: '전제 Premise:',
      Conduct: '검토 Conduct:',
      Reflection: '성찰 Reflection:',
      Act: '행동 Act:',
    },
  };

  const sectionMap = sectionMaps[locale];
  if (!sectionMap) return raw;

  return Object.entries(sectionMap).reduce((text, [source, target]) => {
    const re = new RegExp(`(^|\\n)\\s*${source}:`, 'gi');
    return text.replace(re, (_match, prefix: string) => `${prefix}${target}`);
  }, raw);
}

export function moodLabel(yuan: string): string {
  const key = YUAN_LABEL_KEYS[yuan] || YUAN_LABEL_KEYS.hanako;
  const locale = normalizeLocale(globalThis?.window?.i18n?.locale);
  try {
    const translated = globalThis?.window?.t?.(key);
    if (translated && translated !== key) return translated;
  } catch {
    // Ignore and fallback to built-in labels.
  }
  return LOCALIZED_YUAN_LABELS[locale]?.[yuan] || LOCALIZED_YUAN_LABELS[locale]?.hanako || YUAN_LABELS[yuan] || YUAN_LABELS.hanako;
}

export function cleanMoodText(raw: string): string {
  return localizeMoodSections(raw
    .replace(/^```\w*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, ''));
}

export function stripToolCodeMarkup(raw: string): string {
  return String(raw || '')
    .replace(/<tool_code\b[\s\S]*?<\/tool_code>\s*/gi, '')
    .replace(/<tool\b[\s\S]*?<\/tool>\s*/gi, '')
    .replace(/<tool_call\b[\s\S]*?<\/tool_call>\s*/gi, '')
    .replace(/<minimax:tool_call\b[\s\S]*?<\/minimax:tool_call>\s*/gi, '')
    .replace(/<invoke\b[\s\S]*?<\/invoke>\s*/gi, '')
    .replace(/<read\b[\s\S]*?<\/read>\s*/gi, '')
    .replace(/<read_file\b[\s\S]*?<\/read_file>\s*/gi, '');
}

function stripLeadingPseudoArgs(line: string): string {
  return String(line || '')
    .replace(
      /^\s*(?:[a-z_][\w:-]*)(?:\s+[a-z_][\w:-]*=(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s]+))+\s*/i,
      '',
    )
    .replace(/^\s*\/?(?:[a-z_][\w:-]*)\s*$/i, '');
}

function looksLikeKnownToolName(name: string): boolean {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return false;
  if (KNOWN_TOOL_NAMES.has(normalized)) return true;
  return KNOWN_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function looksLikeStandalonePseudoToolCall(paragraph: string): boolean {
  const text = String(paragraph || '').trim();
  if (!text || text.startsWith('```') || text.startsWith('>')) return false;

  const openParen = text.indexOf('(');
  const closeParen = text.lastIndexOf(')');
  if (openParen <= 0 || closeParen !== text.length - 1) return false;

  const name = text.slice(0, openParen).trim();
  if (!/^[a-z][a-z0-9_.-]*$/i.test(name)) return false;
  if (!looksLikeKnownToolName(name)) return false;

  const args = text.slice(openParen + 1, -1).trim();
  if (!args) return false;

  return /(?:^|[,(]\s*)(?:[a-z_][a-z0-9_]*|querys|queries)\s*=|\[|\]|\{|\}/i.test(args);
}

function cleanPseudoToolLine(line: string): string {
  let cleaned = String(line ?? '');
  if (PSEUDO_SHELL_LINE_RE.test(cleaned) || BARE_PSEUDO_COMMAND_LINE_RE.test(cleaned)) return '';
  if (looksLikeStandalonePseudoToolCall(cleaned)) return '';
  if (!PSEUDO_TOOL_TAG_RE.test(cleaned)) return cleaned;

  cleaned = cleaned
    .replace(/<\/?(?:tool[\w:-]*|read[\w:-]*|read_file[\w:-]*|invoke[\w:-]*|minimax:[\w:-]*|arg_value[\w:-]*|path[\w:-]*|function[\w:-]*|parameter[\w:-]*|command[\w:-]*|description[\w:-]*|query[\w:-]*|pattern[\w:-]*|limit[\w:-]*|路径|参数|命令|描述|查询|模式|限制)\b[^>\n]*(?:>|$)/giu, '')
    .replace(/<(?:function|parameter)=[^>\n]*(?:>|$)/giu, '');

  return stripLeadingPseudoArgs(cleaned);
}

export function containsPseudoToolCallSimulation(raw: string): boolean {
  const text = String(raw || '');
  if (!text) return false;

  if (PSEUDO_TOOL_TAG_RE.test(text)) return true;
  if (PSEUDO_SHELL_LINE_RE.test(text)) return true;
  if (BARE_PSEUDO_COMMAND_LINE_RE.test(text)) return true;
  const cleaned = stripToolCodeMarkup(text).trim();
  if (!cleaned) return false;
  if (/^\s*(?:list_dir|glob|read|read_file|invoke|exec|bash)\b[\s\S]*?(?:path=|pattern=|command=|limit=)/im.test(cleaned)) {
    return true;
  }

  return cleaned
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .some((paragraph) => looksLikeStandalonePseudoToolCall(paragraph));
}

export function sanitizeAssistantDisplayText(raw: string): string {
  const cleaned = stripToolCodeMarkup(raw)
    .split('\n')
    .map(cleanPseudoToolLine)
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  if (!cleaned.trim()) return '';

  return cleaned
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !looksLikeStandalonePseudoToolCall(paragraph))
    .join('\n\n')
    .trim();
}

export function parseMoodFromContent(content: string): { mood: string | null; yuan: string | null; text: string } {
  if (!content) return { mood: null, yuan: null, text: '' };
  const moodRe = /<(mood|pulse|reflect)>([\s\S]*?)<\/(?:mood|pulse|reflect)>/;
  const match = content.match(moodRe);
  if (!match) return { mood: null, yuan: null, text: sanitizeAssistantDisplayText(content) };
  const yuan = TAG_TO_YUAN[match[1]] || 'hanako';
  const mood = cleanMoodText(match[2].trim());
  const text = sanitizeAssistantDisplayText(content.replace(moodRe, '').replace(/^\n+/, '').trim());
  return { mood, yuan, text };
}

// ── Xing 解析 ──

export interface ParsedXing { title: string; content: string }

export function parseXingFromContent(text: string): { xingBlocks: ParsedXing[]; text: string } {
  const xingRe = /<xing\s+title=["\u201C\u201D]([^"\u201C\u201D]*)["\u201C\u201D]>([\s\S]*?)<\/xing>/g;
  const blocks: ParsedXing[] = [];
  let match;
  while ((match = xingRe.exec(text)) !== null) {
    blocks.push({ title: match[1], content: match[2].trim() });
  }
  const remaining = sanitizeAssistantDisplayText(text.replace(xingRe, '').replace(/^\n+/, '').trim());
  return { xingBlocks: blocks, text: remaining };
}

// ── 用户附件解析 ──

export interface ParsedGitContext {
  repoName: string | null;
  branch: string | null;
  changedCount: number | null;
}

export interface ParsedAttachments {
  text: string;
  files: Array<{ path: string; name: string; isDirectory: boolean }>;
  deskContext: { dir: string; fileCount: number } | null;
  quotedText: string | null;
  gitContext: ParsedGitContext | null;
}

function parseGitContextHeader(raw: string): ParsedGitContext {
  const repoMatch = raw.match(/repo=([^;]+)/);
  const branchMatch = raw.match(/branch=([^;]+)/);
  const changedMatch = raw.match(/changed=(\d+)/);
  return {
    repoName: repoMatch ? repoMatch[1].trim() : null,
    branch: branchMatch ? branchMatch[1].trim() : null,
    changedCount: changedMatch ? Number(changedMatch[1]) : null,
  };
}

export function parseUserAttachments(content: string): ParsedAttachments {
  if (!content) return { text: '', files: [], deskContext: null, quotedText: null, gitContext: null };
  const lines = content.split('\n');
  const textLines: string[] = [];
  const files: Array<{ path: string; name: string; isDirectory: boolean }> = [];
  const attachRe = /^\[(附件|目录|参考文档)\]\s+(.+)$/;
  let deskContext: { dir: string; fileCount: number } | null = null;
  let quotedText: string | null = null;
  let gitContext: ParsedGitContext | null = null;
  let inDeskBlock = false;

  for (const line of lines) {
    const deskMatch = line.match(/^\[当前书桌目录\]\s+(.+)$/);
    if (deskMatch) {
      inDeskBlock = true;
      deskContext = { dir: deskMatch[1].trim(), fileCount: 0 };
      continue;
    }
    if (inDeskBlock) {
      if (line.startsWith('  ') || line.startsWith('...')) {
        if (line.startsWith('  ')) deskContext!.fileCount++;
        continue;
      }
      inDeskBlock = false;
    }

    const gitHeaderMatch = line.match(/^\[Git 上下文\]\s+(.+)$/);
    if (gitHeaderMatch) {
      gitContext = parseGitContextHeader(gitHeaderMatch[1]);
      continue;
    }
    if (line.startsWith('[Git 根目录] ') || line.startsWith('[Git 变更] ') || line.startsWith('[Git 提交] ')) {
      continue;
    }

    const quoteMatch = line.match(/^\[引用片段\]\s+(.+)$/);
    if (quoteMatch) {
      const raw = quoteMatch[1];
      const titleMatch = raw.match(/^(.+?)（第\d/);
      quotedText = titleMatch ? titleMatch[1].trim() : raw.trim();
      continue;
    }

    const m = line.match(attachRe);
    if (m) {
      const isDir = m[1] === '目录';
      const p = m[2].trim();
      const name = p.split('/').pop() || p;
      files.push({ path: p, name, isDirectory: isDir });
    } else {
      textLines.push(line);
    }
  }
  const text = textLines.join('\n').replace(/\n+$/, '').trim();
  return { text, files, deskContext, quotedText, gitContext };
}

// ── 工具详情提取 ──

export function truncatePath(p: string): string {
  if (!p || p.length <= 35) return p;
  return '…' + p.slice(-34);
}

export function extractHostname(u: string): string {
  if (!u) return '';
  try { return new URL(u).hostname; } catch { return u; }
}

export function truncateHead(s: string, max: number): string {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function extractToolDetail(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
    case 'edit-diff':
      return truncatePath((args.file_path || args.path || '') as string);
    case 'bash':
      return truncateHead((args.command || '') as string, 40);
    case 'glob':
    case 'find':
      return (args.pattern || '') as string;
    case 'grep':
      return truncateHead((args.pattern || '') as string, 30) +
        (args.path ? ` in ${truncatePath(args.path as string)}` : '');
    case 'ls':
      return truncatePath((args.path || '') as string);
    case 'web_fetch':
      return extractHostname((args.url || '') as string);
    case 'web_search':
      return truncateHead((args.query || '') as string, 40);
    case 'stock_market':
      return truncateHead(((args.query || args.symbol || args.kind) || '') as string, 40);
    case 'weather':
      return truncateHead(((args.location || args.city || args.query) || '') as string, 40);
    case 'sports_score':
      return truncateHead(((args.query || args.team || args.league || args.match) || '') as string, 40);
    case 'live_news':
      return truncateHead(((args.query || args.topic || args.keyword) || '') as string, 40);
    case 'browser':
      return extractHostname((args.url || '') as string);
    case 'search_memory':
      return truncateHead((args.query || '') as string, 40);
    default:
      return '';
  }
}
