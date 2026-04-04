/**
 * ChatArea — 聊天消息列表（干净重写版）
 *
 * 原理：每个 session 一个原生滚动 div，visibility:hidden 保持 scrollTop。
 * 不用 Virtuoso，不用 Activity，不用快照，不用任何花活。
 */

import { memo, useRef, useEffect, useState, useMemo } from 'react';
import { useStore } from '../../stores';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ApplyCodeDialog } from './ApplyCodeDialog';
import type { ChatListItem } from '../../stores/chat-types';
import { findLastAssistantMessageId } from '../../utils/chat-list';
import styles from './Chat.module.css';

const MAX_ALIVE = 5;

// ── 入口 ──

export function ChatArea() {
  const [applyState, setApplyState] = useState<{ code: string; language?: string; anchorRect?: DOMRect } | null>(null);

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
      <PanelHost />
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

// ── PanelHost：管理 alive 列表 ──

function PanelHost() {
  const currentPath = useStore(s => s.currentSessionPath);
  const chatSessions = useStore(s => s.chatSessions);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const [alive, setAlive] = useState<string[]>([]);

  // 加入 alive 列表（不重排已有位置，避免 React 移动 DOM 节点导致 scrollTop 丢失）
  useEffect(() => {
    if (!currentPath) return;
    if (!chatSessions[currentPath] || chatSessions[currentPath].items.length === 0) return;
    setAlive(prev => {
      if (prev.includes(currentPath)) return prev; // 已存在，不动
      if (prev.length >= MAX_ALIVE) {
        // 淘汰第一个非当前的
        const evictIdx = prev.findIndex(p => p !== currentPath);
        const next = [...prev];
        next.splice(evictIdx, 1);
        next.push(currentPath);
        return next;
      }
      return [...prev, currentPath];
    });
  }, [currentPath, chatSessions]);

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
  const items = useStore(s => s.chatSessions[path]?.items ?? _emptyItems);
  const isSessionStreaming = useStore(s => s.streamingSessions.includes(path));
  const lastAssistantMessageId = useMemo(() => findLastAssistantMessageId(items), [items]);
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true);

  // 判断是否在底部
  const checkAtBottom = () => {
    const el = ref.current;
    if (!el) return;
    isAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
  };

  // 滚到底
  const scrollToBottom = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // scroll 事件维护 isAtBottom 标志
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => checkAtBottom();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // ResizeObserver：内容高度变化 + 在底部 → 自动滚
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (active && isAtBottom.current) {
        scrollToBottom();
      }
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
    if (items.length > prevLen.current && active) {
      isAtBottom.current = true;
      scrollToBottom();
    }
    prevLen.current = items.length;
  }, [items.length, active]);

  if (items.length === 0) return null;

  return (
    <div
      ref={ref}
      className={styles.sessionPanel}
      style={{
        visibility: active ? 'visible' : 'hidden',
        zIndex: active ? 1 : 0,
        pointerEvents: active ? 'auto' : 'none',
      }}
    >
      <div ref={contentRef} className={styles.sessionMessages}>
        {items.map((item, i) => (
          <ItemView
            key={item.type === 'message' ? item.data.id : `c-${i}`}
            item={item}
            prevItem={i > 0 ? items[i - 1] : undefined}
            lastAssistantMessageId={lastAssistantMessageId}
          />
        ))}
        {isSessionStreaming && !items.some(item =>
          item.type === 'message' && item.data.role === 'assistant' && item.data.id?.startsWith('stream-') && (item.data.blocks?.length ?? 0) > 0
        ) && (
          <div className={styles.typingIndicator}>
            <span className={styles.typingBar} />
          </div>
        )}
        <div className={styles.sessionFooter} />
      </div>
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
  const prevRole = prevItem?.type === 'message' ? prevItem.data.role : null;
  const showAvatar = msg.role !== prevRole;
  if (msg.role === 'user') {
    return <UserMessage message={msg} showAvatar={showAvatar} />;
  }
  return <AssistantMessage message={msg} showAvatar={showAvatar} isLastAssistant={msg.id === lastAssistantMessageId} />;
});
