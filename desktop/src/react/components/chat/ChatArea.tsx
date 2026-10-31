/**
 * ChatArea — 聊天消息列表（干净重写版）
 *
 * 原理：每个 session 一个原生滚动 div，visibility:hidden 保持 scrollTop。
 * 不用 Virtuoso，不用 Activity，不用快照，不用任何花活。
 */

import { memo, useRef, useEffect, useLayoutEffect, useState, useMemo } from 'react';
import { useStore } from '../../stores';
import { useWritingPreview } from '../../hooks/use-writing-preview';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ApplyCodeDialog } from './ApplyCodeDialog';
import type { ChatListItem } from '../../stores/chat-types';
import { findLastAssistantMessageId } from '../../utils/chat-list';
import styles from './Chat.module.css';
import { isInternalRecoveryPromptText } from '../../../../../shared/internal-control-message.js';
import { useI18n } from '../../hooks/use-i18n';
import { openBridgeSession } from '../../stores/bridge-actions';
import { loadOlderMessages } from '../../stores/session-actions';
import { HistoryPage } from './HistoryPage';

const MAX_ALIVE = 5;
const HEAVY_HISTORY_ITEM_THRESHOLD = 800;

// ── 入口 ──

export function ChatArea() {
  const [applyState, setApplyState] = useState<{ code: string; language?: string; anchorRect?: DOMRect } | null>(null);
  const activeBridgeKey = useStore(s => s.activeBridgeSessionKey);
  const welcomeVisible = useStore(s => s.welcomeVisible);

  // 写作模式：监听 MD 文件操作自动打开预览
  useWritingPreview();

  useEffect(() => {
    const handler = (e: Event) => {
      const { code, language, anchorRect } = (e as CustomEvent).detail;
      setApplyState({ code, language, anchorRect });
    };
    window.addEventListener('hana-apply-code', handler);
    return () => window.removeEventListener('hana-apply-code', handler);
  }, []);

  return (
    <>
      {activeBridgeKey && !welcomeVisible ? <BridgeChatView /> : <PanelHost />}
      {applyState && (
        <ApplyCodeDialog
          code={applyState.code}
          language={applyState.language}
          anchorRect={applyState.anchorRect}
          onClose={() => setApplyState(null)}
        />
      )}
    </>
  );
}

// ── BridgeChatView: display bridge session messages ──

function BridgeChatView() {
  const { t, locale } = useI18n();
  const loading = useStore(s => s.bridgeHistoryLoading);
  const error = useStore(s => s.bridgeHistoryError);
  const messages = useStore(s => s.activeBridgeMessages);
  const sessionKey = useStore(s => s.activeBridgeSessionKey);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages]);

  if (!sessionKey) return null;

  return (
    <div ref={ref} className={styles.sessionPanel} style={{ visibility: 'visible', zIndex: 1, pointerEvents: 'auto', opacity: 1 }}>
      <div className={styles.sessionMessages}>
        {(loading || error) && <div role={error ? 'alert' : 'status'} style={{ padding: '1rem' }}>
          {loading ? (locale.startsWith('zh') ? '正在加载对话…' : 'Loading conversation…') : <>
            {error} <button type="button" onClick={() => void openBridgeSession(sessionKey)}>{locale.startsWith('zh') ? '重试' : 'Retry'}</button>
          </>}
        </div>}
        {messages.length === 0 && !loading && !error && (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {t('bridge.noMessages')}
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={msg.role === 'user' ? styles.userRow : styles.assistantRow} style={{ padding: '8px 16px' }}>
            <div style={{
              fontSize: '0.7rem',
              color: 'var(--text-muted)',
              marginBottom: 2,
              fontWeight: 600,
            }}>
              {msg.role === 'user' ? t('bridge.user') : t('bridge.agent')}
              {msg.ts ? ` · ${new Date(msg.ts).toLocaleTimeString()}` : ''}
            </div>
            <div style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
              {/* [2026-04-17] 剥掉 bridge-manager 注入的 <t>MM-DD HH:mm</t> 紧凑时间标签（只在外部带给 LLM，不给用户看） */}
              {typeof msg.content === 'string' ? msg.content.replace(/<t>\d{2}-\d{2}\s+\d{2}:\d{2}<\/t>\s*/g, '').trim() : msg.content}
            </div>
          </div>
        ))}
        <div className={styles.sessionFooter} />
      </div>
    </div>
  );
}

