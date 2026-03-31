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
import { DiffViewer } from './DiffViewer';
import type { ChatMessage, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { openFilePreview, openSkillPreview } from '../../utils/file-preview';
import { openPreview } from '../../stores/artifact-actions';
import styles from './Chat.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
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

export const AssistantMessage = memo(function AssistantMessage({ message, showAvatar }: Props) {
  const agentName = useStore(s => s.agentName) || 'Lynn';
  const agentYuan = useStore(s => s.agentYuan) || 'lynn';
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const sessionAgent = useStore(s => s.sessionAgent);
  const [avatarFailed, setAvatarFailed] = useState(false);

  // 非主 agent session 用 sessionAgent 信息
  const displayName = sessionAgent?.name || agentName;
  const displayYuan = sessionAgent?.yuan || agentYuan;
  const fallbackAvatar = useMemo(() => {
    const types = (window.t?.('yuan.types') || {}) as Record<string, { avatar?: string }>;
    const entry = types[displayYuan] || types['hanako'];
    return `assets/${entry?.avatar || 'Lynn.png'}`;
  }, [displayYuan]);
  const avatarSrc = sessionAgent?.avatarUrl || agentAvatarUrl || fallbackAvatar;

  useEffect(() => {
    setAvatarFailed(false);
  }, [sessionAgent?.avatarUrl, agentAvatarUrl, fallbackAvatar]);

  const blocks = message.blocks || [];
  const currentModel = useStore(s => s.currentModel);
  const { running: runningTools, total: totalTools } = useMemo(() => summarizeToolState(blocks), [blocks]);
  const showStreamingMeta = !!message.id?.startsWith('stream-') && (runningTools > 0 || blocks.some(block => block.type === 'thinking' && !block.sealed));

  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const textBlocks = blocks.filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text');
    if (textBlocks.length === 0) return;
    // eslint-disable-next-line no-restricted-syntax -- temp div for HTML-to-text extraction (clipboard)
    const tmp = document.createElement('div');
    tmp.innerHTML = textBlocks.map(b => b.html).join('\n');
    const text = tmp.innerText.trim();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {}); // clipboard may reject without focus/permission — non-critical
  }, [blocks]);

  const handleRetry = useCallback(() => {
    const state = useStore.getState();
    const sessionPath = state.currentSessionPath;
    if (!sessionPath) return;
    const chatSession = state.chatSessions[sessionPath];
    if (!chatSession?.items) return;
    // Find the last user message before this assistant message
    let lastUserText = '';
    for (let i = chatSession.items.length - 1; i >= 0; i--) {
      const item = chatSession.items[i];
      if (item.type === 'message' && item.data.id === message.id) {
        for (let j = i - 1; j >= 0; j--) {
          const prev = chatSession.items[j];
          if (prev.type === 'message' && prev.data.role === 'user' && prev.data.text) {
            lastUserText = prev.data.text;
            break;
          }
        }
        break;
      }
    }
    if (!lastUserText) return;
    const ws = (window as any).__hanaWs;
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: 'prompt', text: lastUserText, sessionPath }));
    }
  }, [message.id]);

  const isLastAssistant = useMemo(() => {
    const state = useStore.getState();
    const sessionPath = state.currentSessionPath;
    if (!sessionPath) return false;
    const items = state.chatSessions[sessionPath]?.items;
    if (!items) return false;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'message' && item.data.role === 'assistant') return item.data.id === message.id;
    }
    return false;
  }, [message.id, blocks]);

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
          <ContentBlockView key={`block-${i}`} block={block} agentName={displayName} yuan={displayYuan} />
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

// ── ContentBlock 分发 ──

const ContentBlockView = memo(function ContentBlockView({ block, agentName, yuan }: {
  block: ContentBlock;
  agentName: string;
  yuan: string;
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
    default:
      return null;
  }
});

// ── 简单子块组件 ──

const EXT_LABELS: Record<string, string> = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel',
  ppt: 'Presentation', pptx: 'Presentation', md: 'Markdown', txt: 'Text',
  html: 'HTML', htm: 'HTML', css: 'Stylesheet', json: 'JSON', yaml: 'YAML', yml: 'YAML',
  js: 'JavaScript', ts: 'TypeScript', jsx: 'React', tsx: 'React',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', rb: 'Ruby', php: 'PHP',
  c: 'C', cpp: 'C++', h: 'Header', sh: 'Shell', sql: 'SQL', xml: 'XML',
  csv: 'CSV', svg: 'SVG', skill: 'Skill',
  png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', webp: 'Image',
};

