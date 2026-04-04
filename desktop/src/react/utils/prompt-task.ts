import type { PromptImage, UserAttachment } from '../stores/chat-types';
import type { AttachedFile, ComposerDraft, QuotedSelection, WorkingSetFile } from '../stores/input-slice';
import { isImageFile } from './format';
import {
  buildQuotedSelectionSummary,
  fileToWorkingSet,
  formatQuotedSelectionPrompt,
  mergeWorkingSetFiles,
} from './composer-state';

export type ComposerTaskMode = 'prompt' | 'steer';

export interface GitContextSnapshot {
  available: boolean;
  root: string;
  repoName: string;
  branch: string | null;
  detached?: boolean;
  ahead?: number;
  behind?: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  totalChanged: number;
  changedFiles: readonly string[];
  recentCommits: readonly string[];
}

export interface PreparedComposerTask {
  submission: {
    mode: ComposerTaskMode;
    text: string;
    displayText: string;
    requestText: string;
    quotedText?: string;
    quotedSelection?: QuotedSelection | null;
    retryDraft: ComposerDraft;
    attachments?: UserAttachment[];
    images?: PromptImage[];
  };
  draft: ComposerDraft;
  docForRender: { path: string; name: string } | null;
  otherFiles: Array<{ path: string; name: string; isDirectory?: boolean }>;
}

export interface PrepareComposerTaskOptions {
  mode: ComposerTaskMode;
  composerText: string;
  attachedFiles: AttachedFile[];
  docContextAttached: boolean;
  currentDoc: { path: string; name: string } | null;
  quotedSelection: QuotedSelection | null;
  workingSetRecentFiles: WorkingSetFile[];
  supportsVision: boolean;
  gitContext?: GitContextSnapshot | null;
  readFileBase64?: (path: string) => Promise<string | null | undefined>;
}

export function buildAttachmentMeta(attachedFiles: Array<{ path: string; name: string; isDirectory?: boolean }>): {
  otherFiles: Array<{ path: string; name: string; isDirectory?: boolean }>;
  workingSet: WorkingSetFile[];
} {
  const otherFiles = attachedFiles.filter((file) => !!file.isDirectory || !isImageFile(file.name));
  const workingSet = otherFiles.map((file) =>
    fileToWorkingSet({ path: file.path, name: file.name }, file.isDirectory ? 'desk' : 'recent', !!file.isDirectory),
  );
  return { otherFiles, workingSet };
}

export function summarizeGitContext(gitContext: GitContextSnapshot | null | undefined): string | null {
  if (!gitContext?.available) return null;
  const branch = gitContext.branch || (gitContext.detached ? 'detached' : null);
  const changeLabel = `${gitContext.totalChanged} changed`;
  const syncBits: string[] = [];
  if (gitContext.ahead) syncBits.push(`↑${gitContext.ahead}`);
  if (gitContext.behind) syncBits.push(`↓${gitContext.behind}`);
  return [gitContext.repoName, branch, changeLabel, syncBits.join(' ')].filter(Boolean).join(' · ');
}

export function formatGitContextPrompt(gitContext: GitContextSnapshot | null | undefined): string {
  if (!gitContext?.available) return '';

  const headerFields = [
    `repo=${gitContext.repoName}`,
    `branch=${gitContext.branch || (gitContext.detached ? 'detached' : 'unknown')}`,
    `changed=${gitContext.totalChanged}`,
    `staged=${gitContext.stagedCount}`,
    `unstaged=${gitContext.unstagedCount}`,
    `untracked=${gitContext.untrackedCount}`,
    `ahead=${gitContext.ahead || 0}`,
    `behind=${gitContext.behind || 0}`,
  ];

  const lines = [
    `[Git 上下文] ${headerFields.join('; ')}`,
    `[Git 根目录] ${gitContext.root}`,
  ];

  for (const file of gitContext.changedFiles || []) {
    lines.push(`[Git 变更] ${file}`);
  }

  for (const commit of gitContext.recentCommits || []) {
    lines.push(`[Git 提交] ${commit}`);
  }

  return lines.join('\n');
}