// ── PanelHost：管理 alive 列表 ──

function PanelHost() {
  const currentPath = useStore(s => s.currentSessionPath);
  const chatSessions = useStore(s => s.chatSessions);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const [alive, setAlive] = useState<string[]>([]);
  const maxAlive = useMemo(() => {
    const totalItems = Object.values(chatSessions).reduce((sum, session) => sum + session.items.length, 0);
    return totalItems >= HEAVY_HISTORY_ITEM_THRESHOLD ? 2 : MAX_ALIVE;
  }, [chatSessions]);

  useEffect(() => {
    setAlive(previous => previous.length <= maxAlive ? previous : previous.slice(-maxAlive));
  }, [maxAlive]);

  // 加入 alive 列表（不重排已有位置，避免 React 移动 DOM 节点导致 scrollTop 丢失）
  useEffect(() => {
    if (!currentPath) return;
    if (!chatSessions[currentPath] || (chatSessions[currentPath].items.length === 0 && !chatSessions[currentPath].hasMore)) return;
    setAlive(prev => {
      if (prev.includes(currentPath)) return prev; // 已存在，不动
      if (prev.length >= maxAlive) {
        // 淘汰第一个非当前的
        const evictIdx = prev.findIndex(p => p !== currentPath);
        const next = [...prev];
        next.splice(evictIdx, 1);
        next.push(currentPath);
        return next;
      }
      return [...prev, currentPath];
    });
  }, [currentPath, chatSessions, maxAlive]);

  if (welcomeVisible || !currentPath) return null;

  return (
    <>
      {alive.map(path => (
        <Panel key={path} path={path} active={path === currentPath} />
      ))}
    </>
  );
}

// ── Panel：一个 session 的原生滚动容器 ──

const SCROLL_THRESHOLD = 300;
const _emptyItems: ChatListItem[] = [];

