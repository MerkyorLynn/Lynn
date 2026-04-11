/**
 * UserMessage — 用户消息气泡
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { ImageBlock } from './ImageBlock';
import { AttachmentChip } from '../shared/AttachmentChip';
import type { ChatMessage, UserAttachment, DeskContext, GitContext } from '../../stores/chat-types';
import { useStore } from '../../stores';
import styles from './Chat.module.css';

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
}

export const UserMessage = memo(function UserMessage({ message, showAvatar }: Props) {
  const userAvatarUrl = useStore(s => s.userAvatarUrl);
  const t = window.t ?? ((p: string) => p);
  const tt = (key: string, fallback: string) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  };
  const userName = useStore(s => s.userName) || t('common.me');
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setAvatarFailed(false);
  }, [userAvatarUrl]);

  const handleCopy = useCallback(() => {
    const text = String(message.text || '').trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [message.text]);

  const handlePasteToInput = useCallback(() => {
    const text = String(message.text || '').trim();
    if (!text) return;
    window.dispatchEvent(new CustomEvent('hana-paste-to-input', {
      detail: { text, source: 'user-message' },
    }));
  }, [message.text]);

  return (
    <div className={`${styles.messageGroup} ${styles.messageGroupUser}`}>
      {showAvatar && (
        <div className={`${styles.avatarRow} ${styles.avatarRowUser}`}>
          <span className={styles.avatarName}>{userName}</span>
          {userAvatarUrl && !avatarFailed ? (
            <img
              className={styles.avatar}
              src={userAvatarUrl}
              alt={userName}
              draggable={false}
              onError={() => setAvatarFailed(true)}
              style={{ objectFit: 'cover' }}
            />
          ) : (
            <span className={`${styles.avatar} ${styles.userAvatar}`}>
              <DefaultUserAvatarIcon />
            </span>
          )}
        </div>
      )}
      {message.quotedText && (
        <div className={styles.userAttachments}>
          <AttachmentChip
            icon={<GridIcon />}
            name={message.quotedText}
          />
        </div>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <UserAttachmentsView attachments={message.attachments} deskContext={message.deskContext} gitContext={message.gitContext} />
      )}
      {!message.attachments?.length && message.gitContext && (
        <div className={styles.userAttachments}>
          <GitContextChip gitContext={message.gitContext} />
        </div>
      )}
      <div className={`${styles.message} ${styles.messageUser}`}>
        {message.textHtml && <MarkdownContent html={message.textHtml} stateKey={message.id} />}
      </div>
      {!!String(message.text || '').trim() && (
        <div className={`${styles.messageActionRail} ${styles.messageActionRailUser}`}>
          <div className={styles.messageActionRailIcons}>
            <button
              className={`${styles.msgCopyBtn}${copied ? ` ${styles.msgCopyBtnCopied}` : ''}`}
              onClick={handleCopy}
              title={t('common.copyText')}
              aria-label={t('common.copyText')}
            >
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
            <button
              className={`${styles.msgCopyBtn} ${styles.msgPasteBtn}`}
              onClick={handlePasteToInput}
              title={tt('common.pasteToInputTitle', '粘贴到输入框')}
              aria-label={tt('common.pasteToInputTitle', '粘贴到输入框')}
            >
              {tt('common.pasteToInput', '粘贴')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

// ── 附件区 ──

const VISIBLE_THRESHOLD = 2;

const UserAttachmentsView = memo(function UserAttachmentsView({ attachments, deskContext, gitContext }: {
  attachments: UserAttachment[];
  deskContext?: DeskContext | null;
  gitContext?: GitContext | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const isImage = useCallback((att: UserAttachment) => {
    return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(att.name);
  }, []);

  const t = window.t ?? ((p: string) => p);

  const images = attachments.filter((att) => isImage(att) && att.base64Data);
  const files = attachments.filter((att) => !(isImage(att) && att.base64Data));
  const visibleFiles = expanded ? files : files.slice(0, VISIBLE_THRESHOLD);
  const hiddenCount = files.length - VISIBLE_THRESHOLD;

  return (
    <div className={styles.userAttachments}>
      {images.map((att, i) => (
        <ImageBlock
          key={att.name || `img-${i}`}
          className={styles.attachImage}
          src={`data:${att.mimeType || 'image/png'};base64,${att.base64Data}`}
          alt={att.name}
        />
      ))}
      {visibleFiles.map((att, i) => (
        <AttachmentChip
          key={att.name || `att-${i}`}
          icon={att.isDir ? <FolderIcon /> : <FileIcon />}
          name={att.name}
        />
      ))}
      {!expanded && hiddenCount > 0 && (
        <button
          type="button"
          className={styles.attachMoreBtn}
          onClick={() => setExpanded(true)}
        >
          +{hiddenCount}
        </button>
      )}
      {expanded && hiddenCount > 0 && (
        <button
          type="button"
          className={styles.attachMoreBtn}
          onClick={() => setExpanded(false)}
        >
          ▲
        </button>
      )}
      {deskContext && (
        <AttachmentChip
          icon={<FolderIcon />}
          name={`${t('sidebar.jian')} (${deskContext.fileCount})`}
        />
      )}
      {gitContext && <GitContextChip gitContext={gitContext} />}
    </div>
  );
});

const GitContextChip = memo(function GitContextChip({ gitContext }: { gitContext: GitContext }) {
  const label = [
    gitContext.repoName,
    gitContext.branch,
    gitContext.changedCount != null ? `${gitContext.changedCount} changed` : null,
  ].filter(Boolean).join(' · ');

  return (
    <AttachmentChip
      icon={<GitIcon />}
      name={label || 'Git'}
    />
  );
});

// ── Icons ──

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="4" x2="6" y2="20" />
      <line x1="18" y1="4" x2="18" y2="20" />
      <line x1="6" y1="8" x2="18" y2="8" />
      <line x1="6" y1="16" x2="18" y2="16" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function DefaultUserAvatarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="8.2" r="3.4" fill="currentColor" opacity="0.88" />
      <path
        d="M5.4 19.2c.72-3.7 3.12-5.72 6.6-5.72s5.88 2.02 6.6 5.72"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function GitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 4 9l8 6 8-6-8-6Z" />
      <path d="M4 15l8 6 8-6" />
      <path d="M12 9v12" />
    </svg>
  );
}
