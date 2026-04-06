/**
 * message-parser.ts — 消息解析工具函数
 *
 * 从 app-messages-shim.ts 和 chat-render-shim.ts 提取，
 * 供 React 组件和 history-builder 共用。
 */

// ── Mood 解析 ──

const TAG_TO_YUAN: Record<string, string> = { mood: 'hanako', pulse: 'butter', reflect: 'lynn' };
const YUAN_LABELS: Record<string, string> = { hanako: '✿ MOOD', butter: '❊ PULSE', lynn: '◈ REFLECT' };

export function moodLabel(yuan: string): string {
  return YUAN_LABELS[yuan] || YUAN_LABELS.hanako;
}

export function cleanMoodText(raw: string): string {
  return raw
    .replace(/^```\w*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

export function parseMoodFromContent(content: string): { mood: string | null; yuan: string | null; text: string } {
  if (!content) return { mood: null, yuan: null, text: '' };
  const moodRe = /<(mood|pulse|reflect)>([\s\S]*?)<\/(?:mood|pulse|reflect)>/;
  const match = content.match(moodRe);
  if (!match) return { mood: null, yuan: null, text: content };
  const yuan = TAG_TO_YUAN[match[1]] || 'hanako';
  const mood = cleanMoodText(match[2].trim());
  const text = content.replace(moodRe, '').replace(/^\n+/, '').trim();
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
  const remaining = text.replace(xingRe, '').replace(/^\n+/, '').trim();
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
    case 'browser':
      return extractHostname((args.url || '') as string);
    case 'search_memory':
      return truncateHead((args.query || '') as string, 40);
    default:
      return '';
  }
}
