/**
 * diff-utils.ts — 写作 Diff 工具
 *
 * 从 unified diff 重建原文/新文，段落对齐，内容重建。
 * 配合 WritingDiffViewer 使用。
 */

import { diffWords } from 'diff';

// ── 类型 ──

export interface ParagraphPair {
  type: 'unchanged' | 'modified' | 'added' | 'removed';
  oldText?: string;
  newText?: string;
  index: number;
}

export interface WordChange {
  value: string;
  added?: boolean;
  removed?: boolean;
}

// ── 从 unified diff 重建原文/新文 ──
// 支持两种 diff 格式：
// (A) 标准 unified diff: "+line" "-line" " line" "@@..." "---" "+++"
// (B) pi-coding-agent 格式: "+NN line" "-NN line" " NN line"（行号前缀）
//     其中 NN 是右对齐空格填充的行号（padStart）

function stripLineNumberPrefix(text: string): string {
  // 剥掉 "\s*\d+ "（pi-coding-agent edit 工具的行号前缀）
  // 例如 " 33 内容" → "内容"；"  7 内容" → "内容"
  const m = text.match(/^(\s*\d+)\s(.*)$/s);
  return m ? m[2] : text;
}

/**
 * 探测 diff 是不是 pi-coding-agent 格式：
 * 标准 unified diff 有 `@@ -x,y +a,b @@` hunk header，pi 格式没有。
 * [2026-04-17 修复] 之前无差别 strip 会吞掉用户正文里 "2024 年"、"10 条建议" 之类的开头数字。
 */
function detectDiffFormat(diff: string): 'unified' | 'pi-agent' {
  return /^@@.*@@/m.test(diff) ? 'unified' : 'pi-agent';
}

export function reconstructFromUnifiedDiff(diff: string): { oldText: string; newText: string } {
  const format = detectDiffFormat(diff);
  const maybeStrip = (t: string) => (format === 'pi-agent' ? stripLineNumberPrefix(t) : t);
  const lines = diff.split('\n');
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) {
      continue;
    } else if (line.startsWith('-')) {
      oldLines.push(maybeStrip(line.slice(1)));
    } else if (line.startsWith('+')) {
      newLines.push(maybeStrip(line.slice(1)));
    } else if (line.startsWith(' ')) {
      const content = maybeStrip(line.slice(1));
      oldLines.push(content);
      newLines.push(content);
    } else if (line === '') {
      // trailing empty line in diff — ignore
    }
  }

  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

// ── 段落分割 ──

export function splitParagraphs(text: string): string[] {
  // 按连续空行分段，保留段落内的单换行
  return text.split(/\n{2,}/).filter(p => p.trim().length > 0);
}

// ── 段落对齐（LCS） ──

