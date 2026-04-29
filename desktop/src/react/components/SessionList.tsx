/**
 * SessionList — 侧边栏 session 列表 React 组件
 *
 * Phase 6B: 替代 sidebar-shim.ts 中的 renderSessionList / createSessionItem。
 * 通过 portal 渲染到 #sessionList，从 Zustand sessions 状态驱动。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../stores';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { formatSessionDate } from '../utils/format';
import { switchSession, archiveSession, renameSession } from '../stores/session-actions';
import type { Session, Agent, BridgeSession } from '../types';
import { yuanFallbackAvatar } from '../utils/agent-helpers';
import { lookupKnownModel } from '../utils/known-models';
import { isDisplayDefaultModel } from '../utils/brain-models';
import styles from './SessionList.module.css';

// ── Platform icons ──

const PLATFORM_ICONS: Record<string, { label: string; color: string }> = {
  feishu: { label: '飞书', color: '#3370ff' },
  telegram: { label: 'Telegram', color: '#26a5e4' },
  qq: { label: 'QQ', color: '#12b7f5' },
  wechat: { label: '微信', color: '#07c160' },
};

function PlatformIcon({ platform }: { platform: string }) {
  const info = PLATFORM_ICONS[platform] || { label: platform, color: '#999' };
  return (
    <span
      className={styles.bridgePlatformIcon}
      style={{ background: info.color }}
      title={info.label}
    >
      {info.label.charAt(0)}
    </span>
  );
}

// ── Bridge sessions loading ──

function useBridgeSessions() {
  const bridgeStatusTrigger = useStore(s => s.bridgeStatusTrigger);
  const bridgeLatestMessage = useStore(s => s.bridgeLatestMessage);
  const setBridgeSessions = useStore(s => s.setBridgeSessions);
  const bridgeSessions = useStore(s => s.bridgeSessions);

  useEffect(() => {
    hanaFetch('/api/bridge/sessions')
      .then(r => r.json())
      .then(data => {
        if (data?.sessions) setBridgeSessions(data.sessions);
      })
      .catch(() => {});
  }, [bridgeStatusTrigger, bridgeLatestMessage, setBridgeSessions]);

  return bridgeSessions;
}

async function openBridgeSession(sessionKey: string) {
  const store = useStore.getState();
  store.setActiveBridgeSessionKey(sessionKey);
  // Load messages
  try {
    const res = await hanaFetch(`/api/bridge/sessions/${encodeURIComponent(sessionKey)}/messages`);
    const data = await res.json();
    store.setActiveBridgeMessages(data.messages || []);
  } catch {
    store.setActiveBridgeMessages([]);
  }
  // Hide welcome, show chat area
  useStore.setState({ welcomeVisible: false });
}


// ── 主组件 ──

export function SessionList() {
  return <SessionListInner />;
}

interface WorkspaceSessionsGroup {
  key: string;
  kind: 'agent' | 'workspace';
  title: string;
  path: string | null;
  latestModified: number;
  items: Session[];
}

function parseModifiedTime(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeLegacyWorkspacePath(cwd: string | null | undefined): string | null {
  const raw = String(cwd || '').trim();
  if (!raw) return null;
  const oldRoot = '/Users/lynn/openhanako';
  const newRoot = '/Users/lynn/Lynn';
  if (raw === oldRoot || raw.startsWith(`${oldRoot}/`)) {
    return raw.replace(oldRoot, newRoot);
  }
  return raw;
}

function formatWorkspaceTitle(cwd: string | null, fallbackName: string): string {
  const normalized = normalizeLegacyWorkspacePath(cwd);
  if (!normalized) return fallbackName;
  const dirName = normalized.split('/').filter(Boolean).pop();
  return dirName || fallbackName;
}

function groupSessionsByWorkspace(sessions: Session[], fallbackName: string): WorkspaceSessionsGroup[] {
  const groups = new Map<string, WorkspaceSessionsGroup>();

  for (const session of sessions) {
    const normalizedCwd = normalizeLegacyWorkspacePath(session.cwd);
    const key = normalizedCwd ? `cwd:${normalizedCwd}` : 'cwd:agent-root';
    const existing = groups.get(key);
    const modifiedAt = parseModifiedTime(session.modified);
    if (existing) {
      existing.items.push(session);
      existing.latestModified = Math.max(existing.latestModified, modifiedAt);
      continue;
    }
    groups.set(key, {
      key,
      kind: normalizedCwd ? 'workspace' : 'agent',
      title: formatWorkspaceTitle(normalizedCwd, fallbackName),
      path: normalizedCwd,
      latestModified: modifiedAt,
      items: [session],
    });
  }

  const result = [...groups.values()];
  result.sort((a, b) => {
    if (a.kind === 'agent' && b.kind !== 'agent') return -1;
    if (b.kind === 'agent' && a.kind !== 'agent') return 1;
    if (b.latestModified !== a.latestModified) return b.latestModified - a.latestModified;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });

  for (const group of result) {
    group.items.sort((a, b) => {
      const pinDelta = Number(!!b.pinned) - Number(!!a.pinned);
      if (pinDelta !== 0) return pinDelta;
      return parseModifiedTime(b.modified) - parseModifiedTime(a.modified);
    });
  }

  return result;
}

// ── 内部组件 ──

function SessionListInner() {
  const { t } = useI18n();
  const sessions = useStore(s => s.sessions);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const sessionCreationPending = useStore(s => s.sessionCreationPending);
  const agents = useStore(s => s.agents);
  const streamingSessions = useStore(s => s.streamingSessions);
  const browserRunning = useStore(s => s.browserRunning);
  const agentName = useStore(s => s.agentName) || 'Lynn';
  const activeBridgeKey = useStore(s => s.activeBridgeSessionKey);

  const bridgeSessions = useBridgeSessions();

  const [browserSessions, setBrowserSessions] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [bridgeCollapsed, setBridgeCollapsed] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      const raw = window.localStorage.getItem('hana-session-workspace-groups');
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  });
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem('hana-session-workspace-groups', JSON.stringify(collapsedGroups));
    } catch {
      // Persisting collapsed sidebar groups is best effort.
    }
  }, [collapsedGroups]);

  // Cmd+K event from SidebarLayout
  useEffect(() => {
    const handler = () => { setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 50); };
    window.addEventListener('hana-sidebar-search', handler);
    return () => window.removeEventListener('hana-sidebar-search', handler);
  }, []);

  // Escape closes search
  useEffect(() => {
    if (!searchOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [searchOpen]);

  // Fetch browser sessions (re-fetch when browser starts/stops)
  useEffect(() => {
    if (sessions.length === 0) return;
    hanaFetch('/api/browser/sessions')
      .then(r => r.json())
      .then(data => setBrowserSessions(data || {}))
      .catch(err => console.warn('[sessions] fetch browser sessions failed:', err));
  }, [sessions, browserRunning]);

  if (sessions.length === 0) {
    return (
      <div className={styles.sessionEmpty}>
        <p className={styles.sessionEmptyText}>{t('sidebar.empty')}</p>
        <div className={styles.sessionEmptyActions}>
          {[
            { key: 'organize', label: t('sidebar.emptyAction.organize') || 'Organize files', prompt: t('sidebar.emptyAction.organizePrompt') || 'Help me organize the files in the current workspace. Categorize them and give suggestions.' },
            { key: 'plan', label: t('sidebar.emptyAction.plan') || 'Write a task list', prompt: t('sidebar.emptyAction.planPrompt') || 'Help me write a task list for today. List the top 3 most important things.' },
            { key: 'analyze', label: t('sidebar.emptyAction.analyze') || 'Analyze a file', prompt: t('sidebar.emptyAction.analyzePrompt') || 'I want to analyze a file. Tell me to drag it in or use @ to reference it.' },
          ].map((action) => (
            <button
              key={action.key}
              className={styles.sessionEmptyBtn}
              onClick={() => {
                useStore.setState({ welcomeVisible: false });
                import('../stores/prompt-actions').then(m => m.sendPrompt({ text: action.prompt, displayText: action.prompt }));
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Filter sessions by search query
  const filtered = searchQuery.trim()
    ? sessions.filter(s => {
        const q = searchQuery.toLowerCase();
        const labels = Array.isArray(s.labels) ? s.labels.join(' ') : '';
        return (s.title || '').toLowerCase().includes(q)
          || (s.firstMessage || '').toLowerCase().includes(q)
          || labels.toLowerCase().includes(q);
      })
    : sessions;

  const grouped = groupSessionsByWorkspace(filtered, agentName);

  return (
    <>
      {searchOpen && (
        <div className={styles.sessionSearchBar}>
          <input
            ref={searchRef}
            className={styles.sessionSearchInput}
            type="text"
            placeholder={t('sidebar.search') || 'Search...'}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className={styles.sessionSearchClear} onClick={() => { setSearchQuery(''); searchRef.current?.focus(); }}>×</button>
          )}
        </div>
      )}
      {searchQuery && filtered.length === 0 && (
        <div className={styles.sessionEmpty}>{t('sidebar.noResults') || 'No results'}</div>
      )}
      {/* ── Bridge IM Channels ── */}
      {!searchQuery && bridgeSessions.length > 0 && (
        <>
          <button
            type="button"
            className={`${styles.sessionGroupHeader}${activeBridgeKey ? ` ${styles.sessionGroupHeaderActive}` : ''}`}
            onClick={() => setBridgeCollapsed(prev => !prev)}
            title="IM Channels"
          >
            <span className={`${styles.sessionGroupArrow}${bridgeCollapsed ? ` ${styles.collapsed}` : ''}`} aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </span>
            <span className={styles.sessionGroupIcon} aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
            </span>
            <span className={styles.sessionGroupMeta}>
              <span className={styles.sessionGroupTitle}>IM Channels</span>
            </span>
            <span className={styles.sessionGroupCount}>{bridgeSessions.length}</span>
          </button>
          {!bridgeCollapsed && bridgeSessions.map(bs => (
            <button
              key={bs.sessionKey}
              className={`${styles.sessionItem}${activeBridgeKey === bs.sessionKey ? ` ${styles.sessionItemActive}` : ''}`}
              onClick={() => {
                useStore.getState().setActiveBridgeSessionKey(
                  activeBridgeKey === bs.sessionKey ? null : bs.sessionKey,
                );
                if (activeBridgeKey !== bs.sessionKey) openBridgeSession(bs.sessionKey);
                else useStore.getState().setActiveBridgeSessionKey(null);
              }}
            >
              <div className={styles.sessionItemHeader}>
                <PlatformIcon platform={bs.platform} />
                <div className={styles.sessionItemTitle}>
                  {bs.displayName || bs.chatId}
                </div>
              </div>
              <div className={styles.sessionItemMeta}>
                {PLATFORM_ICONS[bs.platform]?.label || bs.platform}
                {bs.isOwner ? ' · Owner' : ''}
                {bs.lastActive ? ` · ${formatSessionDate(new Date(bs.lastActive).toISOString())}` : ''}
              </div>
            </button>
          ))}
        </>
      )}
      {grouped.map((group) => {
        const isCollapsed = !searchQuery && !!collapsedGroups[group.key];
        const containsActive = group.items.some((item) => !pendingNewSession && item.path === currentSessionPath);
        return (
          <Fragment key={group.key}>
            <button
              type="button"
              className={`${styles.sessionGroupHeader}${containsActive ? ` ${styles.sessionGroupHeaderActive}` : ''}`}
              onClick={() => {
                setCollapsedGroups((prev) => ({ ...prev, [group.key]: !prev[group.key] }));
              }}
              title={group.path || group.title}
            >
              <span className={`${styles.sessionGroupArrow}${isCollapsed ? ` ${styles.collapsed}` : ''}`} aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
              </span>
              <span className={styles.sessionGroupIcon} aria-hidden="true">
                {group.kind === 'workspace' ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path>
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="12" r="4.2"></circle>
                  </svg>
                )}
              </span>
              <span className={styles.sessionGroupMeta}>
                <span className={styles.sessionGroupTitle}>{group.title}</span>
                {group.path ? <span className={styles.sessionGroupPath}>{group.path}</span> : null}
              </span>
              <span className={styles.sessionGroupCount}>{group.items.length}</span>
            </button>
            {!isCollapsed && group.items.map(s => (
              <SessionItem
                key={s.path}
                session={s}
                isActive={!pendingNewSession && s.path === currentSessionPath}
                isStreaming={streamingSessions.includes(s.path)}
                agents={agents}
                browserUrl={browserSessions[s.path] || null}
                disabled={sessionCreationPending}
              />
            ))}
          </Fragment>
        );
      })}
    </>
  );
}

