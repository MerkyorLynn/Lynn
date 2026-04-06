import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../stores';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { formatSessionDate, injectCopyButtons, parseMoodFromContent } from '../utils/format';
import { yuanFallbackAvatar } from '../utils/agent-helpers';
import { getMd } from '../utils/markdown';
import { sanitizeHtml } from '../utils/sanitize';
import fp from './FloatingPanels.module.css';
import chatStyles from './chat/Chat.module.css';

// ── 稳定头像时间戳（避免每次渲染生成新 URL） ──
let _avatarTs = Date.now();

interface ActivityItem {
  id: string;
  type: string;
  summary?: string;
  label?: string;
  status?: string;
  agentId?: string;
  agentName?: string;
  sessionFile?: string;
  startedAt?: number;
  finishedAt?: number;
  workspace?: string;
}

interface DetailMessage {
  role: string;
  content: string;
}

interface DetailState {
  title: string;
  agentId: string;
  agentName: string;
  messages: DetailMessage[];
}

export function ActivityPanel() {
  const activePanel = useStore(s => s.activePanel);
  const activities = useStore(s => s.activities) as ActivityItem[];
  const agents = useStore(s => s.agents);
  const currentAgentId = useStore(s => s.currentAgentId);
  const agentName = useStore(s => s.agentName);
  const setActivities = useStore(s => s.setActivities);

  const [detail, setDetail] = useState<DetailState | null>(null);
  const [hbEnabled, setHbEnabled] = useState(true);
  const [auditLog, setAuditLog] = useState<Array<{ operation: string; path: string; ts: string }> | null>(null);
  const t = window.t ?? ((p: string) => p);

  // 打开面板时加载活动 + 巡检状态
  useEffect(() => {
    if (activePanel === 'activity') {
      hanaFetch('/api/desk/activities')
        .then(r => r.json())
        .then(data => setActivities(data.activities || []))
        .catch(err => console.warn('[activity] fetch activities failed:', err));
      hanaFetch('/api/config')
        .then(r => r.json())
        .then(data => setHbEnabled(data.desk?.heartbeat_enabled !== false))
        .catch(err => console.warn('[activity] fetch config failed:', err));
      setDetail(null);
    }
  }, [activePanel, setActivities]);

  const toggleHeartbeat = useCallback(async () => {
    const next = !hbEnabled;
    setHbEnabled(next);
    try {
      await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desk: { heartbeat_enabled: next } }),
      });
    } catch {
      setHbEnabled(!next); // rollback
    }
  }, [hbEnabled]);

  const openSession = useCallback(async (activityId: string) => {
    try {
      const res = await hanaFetch(`/api/desk/activities/${activityId}/session`);
      const data = await res.json();
      if (data.error) return;

      const { activity, messages } = data;
      const typeText = activity.type === 'heartbeat' ? t('activity.heartbeat')
        : activity.type === 'delegate' ? t('activity.delegate')
        : activity.type === 'plan' ? t('activity.plan')
        : activity.type === 'review_follow_up' ? t('activity.reviewFollowUp')
        : (activity.label || t('activity.cron'));
      const timeStr = activity.startedAt
        ? formatSessionDate(new Date(activity.startedAt).toISOString())
        : '';
      setDetail({
        title: `${typeText}  ${timeStr}`,
        agentId: activity.agentId || currentAgentId || '',
        agentName: activity.agentName || agentName,
        messages: messages || [],
      });
    } catch {}
  }, []);

  const closeDetail = useCallback(() => setDetail(null), []);
  const close = useCallback(() => {
    useStore.getState().setActivePanel(null);
    setDetail(null);
  }, []);

  if (activePanel !== 'activity') return null;

  return (
    <div className={fp.floatingPanel} id="activityPanel">
      <div className={fp.floatingPanelInner}>
        {detail ? (
          // 详情视图
          <div id="activityDetailView" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <div className={fp.floatingPanelHeader}>
              <button className={fp.floatingPanelBack} onClick={closeDetail}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
              <DetailHeader detail={detail} />
              <button className={fp.floatingPanelClose} onClick={close}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <DetailBody messages={detail.messages} />
          </div>
        ) : (
          // 列表视图
          <div id="activityListView" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <div className={fp.floatingPanelHeader}>
              <h2 className={fp.floatingPanelTitle}>{t('activity.title')}</h2>
              <div className={fp.activityHbToggle}>
                <span className="hana-toggle-label">{t('activity.heartbeat')}</span>
                <button
                  className={'hana-toggle' + (hbEnabled ? ' on' : '')}
                  onClick={toggleHeartbeat}
                />
              </div>
              <button
                className={fp.floatingPanelBack}
                title={t('activity.auditLog') || '审计日志'}
                style={{ marginLeft: 4, fontSize: '0.7rem', opacity: 0.7 }}
                onClick={async () => {
                  if (auditLog) { setAuditLog(null); return; }
                  try {
                    const res = await hanaFetch('/api/audit-log?limit=50');
                    const data = await res.json();
                    setAuditLog(data.entries || []);
                  } catch { setAuditLog([]); }
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
              </button>
              <button className={fp.floatingPanelClose} onClick={close}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className={fp.floatingPanelBody}>
              {auditLog !== null && (
                <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--overlay-light, rgba(0,0,0,0.06))', maxHeight: 240, overflowY: 'auto', fontSize: '0.75rem' }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('activity.auditLog') || '审计日志'} ({auditLog.length})</div>
                  {auditLog.length === 0 ? (
                    <div style={{ opacity: 0.5 }}>{t('activity.auditLogEmpty') || '暂无记录'}</div>
                  ) : auditLog.map((entry, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, lineHeight: 1.6, opacity: 0.8 }}>
                      <span style={{ flexShrink: 0, width: 42, color: entry.operation === 'delete' ? 'var(--danger)' : entry.operation === 'write' ? 'var(--warning)' : 'inherit' }}>{entry.operation}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.path}>{entry.path?.split('/').pop()}</span>
                      <span style={{ flexShrink: 0, opacity: 0.5 }}>{entry.ts?.slice(11, 19)}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className={fp.activityCards} id="activityCards">
                {activities.length === 0 ? (
                  <div className={fp.activityEmpty}>{t('activity.empty')}</div>
                ) : (
                  activities.map(a => (
                    <ActivityCard
                      key={a.id}
                      activity={a}
                      agents={agents}
                      currentAgentId={currentAgentId}
                      agentName={agentName}
                      onOpen={openSession}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityCard({
  activity: a,
  agents,
  currentAgentId,
  agentName,
  onOpen,
}: {
  activity: ActivityItem;
  agents: { id: string; yuan: string; hasAvatar?: boolean }[];
  currentAgentId: string | null;
  agentName: string;
  onOpen: (id: string) => void;
}) {
  const agentId = a.agentId || currentAgentId;
  const ag = agents.find(x => x.id === agentId);
  const avatarSrc = ag?.hasAvatar
    ? hanaUrl(`/api/agents/${agentId}/avatar?t=${_avatarTs}`)
    : yuanFallbackAvatar(ag?.yuan);

  const t = window.t ?? ((p: string) => p);
  const workspaceName = String(a.workspace || '').trim().split('/').filter(Boolean).pop() || '';
  const typeText = a.type === 'heartbeat' ? t('activity.heartbeat')
    : a.type === 'delegate' ? t('activity.delegate')
    : a.type === 'plan' ? t('activity.plan')
    : a.type === 'review_follow_up' ? t('activity.reviewFollowUp')
    : (a.label || t('activity.cron'));

  let durationText = '';
  if (a.finishedAt && a.startedAt) {
    const seconds = Math.round((a.finishedAt - a.startedAt) / 1000);
    const text = seconds >= 60
      ? `${Math.floor(seconds / 60)}m${seconds % 60}s`
      : `${seconds}s`;
    durationText = t('activity.duration', { text });
  }

  return (
    <div
      className={`${fp.actCard}${a.status === 'error' ? ` ${fp.actCardError}` : ''}`}
      style={a.sessionFile ? { cursor: 'pointer' } : undefined}
      onClick={a.sessionFile ? () => onOpen(a.id) : undefined}
    >
      <div className={fp.actCardHead}>
        <img
          className={fp.actCardAvatar}
          src={avatarSrc}
          onError={e => { (e.target as HTMLImageElement).onerror = null; (e.target as HTMLImageElement).src = yuanFallbackAvatar(ag?.yuan); }}
          draggable={false}
        />
        <span className={fp.actCardAgentName}>{a.agentName || agentName}</span>
        <span className={fp.actCardBadge}>{typeText}</span>
        <span className={fp.actCardTime}>
          {a.startedAt ? formatSessionDate(new Date(a.startedAt).toISOString()) : ''}
        </span>
      </div>
      <div className={fp.actCardSummary}>
        {a.summary || (
          a.type === 'heartbeat'
            ? t('activity.patrolDone')
            : a.type === 'plan'
              ? t('activity.planDone')
              : t('activity.cronDone')
        )}
      </div>
      <div className={fp.actCardMeta}>
        {workspaceName ? (
          <span className={fp.actCardBadge} style={{ opacity: 0.9 }}>
            {t('desk.workspace') && t('desk.workspace') !== 'desk.workspace'
              ? `${t('desk.workspace')} · ${workspaceName}`
              : `工作区 · ${workspaceName}`}
          </span>
        ) : null}
        {durationText && <span className={fp.actCardDuration}>{durationText}</span>}
        {a.status === 'error' && <span style={{ color: 'var(--danger)' }}>{t('activity.error')}</span>}
        {a.sessionFile && <span className={fp.actCardViewHint}>{t('activity.viewSession')}</span>}
      </div>
    </div>
  );
}

function DetailHeader({ detail }: { detail: DetailState }) {
  const agents = useStore(s => s.agents);
  const ag = agents.find(x => x.id === detail.agentId);
  const avatarSrc = ag?.hasAvatar
    ? hanaUrl(`/api/agents/${detail.agentId}/avatar?t=${_avatarTs}`)
    : yuanFallbackAvatar(ag?.yuan);

  return (
    <div className={fp.detailHeaderInfo}>
      <img
        className={fp.detailHeaderAvatar}
        src={avatarSrc}
        onError={e => { (e.target as HTMLImageElement).onerror = null; (e.target as HTMLImageElement).src = yuanFallbackAvatar(ag?.yuan); }}
        draggable={false}
      />
      <div className={fp.detailHeaderText}>
        <span className={fp.detailHeaderName}>{detail.agentName}</span>
        <span className={fp.detailHeaderSubtitle}>{detail.title}</span>
      </div>
    </div>
  );
}

function DetailBody({ messages }: { messages: DetailMessage[] }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const t = window.t ?? ((p: string) => p);
  const mdInstance = getMd();

  useEffect(() => {
    if (bodyRef.current) {
      injectCopyButtons(bodyRef.current);
    }
  }, [messages]);

  return (
    <div className={fp.floatingPanelBody} ref={bodyRef}>
      {messages.map((m, i) => {
        if (m.role === 'assistant') {
          const { mood, text } = parseMoodFromContent(m.content);
          return (
            <div key={`msg-${i}`} className={`${fp.activityDetailMsg} ${fp.activityDetailMsgAssistant}`}>
              <div className={fp.activityDetailBubble}>
                {mood && (
                  <details className={chatStyles.moodWrapper}>
                    <summary className={chatStyles.moodSummary}>{t('mood.label')}</summary>
                    <div className={chatStyles.moodBlock}>{mood}</div>
                  </details>
                )}
                {text && (
                  <div
                    className="md-content"
                    dangerouslySetInnerHTML={{
                      __html: mdInstance
                        ? sanitizeHtml(mdInstance.render(text.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, '')))
                        : text,
                    }}
                  />
                )}
              </div>
            </div>
          );
        }
        return (
          <div key={`msg-${i}`} className={`${fp.activityDetailMsg} ${fp.activityDetailMsgUser}`}>
            <div className={fp.activityDetailBubble}>{m.content}</div>
          </div>
        );
      })}
    </div>
  );
}