export function alignParagraphs(oldParas: string[], newParas: string[]): ParagraphPair[] {
  const m = oldParas.length;
  const n = newParas.length;

  // 简化相似度：去空白后完全相同视为 unchanged，否则算词集/字集重合比
  // [2026-04-17 修复] 中文没空格 → split(/\s+/) 整段只得 1 段 → 永远判 "完全不同"
  // 修：对"词集只有 1 个"的文本（典型中文）降级到字符 2-gram 集合
  const toBigrams = (s: string): Set<string> => {
    const bi = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) bi.add(s.slice(i, i + 2));
    return bi;
  };
  const isSimilar = (a: string, b: string): boolean => {
    const at = a.trim();
    const bt = b.trim();
    if (at === bt) return true;
    const aWords = at.split(/\s+/);
    const bWords = bt.split(/\s+/);
    // 任一段在词级只剩 1 个"词" → 用字符 bigram 兜底（对中日韩等无空格语言有效）
    const useBigrams = aWords.length <= 1 || bWords.length <= 1;
    const aSet = useBigrams ? toBigrams(at) : new Set(aWords);
    const bSet = useBigrams ? toBigrams(bt) : new Set(bWords);
    let common = 0;
    for (const w of bSet) if (aSet.has(w)) common++;
    const total = Math.max(aSet.size, bSet.size);
    return total > 0 && common / total > 0.4;
  };

  // LCS DP
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (isSimilar(oldParas[i - 1], newParas[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯
  const result: ParagraphPair[] = [];
  let idx = 0;
  let i = m, j = n;

  const pending: ParagraphPair[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && isSimilar(oldParas[i - 1], newParas[j - 1])) {
      const ot = oldParas[i - 1].trim();
      const nt = newParas[j - 1].trim();
      pending.push({
        type: ot === nt ? 'unchanged' : 'modified',
        oldText: oldParas[i - 1],
        newText: newParas[j - 1],
        index: 0, // assign later
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      pending.push({ type: 'added', newText: newParas[j - 1], index: 0 });
      j--;
    } else {
      pending.push({ type: 'removed', oldText: oldParas[i - 1], index: 0 });
      i--;
    }
  }

  pending.reverse();
  for (const p of pending) {
    p.index = idx++;
    result.push(p);
  }

  return result;
}

// ── 词级 Diff ──

export function computeWordDiff(oldText: string, newText: string): WordChange[] {
  return diffWords(oldText, newText);
}

// ── 根据用户决定重建最终内容 ──

export function buildFinalContent(
  pairs: ParagraphPair[],
  decisions: Map<number, 'accept' | 'reject'>,
  edits?: Map<number, string>,
): string {
  const parts: string[] = [];

  for (const pair of pairs) {
    const decision = decisions.get(pair.index);
    const edited = edits?.get(pair.index);

    // 如果有手改版本，直接使用（覆盖所有 decision 逻辑）
    if (edited !== undefined) {
      if (edited.trim() !== '') {
        parts.push(edited);
      }
      // edited 为空串 = 用户手动清空该段 = 删除
      continue;
    }

    switch (pair.type) {
      case 'unchanged':
        parts.push(pair.newText || pair.oldText || '');
        break;
      case 'modified':
        if (decision === 'reject') {
          parts.push(pair.oldText || '');
        } else {
          parts.push(pair.newText || '');
        }
        break;
      case 'added':
        if (decision !== 'reject') {
          parts.push(pair.newText || '');
        }
        break;
      case 'removed':
        if (decision === 'reject') {
          parts.push(pair.oldText || '');
        }
        break;
    }
  }

  return parts.join('\n\n');
}

function compactBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * 将段落审阅结果应用到完整当前文件，而不是只从 diff hunk 重建整文。
 *
 * WritingDiffViewer 的 pairs 来自 unified diff 上下文，只覆盖被修改的片段。
 * 如果直接 buildFinalContent(pairs, ...) 再覆盖文件，会把未出现在 diff
 * hunk 里的正文全部截断。这里改为在完整 currentContent 中逐段替换/删除/插入。
 */
export function applyReviewToFullContent(
  currentContent: string,
  pairs: ParagraphPair[],
  decisions: Map<number, 'accept' | 'reject'>,
  edits?: Map<number, string>,
): string {
  let content = currentContent;
  let cursor = 0;

  const replaceOnce = (target: string, replacement: string, label: string) => {
    if (!target) return;
    let index = content.indexOf(target, cursor);
    if (index < 0) index = content.indexOf(target);
    if (index < 0) {
      throw new Error(`Cannot safely apply review: ${label} paragraph no longer matches the file.`);
    }
    content = content.slice(0, index) + replacement + content.slice(index + target.length);
    cursor = Math.max(0, index + replacement.length);
  };

  const insertNearContext = (pairIndex: number, insertion: string) => {
    if (!insertion) return;

    for (let i = pairIndex - 1; i >= 0; i--) {
      const anchor = edits?.get(pairs[i].index) ?? pairs[i].newText ?? pairs[i].oldText ?? '';
      if (!anchor) continue;
      const index = content.indexOf(anchor);
      if (index >= 0) {
        const at = index + anchor.length;
        content = `${content.slice(0, at)}\n\n${insertion}${content.slice(at)}`;
        cursor = at + insertion.length + 2;
        return;
      }
    }

    for (let i = pairIndex + 1; i < pairs.length; i++) {
      const anchor = edits?.get(pairs[i].index) ?? pairs[i].newText ?? pairs[i].oldText ?? '';
      if (!anchor) continue;
      const index = content.indexOf(anchor);
      if (index >= 0) {
        content = `${content.slice(0, index)}${insertion}\n\n${content.slice(index)}`;
        cursor = index + insertion.length + 2;
        return;
      }
    }

    content = insertion + (content ? `\n\n${content}` : '');
    cursor = insertion.length + 2;
  };

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const decision = decisions.get(pair.index);
    const edited = edits?.get(pair.index);

    if (edited !== undefined) {
      if (pair.type === 'removed') {
        if (edited.trim() !== '') insertNearContext(i, edited);
      } else {
        const target = pair.newText || pair.oldText || '';
        replaceOnce(target, edited, 'edited');
      }
      continue;
    }

    if (pair.type === 'modified' && decision === 'reject') {
      replaceOnce(pair.newText || '', pair.oldText || '', 'modified');
    } else if (pair.type === 'added' && decision === 'reject') {
      replaceOnce(pair.newText || '', '', 'added');
      content = compactBlankLines(content);
    } else if (pair.type === 'removed' && decision === 'reject') {
      insertNearContext(i, pair.oldText || '');
      content = compactBlankLines(content);
    }
  }

  return compactBlankLines(content);
}