const FileOutputCard = memo(function FileOutputCard({ filePath, label, ext }: { filePath: string; label: string; ext: string }) {
  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    const p = window.platform;
    if (p?.openFile) p.openFile(filePath);
  };

  const displayName = label || filePath.split('/').pop() || filePath;
  const typeLabel = EXT_LABELS[ext] || ext.toUpperCase();

  return (
    <div className={`${styles.fileOutputCard} ${styles.fileOutputPreviewable}`} onClick={() => openFilePreview(filePath, label, ext)} style={{ cursor: 'pointer' }}>
      <div className={styles.fileOutputIcon}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </div>
      <div className={styles.fileOutputInfo}>
        <div className={styles.fileOutputName}>{displayName}</div>
        <div className={styles.fileOutputType}>{typeLabel}{ext ? ` \u00b7 ${ext.toUpperCase()}` : ''}</div>
      </div>
      <button className={styles.fileOutputOpen} onClick={handleOpen} title={window.t('desk.openWithDefault')}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </button>
    </div>
  );
});

const ArtifactCard = memo(function ArtifactCard({ title, artifactType, artifactId, content, language }: {
  title: string; artifactType: string; artifactId: string; content: string; language?: string;
}) {
  const handleClick = () => {
    const artifact = { id: artifactId, type: artifactType, title, content, language };
    const s = useStore.getState();
    const arts = [...s.artifacts];
    const idx = arts.findIndex(a => a.id === artifactId);
    if (idx >= 0) arts[idx] = artifact;
    else arts.push(artifact);
    s.setArtifacts(arts);
    openPreview(artifact);
  };

  return (
    <div className={styles.artifactCard} onClick={handleClick} style={{ cursor: 'pointer' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
      </svg>
      <span>{title || artifactType}</span>
    </div>
  );
});

const SkillCard = memo(function SkillCard({ skillName, skillFilePath }: { skillName: string; skillFilePath: string }) {
  return (
    <div className={styles.skillCard} onClick={() => openSkillPreview(skillName, skillFilePath)} style={{ cursor: 'pointer' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
      <span>{skillName}</span>
    </div>
  );
});

const BrowserScreenshot = memo(function BrowserScreenshot({ base64, mimeType }: { base64: string; mimeType: string }) {
  const handleClick = () => {
    const artId = `browser-ss-${Date.now()}`;
    const artifact = {
      id: artId,
      type: 'image',
      title: window.t('chat.browserScreenshot'),
      content: base64,
      ext: mimeType === 'image/jpeg' ? 'jpg' : 'png',
    };
    const s = useStore.getState();
    const arts = [...s.artifacts];
    if (!arts.find(a => a.id === artId)) arts.push(artifact);
    s.setArtifacts(arts);
    openPreview(artifact);
  };

  return (
    <div className={styles.browserScreenshot} onClick={handleClick} style={{ cursor: 'pointer' }}>
      <img src={`data:${mimeType};base64,${base64}`} alt={window.t('chat.browserScreenshot')} />
    </div>
  );
});

const CronConfirmCard = memo(function CronConfirmCard({ confirmId, jobData, status: initialStatus }: { confirmId?: string; jobData: Record<string, unknown>; status: string }) {
  const [status, setStatus] = useState(initialStatus);
  const label = (jobData.label as string) || (jobData.prompt as string)?.slice(0, 40) || '';

  const handleApprove = async () => {
    try {
      if (confirmId) {
        await hanaFetch(`/api/confirm/${confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'confirmed' }),
        });
      } else {
        await hanaFetch('/api/desk/cron', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add', ...jobData }),
        });
      }
      setStatus('approved');
    } catch { /* silent */ }
  };

  const handleReject = async () => {
    if (confirmId) {
      try {
        await hanaFetch(`/api/confirm/${confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rejected' }),
        });
      } catch { /* silent */ }
    }
    setStatus('rejected');
  };

  if (status !== 'pending') {
    return (
      <div className={styles.cronConfirmCard}>
        <div className={styles.cronConfirmTitle}>{label}</div>
        <div className={`${styles.cronConfirmStatus} ${status === 'approved' ? styles.cronConfirmStatusApproved : styles.cronConfirmStatusRejected}`}>
          {status === 'approved' ? window.t('common.approved') : window.t('common.rejected')}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.cronConfirmCard}>
      <div className={styles.cronConfirmTitle}>{label}</div>
      <div className={styles.cronConfirmActions}>
        <button className={`${styles.cronConfirmBtn} ${styles.cronConfirmBtnApprove}`} onClick={handleApprove}>{window.t('common.approve')}</button>
        <button className={`${styles.cronConfirmBtn} ${styles.cronConfirmBtnReject}`} onClick={handleReject}>{window.t('common.reject')}</button>
      </div>
    </div>
  );
});
