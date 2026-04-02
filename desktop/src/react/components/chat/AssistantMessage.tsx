/**
 * AssistantMessage — 助手消息，遍历 ContentBlock 按类型渲染
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { MoodBlock } from './MoodBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolGroupBlock } from './ToolGroupBlock';
import { XingCard } from './XingCard';
import { SettingsConfirmCard } from './SettingsConfirmCard';
import { AuthorizationCard } from './AuthorizationCard';
import { DiffViewer } from './DiffViewer';
import type { ChatMessage, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { openFilePreview, openSkillPreview } from '../../utils/file-preview';
import { openPreview } from '../../stores/artifact-actions';
import { resolveBundledAvatar } from '../../utils/agent-helpers';
import { buildRetryDraftFromMessage } from '../../utils/composer-state';
import { resendPromptRequest } from '../../stores/prompt-actions';
import styles from './Chat.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
  isLastAssistant: boolean;
}

function summarizeToolState(blocks: ContentBlock[]): { running: number; total: number } {
  let running = 0;
  let total = 0;
  for (const block of blocks) {
    if (block.type !== 'tool_group') continue;
    total += block.tools.length;
    running += block.tools.filter(tool => !tool.done).length;
  }
  return { running, total };
}

export const AssistantMessage = memo(function AssistantMessage({ message, showAvatar, isLastAssistant }: Props) {
  const agentName = useStore(s => s.agentName) || 'Lynn';
  const agentYuan = useStore(s => s.agentYuan) || 'hanako';
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const sessionAgent = useStore(s => s.sessionAgent);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const displayName = sessionAgent?.name || agentName;
  const displayYuan = sessionAgent?.yuan || agentYuan;
  const fallbackAvatar = useMemo(() => {
    const types = (window.t?.('yuan.types') || {}) as Record<string, { avatar?: string }>;
    const entry = types[displayYuan] || types['hanako'];
    return resolveBundledAvatar(entry?.avatar || 'Lynn.png');
  }, [displayYuan]);
  const avatarSrc = sessionAgent?.avatarUrl || agentAvatarUrl || fallbackAvatar;

  useEffect(() => {
    setAvatarFailed(false);
  }, [sessionAgent?.avatarUrl, agentAvatarUrl, fallbackAvatar]);

  const blocks = useMemo(() => message.blocks || [], [message.blocks]);
  const currentModel = useStore(s => s.currentModel);
  const { running: runningTools, total: totalTools } = useMemo(() => summarizeToolState(blocks), [blocks]);
  const showStreamingMeta = !!message.id?.startsWith('stream-') && (runningTools > 0 || blocks.some(block => block.type === 'thinking' && !block.sealed));

  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const textBlocks = blocks.filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text');
    if (textBlocks.length === 0) return;
    const parser = new DOMParser();
    const text = textBlocks
      .map((block) => {
        const doc = parser.parseFromString(block.html, 'text/html');
        return (doc.body.innerText || doc.body.textContent || '').trim();
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [blocks]);

  const handleRetry = useCallback(() => {
    const state = useStore.getState();
    const sessionPath = state.currentSessionPath;
    if (!sessionPath) return;
    const chatSession = state.chatSessions[sessionPath];
    if (!chatSession?.items) return;

    for (let i = chatSession.items.length - 1; i >= 0; i--) {
      const item = chatSession.items[i];
      if (item.type !== 'message' || item.data.id !== message.id) continue;
      for (let j = i - 1; j >= 0; j--) {
        const prev = chatSession.items[j];
        if (prev.type !== 'message' || prev.data.role !== 'user') continue;
        if (prev.data.requestText) {
          if (resendPromptRequest(prev.data.requestText, prev.data.requestImages, sessionPath)) {
            return;
          }
        }
        const draft = buildRetryDraftFromMessage(prev.data);
        state.applyComposerDraft(draft);
        state.requestInputFocus();
        return;
      }
      return;
    }
  }, [message.id]);


  return (
    <div className={`${styles.messageGroup} ${styles.messageGroupAssistant}`}>
      {showAvatar && (
        <div className={styles.avatarRow}>
          {!avatarFailed ? (
            <img
              className={`${styles.avatar} ${styles.hanaAvatar}`}
              src={avatarSrc}
              alt={displayName}
              draggable={false}
              onError={(e) => {
                const img = e.target as HTMLImageElement;
                if (img.src.endsWith(fallbackAvatar)) {
                  img.onerror = null;
                  setAvatarFailed(true);
                  return;
                }
                img.onerror = null;
                img.src = fallbackAvatar;
              }}
            />
          ) : (
            <span className={`${styles.avatar} ${styles.userAvatar}`}>🌸</span>
          )}
          <span className={styles.avatarName}>{displayName}</span>
          {currentModel?.id && (
            <span className={styles.avatarMeta}>
              {currentModel.provider ? currentModel.provider + ' / ' : ''}{currentModel.id}
            </span>
          )}
          {showStreamingMeta && (
            <span className={styles.avatarMeta}>
              {runningTools > 0 ? 'tools ' + runningTools + '/' + totalTools : 'thinking'}
            </span>
          )}
        </div>
      )}
      <div className={`${styles.message} ${styles.messageAssistant}`}>
        {blocks.map((block, i) => (
          <ContentBlockView key={`block-${i}`} block={block} agentName={displayName} />
        ))}
      </div>
      <button className={`${styles.msgCopyBtn}${copied ? ` ${styles.msgCopyBtnCopied}` : ''}`} onClick={handleCopy} title={t('common.copyText')} aria-label={t('common.copyText')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          {copied
            ? <polyline points="20 6 9 17 4 12" />
            : <>
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </>
          }
        </svg>
      </button>
      {isLastAssistant && (
        <button className={styles.msgCopyBtn} onClick={handleRetry} title={t('chat.retry') || 'Retry'} aria-label={t('chat.retry') || 'Retry'}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>
      )}
    </div>
  );
});

const ContentBlockView = memo(function ContentBlockView({ block, agentName }: {
  block: ContentBlock;
  agentName: string;
}) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock content={block.content} sealed={block.sealed} />;
    case 'mood':
      return <MoodBlock yuan={block.yuan} text={block.text} />;
    case 'tool_group':
      return <ToolGroupBlock tools={block.tools} collapsed={block.collapsed} />;
    case 'text':
      return <MarkdownContent html={block.html} />;
    case 'xing':
      return <XingCard title={block.title} content={block.content} sealed={block.sealed} agentName={agentName} />;
    case 'file_output':
      return <FileOutputCard filePath={block.filePath} label={block.label} ext={block.ext} />;
    case 'file_diff':
      return <DiffViewer filePath={block.filePath} diff={block.diff} linesAdded={block.linesAdded} linesRemoved={block.linesRemoved} />;
    case 'artifact':
      return <ArtifactCard title={block.title} artifactType={block.artifactType} artifactId={block.artifactId} content={block.content} language={block.language} />;
    case 'browser_screenshot':
      return <BrowserScreenshot base64={block.base64} mimeType={block.mimeType} />;
    case 'skill':
      return <SkillCard skillName={block.skillName} skillFilePath={block.skillFilePath} />;
    case 'cron_confirm':
      return <CronConfirmCard confirmId={(block as any).confirmId} jobData={block.jobData} status={block.status} />;
    case 'settings_confirm':
      return <SettingsConfirmCard {...block} />;
    case 'tool_authorization':
      return <AuthorizationCard
        confirmId={(block as any).confirmId}
        command={(block as any).command}
        reason={(block as any).reason}
        description={(block as any).description}
        category={(block as any).category}
        identifier={(block as any).identifier}
        status={(block as any).status}
      />;
    default:
      return null;
  }
});

const EXT_LABELS: Record<string, string> = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel',
  ppt: 'Presentation', pptx: 'Presentation', md: 'Markdown', txt: 'Text',
  html: 'HTML', htm: 'HTML', css: 'Stylesheet', json: 'JSON', yaml: 'YAML', yml: 'YAML',
};

function extLabel(ext: string): string {
  return EXT_LABELS[ext.toLowerCase()] || ext.toUpperCase();
}

function FileOutputCard({ filePath, label, ext }: { filePath: string; label: string; ext: string }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className={styles.fileOutputCard}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className={styles.fileOutputHead}>
        <span className={styles.fileOutputIcon}>📄</span>
        <span className={styles.fileOutputName}>{label || filePath.split('/').pop() || filePath}</span>
        <span className={styles.fileOutputExt}>{extLabel(ext)}</span>
      </div>
      {hover && (
        <div className={styles.fileOutputActions}>
          <button onClick={() => openFilePreview(filePath, label, ext)}>{window.t?.('common.preview') || 'Preview'}</button>
          <button onClick={() => window.platform?.showInFinder?.(filePath)}>{window.t?.('desk.openInFinder') || 'Show in Finder'}</button>
        </div>
      )}
    </div>
  );
}

function ArtifactCard({ title, artifactType, artifactId, content, language }: { title: string; artifactType: string; artifactId: string; content: string; language?: string }) {
  const handleOpen = useCallback(() => {
    openPreview({ id: artifactId, type: artifactType, title, content, language });
  }, [artifactId, artifactType, title, content, language]);

  return (
    <button className={styles.artifactCard} onClick={handleOpen}>
      <span className={styles.artifactIcon}>✦</span>
      <span className={styles.artifactTitle}>{title}</span>
      <span className={styles.artifactType}>{artifactType}</span>
    </button>
  );
}

function BrowserScreenshot({ base64, mimeType }: { base64: string; mimeType: string }) {
  return <img className={styles.browserShot} src={`data:${mimeType};base64,${base64}`} alt="browser screenshot" />;
}

function SkillCard({ skillName, skillFilePath }: { skillName: string; skillFilePath: string }) {
  return (
    <button className={styles.skillCard} onClick={() => openSkillPreview(skillName, skillFilePath)}>
      <span className={styles.skillIcon}>✧</span>
      <span className={styles.skillName}>{skillName}</span>
    </button>
  );
}

function CronConfirmCard({ confirmId, jobData, status }: { confirmId?: string; jobData: Record<string, unknown>; status: string }) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);

  const sendDecision = useCallback(async (action: 'approve' | 'reject') => {
    if (!confirmId || submitting) return;
    setSubmitting(true);
    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action === 'approve' ? 'confirmed' : 'rejected' }),
      });
    } finally {
      setSubmitting(false);
    }
  }, [confirmId, submitting]);

  return (
    <div className={styles.confirmCard}>
      <div className={styles.confirmTitle}>{jobData.label as string || t('cron.typeCron')}</div>
      <div className={styles.confirmMeta}>{jobData.prompt as string}</div>
      {status === 'pending' && confirmId && (
        <div className={styles.confirmActions}>
          <button disabled={submitting} onClick={() => sendDecision('approve')}>{t('cron.confirm.approve')}</button>
          <button disabled={submitting} onClick={() => sendDecision('reject')}>{t('cron.confirm.reject')}</button>
        </div>
      )}
    </div>
  );
}