const Panel = memo(function Panel({ path, active }: { path: string; active: boolean }) {
  const { locale } = useI18n();
  const items = useStore(s => s.chatSessions[path]?.items ?? _emptyItems);
  const hasMore = useStore(s => s.chatSessions[path]?.hasMore ?? false);
  const loadingMore = useStore(s => s.chatSessions[path]?.loadingMore ?? false);
  const isSessionStreaming = useStore(s => s.streamingSessions.includes(path));
  const writingMode = useStore(s => s.writingMode);
  const lastAssistantMessageId = useMemo(() => findLastAssistantMessageId(items), [items]);
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);
  const firstItem = items[0]?.type === 'message' ? items[0].data.id : '';
  const previousFirst = useRef(firstItem);
  const loadOlder = async () => {
    const element = ref.current;
    if (!element || loadingMore || !hasMore || prependAnchor.current) return;
    isAtBottom.current = false;
    prependAnchor.current = { height: element.scrollHeight, top: element.scrollTop };
    await loadOlderMessages(path);
    requestAnimationFrame(() => { prependAnchor.current = null; });
  };
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && prependAnchor.current && firstItem !== previousFirst.current) {
      element.scrollTop = prependAnchor.current.top + element.scrollHeight - prependAnchor.current.height;
      isAtBottom.current = false;
    }
    previousFirst.current = firstItem;
  }, [firstItem]);
  const pages = useMemo(() => {
    const result: Array<{ start: number; items: ChatListItem[] }> = [];
    for (let start = 0; start < items.length; start += 20) result.push({ start, items: items.slice(start, start + 20) });
    return result;
  }, [items]);

  // 判断是否在底部
  const checkAtBottom = () => {
    const el = ref.current;
    if (!el) return;
    isAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
    setShowJumpToBottom(!isAtBottom.current);
  };

  // 滚到底
  const scrollToBottom = () => {
    const el = ref.current;
    if (el) {
      // Streaming and virtual-page measurement must not restart a smooth-scroll
      // animation against an obsolete content height.
      el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
      isAtBottom.current = true;
      setShowJumpToBottom(false);
    }
  };

  // scroll 事件维护 isAtBottom 标志
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      checkAtBottom();
      if (active && scrolledOnce.current && el.scrollTop < 120) void loadOlder();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [active, hasMore, loadingMore]);

  // ResizeObserver：内容高度变化 + 在底部 → 自动滚
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let previousHeight = ref.current?.scrollHeight || 0;
    const ro = new ResizeObserver(() => {
      const element = ref.current;
      if (!element) return;
      const stayedAtEnd = element.scrollTop >= previousHeight - element.clientHeight - SCROLL_THRESHOLD;
      if (active && isAtBottom.current && stayedAtEnd) {
        scrollToBottom();
      }
      previousHeight = element.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [active]);

  // 首次有内容 → 滚到底
  const scrolledOnce = useRef(false);
  useEffect(() => {
    if (scrolledOnce.current) return;
    if (items.length > 0) {
      scrollToBottom();
      isAtBottom.current = true;
      scrolledOnce.current = true;
    }
  }, [items.length]);

  // 新消息加入 → 强制 sticky（发送消息后自动跟随）
  const prevLen = useRef(items.length);
  useEffect(() => {
    if (items.length > prevLen.current && active && !prependAnchor.current) {
      isAtBottom.current = true;
      scrollToBottom();
    }
    prevLen.current = items.length;
  }, [items.length, active]);

  if (items.length === 0 && !hasMore) return null;

  return (
    <div
      ref={ref}
      className={styles.sessionPanel}
      role="log"
      aria-live={active ? 'polite' : 'off'}
      aria-busy={isSessionStreaming}
      aria-hidden={!active}
      style={{
        visibility: active ? 'visible' : 'hidden',
        zIndex: active ? 1 : 0,
        pointerEvents: active ? 'auto' : 'none',
        overflowAnchor: 'none',
        opacity: active ? 1 : 0,
        transition: active ? 'opacity 0.15s ease-out' : 'none',
      }}
    >
      <div ref={contentRef} className={`${styles.sessionMessages}${writingMode ? ` ${styles.sessionMessagesWide}` : ''}`}>
        {hasMore && <button type="button" disabled={loadingMore} onClick={() => void loadOlder()} style={{ margin: '12px auto', display: 'block' }}>
          {loadingMore ? (locale.startsWith('zh') ? '正在加载…' : 'Loading…') : (locale.startsWith('zh') ? '加载更早的消息' : 'Load older messages')}
        </button>}
        {pages.map((page, pageIndex) => <HistoryPage key={page.items[0]?.type === 'message' ? page.items[0].data.id : `page-${page.start}`} root={ref} count={page.items.length} initialVisible={pageIndex >= pages.length - 4}>
        {page.items.map((item, offset) => (
          <ItemView
            key={item.type === 'message' ? item.data.id : `c-${page.start + offset}`}
            item={item}
            prevItem={page.start + offset > 0 ? items[page.start + offset - 1] : undefined}
            lastAssistantMessageId={lastAssistantMessageId}
          />
        ))}
        </HistoryPage>)}
        {isSessionStreaming && !items.some(item =>
          item.type === 'message' && item.data.role === 'assistant' && item.data.id?.startsWith('stream-') && (item.data.blocks?.length ?? 0) > 0
        ) && (
          <div className={styles.typingIndicator} role="status" aria-label={t('chat.thinking')}>
            <span className={styles.typingDots}>
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
            </span>
            <span className={styles.typingLabel}>{t('chat.thinking')}</span>
          </div>
        )}
        <div className={styles.sessionFooter} />
      </div>
      {active && showJumpToBottom && (
        <button
          type="button"
          className={styles.scrollToBottomFab}
          onClick={scrollToBottom}
          aria-label="滚动到最新消息"
          title="滚动到最新消息"
        >
          ↓
        </button>
      )}
    </div>
  );
});

// ── ItemView ──

const ItemView = memo(function ItemView({ item, prevItem, lastAssistantMessageId }: {
  item: ChatListItem;
  prevItem?: ChatListItem;
  lastAssistantMessageId: string | null;
}) {
  if (item.type === 'compaction') return null;
  const msg = item.data;
  if (msg.role === 'user' && isInternalRecoveryPromptText(msg.text || msg.requestText || '')) {
    return null;
  }
  const prevRole = prevItem?.type === 'message' ? prevItem.data.role : null;
  const showAvatar = msg.role !== prevRole;
  if (msg.role === 'user') {
    return <UserMessage message={msg} showAvatar={showAvatar} />;
  }
  return <AssistantMessage message={msg} showAvatar={showAvatar} isLastAssistant={msg.id === lastAssistantMessageId} />;
});