// ── Session Item ──

function formatProviderLabel(provider?: string | null): string {
  if (!provider) return '';
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferSessionFallbackYuan(agentName?: string | null): string {
  const normalized = String(agentName || '').trim().toLowerCase();
  if (normalized.includes('hanako') || normalized.includes('花子')) return 'hanako';
  if (normalized.includes('butter')) return 'butter';
  if (normalized.includes('kong')) return 'kong';
  return 'lynn';
}

function SessionItem({ session: s, isActive, isStreaming, agents, browserUrl, disabled = false }: {
  session: Session;
  isActive: boolean;
  isStreaming: boolean;
  agents: Agent[];
  browserUrl: string | null;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [labelEditing, setLabelEditing] = useState(false);
  const [labelValue, setLabelValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    if (editing || disabled) return;
    useStore.getState().setActiveBridgeSessionKey(null);
    useStore.getState().setActiveBridgeMessages([]);
    switchSession(s.path);
  }, [s.path, editing, disabled]);

  const handleArchive = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    archiveSession(s.path);
  }, [s.path]);

  const startEditLabels = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setLabelValue(Array.isArray(s.labels) ? s.labels.join(', ') : '');
    setLabelEditing(true);
  }, [s.labels]);

  const commitLabels = useCallback(async () => {
    const parsed = [...new Set(
      labelValue
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 6),
    )];
    setLabelEditing(false);
    if (parsed.join('|') === (Array.isArray(s.labels) ? s.labels.join('|') : '')) return;
    try {
      await hanaFetch('/api/sessions/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: s.path, labels: parsed }),
      });
      const sessions = useStore.getState().sessions.map(sess =>
        sess.path === s.path ? { ...sess, labels: parsed } : sess,
      );
      useStore.setState({ sessions });
    } catch (err) {
      console.warn('[sessions] save labels failed:', err);
    }
  }, [labelValue, s.labels, s.path]);

  const handlePin = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await hanaFetch('/api/sessions/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: s.path, pinned: !s.pinned }),
      });
      const sessions = useStore.getState().sessions.map(sess =>
        sess.path === s.path ? { ...sess, pinned: !s.pinned } : sess,
      );
      useStore.setState({ sessions });
    } catch (err) {
      console.warn('[sessions] toggle pin failed:', err);
    }
  }, [s.path, s.pinned]);

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(s.title || s.firstMessage || '');
    setEditing(true);
  }, [s.title, s.firstMessage]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    setEditing(false);
    if (trimmed && trimmed !== (s.title || s.firstMessage || '')) {
      renameSession(s.path, trimmed);
    }
  }, [editValue, s.path, s.title, s.firstMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
    }
  }, [commitRename]);

  // Auto-focus input when editing starts
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (labelEditing && labelInputRef.current) {
      labelInputRef.current.focus();
      labelInputRef.current.select();
    }
  }, [labelEditing]);

  const modelLabel = useMemo(() => {
    if (!s.modelId) return '';
    if (isDisplayDefaultModel(s.modelId, s.modelProvider)) return '';
    const known = lookupKnownModel(s.modelProvider || '', s.modelId);
    const provider = formatProviderLabel(s.modelProvider || known?.provider || '');
    const display = known?.name || s.modelId;
    return provider ? provider + ' · ' + display : display;
  }, [s.modelId, s.modelProvider]);

  // Meta line
  const parts: string[] = [];
  if (s.agentName || s.agentId) parts.push(s.agentName || s.agentId!);
  if (s.cwd) {
    const dirName = normalizeLegacyWorkspacePath(s.cwd)?.split('/').filter(Boolean).pop();
    if (dirName) parts.push(dirName);
  }
  if (s.modified) parts.push(formatSessionDate(s.modified));

  return (
    <button
      className={`${styles.sessionItem}${isActive ? ` ${styles.sessionItemActive}` : ''}`}
      data-session-path={s.path}
      onClick={handleClick}
      disabled={disabled}
    >
      <div className={styles.sessionItemHeader}>
        {s.agentId && (
          <AgentBadge agentId={s.agentId} agentName={s.agentName} agents={agents} />
        )}
        {isStreaming && <span className={styles.sessionStreamingDot} />}
        {editing ? (
          <input
            ref={inputRef}
            className={styles.sessionRenameInput}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={commitRename}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <div className={styles.sessionItemTitle}>
            {s.title || s.firstMessage || t('session.untitled')}
          </div>
        )}
      </div>

      {!editing && (
        <div className={styles.sessionRenameBtn} title={t('session.rename')} onClick={startRename}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
        </div>
      )}

      <div className={`${styles.sessionPinBtn}${s.pinned ? ` ${styles.sessionPinActive}` : ''}`} title={s.pinned ? 'Unpin' : 'Pin'} onClick={handlePin}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L12 12" /><path d="M18 6L12 12L6 6" /><line x1="5" y1="21" x2="19" y2="21" />
        </svg>
      </div>

      <div className={styles.sessionArchiveBtn} title="Archive" onClick={handleArchive}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="21 8 21 21 3 21 3 8" />
          <rect x="1" y="3" width="22" height="5" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      </div>

      <div className={styles.sessionItemMeta}>
        {parts.join(' · ')}
      </div>

      {labelEditing ? (
        <input
          ref={labelInputRef}
          className={styles.sessionLabelInput}
          value={labelValue}
          onChange={e => setLabelValue(e.target.value)}
          onBlur={() => void commitLabels()}
          onClick={e => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commitLabels();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setLabelEditing(false);
            }
          }}
          placeholder={t('session.labelsPlaceholder') || '标签，用逗号分隔'}
        />
      ) : Array.isArray(s.labels) && s.labels.length > 0 ? (
        <div className={styles.sessionLabels}>
          {s.labels.slice(0, 3).map((label) => (
            <span key={`${s.path}:${label}`} className={styles.sessionLabelChip}>
              {label}
            </span>
          ))}
        </div>
      ) : null}

      {modelLabel && (
        <div className={styles.sessionItemModel}>
          {modelLabel}
        </div>
      )}

      {!editing && !labelEditing && (
        <div className={styles.sessionLabelBtn} title={t('session.editLabels') || '编辑标签'} onClick={startEditLabels}>
          #
        </div>
      )}

      {browserUrl && (
        <span className={styles.sessionBrowserBadge} title={browserUrl}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </span>
      )}
    </button>
  );
}

// ── Agent Avatar Badge ──

function AgentBadge({ agentId, agentName, agents }: {
  agentId: string;
  agentName: string | null;
  agents: Agent[];
}) {
  const agent = agents.find(a => a.id === agentId);
  const apiUrl = useMemo(() =>
    agent?.hasAvatar ? hanaUrl(`/api/agents/${agentId}/avatar?t=${Date.now()}`) : null,
  [agent?.hasAvatar, agentId]);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
  }, [apiUrl]);

  const src = (!apiUrl || errored)
    ? yuanFallbackAvatar(agent?.yuan || inferSessionFallbackYuan(agentName))
    : apiUrl;

  return (
    <img
      className={styles.sessionAgentBadge}
      src={src}
      title={agentName || agentId}
      draggable={false}
      onError={() => setErrored(true)}
    />
  );
}
