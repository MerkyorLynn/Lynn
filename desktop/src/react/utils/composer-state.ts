import type { ChatMessage, UserAttachment } from '../stores/chat-types';
import type { AttachedFile, DocContextFile, QuotedSelection, WorkingSetFile, ComposerDraft } from '../stores/input-slice';

export const PENDING_COMPOSER_KEY = '__pending__';

const LEGACY_DOC_CONTEXT_TITLES = new Set([
  '看着文档说',
  '看著文件說',
  'With document',
  'ドキュメント付き',
  '문서 포함',
]);

export function getComposerSessionKey(sessionPath: string | null, pendingNewSession = false): string {
  if (pendingNewSession || !sessionPath) return PENDING_COMPOSER_KEY;
  return sessionPath;
}

export function attachmentToDraftFile(file: UserAttachment): AttachedFile {
  return {
    path: file.path,
    name: file.name,
    isDirectory: file.isDir,
    base64Data: file.base64Data,
    mimeType: file.mimeType,
  };
}

export function buildQuotedSelectionSummary(selection: QuotedSelection): string {
  const range = selection.lineStart != null && selection.lineEnd != null
    ? `L${selection.lineStart}-${selection.lineEnd}`
    : null;
  const path = selection.sourceFilePath || selection.sourceTitle;
  const meta = [path, range, `${selection.charCount} chars`].filter(Boolean).join(' · ');
  return meta;
}

export function formatQuotedSelectionPrompt(selection: QuotedSelection): string {
  const path = selection.sourceFilePath || selection.sourceTitle;
  const range = selection.lineStart != null && selection.lineEnd != null
    ? `行 ${selection.lineStart}-${selection.lineEnd}`
    : null;
  const meta = [path, range, `${selection.charCount} 字符`].filter(Boolean).join(' · ');
  return `[引用片段] ${meta}\n${selection.text}`;
}

export function cloneQuotedSelection(selection: QuotedSelection | null | undefined): QuotedSelection | null {
  if (!selection) return null;
  return { ...selection };
}

export function sanitizeQuotedSelection(selection: QuotedSelection | null | undefined): QuotedSelection | null {
  const next = cloneQuotedSelection(selection);
  if (!next) return null;

  const title = typeof next.sourceTitle === 'string' ? next.sourceTitle.trim() : '';
  if (!next.sourceFilePath && LEGACY_DOC_CONTEXT_TITLES.has(title)) {
    return null;
  }

  const text = typeof next.text === 'string' ? next.text : '';
  return {
    ...next,
    text,
    sourceTitle: title || 'Quoted selection',
    charCount: Number.isFinite(next.charCount) && next.charCount > 0
      ? next.charCount
      : text.length,
  };
}

export function buildRetryDraftFromMessage(message: ChatMessage): ComposerDraft {
  const retryDraft = message.retryDraft;
  if (retryDraft) {
    return {
      text: retryDraft.text || '',
      attachedFiles: (retryDraft.attachedFiles || []).map((file) => ({ ...file })),
      quotedSelection: sanitizeQuotedSelection(retryDraft.quotedSelection),
      docContextFile: null,
      workingSet: (retryDraft.workingSet || []).map((file) => ({ ...file })),
    };
  }

  const fallbackQuoted = message.quotedSelection
    ? sanitizeQuotedSelection(message.quotedSelection)
    : message.quotedText
      ? sanitizeQuotedSelection({
          text: message.quotedText,
          sourceTitle: message.text?.slice(0, 24) || 'Quoted selection',
          charCount: message.quotedText.length,
        })
      : null;

  const attachedFiles = (message.attachments || []).map(attachmentToDraftFile);
  const workingSet: WorkingSetFile[] = attachedFiles.map((file) => ({
    path: file.path,
    name: file.name,
    source: file.isDirectory ? 'desk' : 'recent',
    isDirectory: !!file.isDirectory,
  }));

  return {
    text: message.text || '',
    attachedFiles,
    quotedSelection: fallbackQuoted,
    docContextFile: null,
    workingSet,
  };
}

export function mergeWorkingSetFiles(...groups: Array<WorkingSetFile[] | null | undefined>): WorkingSetFile[] {
  const seen = new Set<string>();
  const merged: WorkingSetFile[] = [];
  for (const group of groups) {
    for (const file of group || []) {
      if (!file?.path || seen.has(file.path)) continue;
      seen.add(file.path);
      merged.push(file);
    }
  }
  return merged;
}

export function toggleComposerAttachment(files: AttachedFile[], file: AttachedFile): AttachedFile[] {
  if (files.some((entry) => entry.path === file.path)) {
    return files.filter((entry) => entry.path !== file.path);
  }
  return [...files, { ...file }];
}

export function resolveDocContextToggle(
  activePath: string | null | undefined,
  targetFile: DocContextFile | null | undefined,
): { attached: boolean; file: DocContextFile | null } {
  const normalizedTarget = cloneDocContextFile(targetFile);
  if (!normalizedTarget) {
    return { attached: false, file: null };
  }
  if (activePath && activePath === normalizedTarget.path) {
    return { attached: false, file: null };
  }
  return { attached: true, file: normalizedTarget };
}

export function fileToWorkingSet(file: { path: string; name: string }, source: WorkingSetFile['source'], isDirectory = false): WorkingSetFile {
  return { path: file.path, name: file.name, source, isDirectory };
}

export function cloneDocContextFile(file: DocContextFile | null | undefined): DocContextFile | null {
  return file ? { ...file } : null;
}