export async function prepareComposerTask({
  mode,
  composerText,
  attachedFiles,
  docContextAttached,
  currentDoc,
  quotedSelection,
  workingSetRecentFiles,
  supportsVision,
  gitContext,
  readFileBase64,
}: PrepareComposerTaskOptions): Promise<PreparedComposerTask> {
  const text = composerText.trim();
  const richContextEnabled = mode === 'prompt';
  const imageFiles = richContextEnabled
    ? attachedFiles.filter((file) => !file.isDirectory && isImageFile(file.name) && supportsVision)
    : [];
  const otherFiles = richContextEnabled
    ? attachedFiles.filter((file) => file.isDirectory || !isImageFile(file.name) || !supportsVision)
    : [];
  const docForRender = richContextEnabled && docContextAttached && currentDoc ? currentDoc : null;
  const quotedSummary = richContextEnabled && quotedSelection ? buildQuotedSelectionSummary(quotedSelection) : undefined;
  const quotedForSend = richContextEnabled && quotedSelection ? { ...quotedSelection } : null;

  let requestText = text;
  if (richContextEnabled && otherFiles.length > 0) {
    const fileBlock = otherFiles.map((file) => (file.isDirectory ? `[目录] ${file.path}` : `[附件] ${file.path}`)).join('\n');
    requestText = text ? `${text}\n\n${fileBlock}` : fileBlock;
  }

  if (richContextEnabled && docForRender) {
    requestText = requestText ? `${requestText}\n\n[参考文档] ${docForRender.path}` : `[参考文档] ${docForRender.path}`;
  }

  if (richContextEnabled && gitContext?.available) {
    const gitBlock = formatGitContextPrompt(gitContext);
    requestText = requestText ? `${requestText}\n\n${gitBlock}` : gitBlock;
  }

  if (richContextEnabled && quotedSelection) {
    const quotedPrompt = formatQuotedSelectionPrompt(quotedSelection);
    requestText = requestText ? `${requestText}\n\n${quotedPrompt}` : quotedPrompt;
  }

  const workingSet = mergeWorkingSetFiles(
    workingSetRecentFiles,
    buildAttachmentMeta(attachedFiles).workingSet,
    docForRender ? [fileToWorkingSet(docForRender, 'current')] : [],
  );

  const draft: ComposerDraft = {
    text: composerText,
    attachedFiles: attachedFiles.map((file) => ({ ...file })),
    quotedSelection: quotedSelection ? { ...quotedSelection } : null,
    docContextFile: docForRender ? { ...docForRender } : null,
    workingSet,
  };

  if (!richContextEnabled) {
    return {
      submission: {
        mode,
        text: composerText,
        displayText: composerText,
        requestText: text,
        retryDraft: draft,
      },
      draft,
      docForRender: null,
      otherFiles: [],
    };
  }

  const images: PromptImage[] = [];
  const imageAttachmentCache = new Map<string, { base64Data: string; mimeType: string }>();

  for (const img of imageFiles) {
    try {
      if (img.base64Data && img.mimeType) {
        imageAttachmentCache.set(img.path, { base64Data: img.base64Data, mimeType: img.mimeType });
        images.push({ type: 'image', data: img.base64Data, mimeType: img.mimeType });
      } else if (readFileBase64) {
        const base64 = await readFileBase64(img.path);
        if (base64) {
          const ext = img.name.toLowerCase().replace(/^.*\./, '');
          const mimeMap: Record<string, string> = {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
            bmp: 'image/bmp',
            svg: 'image/svg+xml',
          };
          const mimeType = mimeMap[ext] || 'image/png';
          imageAttachmentCache.set(img.path, { base64Data: base64, mimeType });
          images.push({ type: 'image', data: base64, mimeType });
        } else {
          requestText = requestText ? `${requestText}\n\n[附件] ${img.path}` : `[附件] ${img.path}`;
        }
      }
    } catch {
      requestText = requestText ? `${requestText}\n\n[附件] ${img.path}` : `[附件] ${img.path}`;
    }
  }

  const attachments: UserAttachment[] = [];
  const displayAttachments = [...attachedFiles];
  if (docForRender) {
    displayAttachments.push({ path: docForRender.path, name: docForRender.name });
  }

  for (const file of displayAttachments) {
    const cached = imageAttachmentCache.get(file.path);
    attachments.push({
      path: file.path,
      name: file.name,
      isDir: !!file.isDirectory,
      base64Data: file.base64Data || cached?.base64Data || undefined,
      mimeType: file.mimeType || cached?.mimeType || undefined,
    });
  }

  return {
    submission: {
      mode,
      text: composerText,
      displayText: composerText,
      requestText,
      quotedText: quotedSummary,
      quotedSelection: quotedForSend,
      retryDraft: draft,
      attachments: attachments.length > 0 ? attachments : undefined,
      images: images.length > 0 ? images : undefined,
    },
    draft,
    docForRender,
    otherFiles,
  };
}
