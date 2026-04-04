import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import styles from '../Settings.module.css';

type MemoryItem = {
  id: number;
  fact: string;
  tags?: string[];
  time?: string | null;
  created_at?: string | null;
  sourceType?: string | null;
  category?: string | null;
  confidence?: number | null;
  evidence?: string | null;
};

type TimelineGroup = {
  date: string;
  items: MemoryItem[];
};

type InferredProfile = {
  traits?: Array<{ dimension?: string; value?: string; confidence?: number }>;
  goals?: Array<{ goal?: string; confidence?: number }>;
};

type Exclusions = {
  phrases?: string[];
};

const CATEGORY_OPTIONS = [
  { value: 'person', zh: '人物' },
  { value: 'project', zh: '项目' },
  { value: 'preference', zh: '偏好' },
  { value: 'tech', zh: '技术' },
  { value: 'event', zh: '事件' },
  { value: 'other', zh: '其他' },
] as const;

const SOURCE_LABELS: Record<string, string> = {
  conversation: '对话',
  file: '文件',
  imported: '导入',
  inferred: '推断',
};

function label(key: string, fallback: string, vars?: Record<string, string | number>) {
  const translated = t(key, vars);
  return translated === key ? fallback : translated;
}

function getCategoryLabel(category?: string | null) {
  return CATEGORY_OPTIONS.find((item) => item.value === category)?.zh || '其他';
}

function getSourceLabel(source?: string | null) {
  if (!source) return '对话';
  return SOURCE_LABELS[source] || source;
}

function confidenceText(value?: number | null) {
  const normalized = typeof value === 'number' ? value : 0;
  return `${Math.max(0, Math.min(100, Math.round(normalized * 100)))}%`;
}

export function MemoryViewer() {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [timeline, setTimeline] = useState<TimelineGroup[]>([]);
  const [profile, setProfile] = useState<InferredProfile | null>(null);
  const [exclusions, setExclusions] = useState<Exclusions>({ phrases: [] });
  const [busyId, setBusyId] = useState<number | null>(null);
  const getSettingsAgentId = useSettingsStore((s) => s.getSettingsAgentId);
  const showToast = useSettingsStore((s) => s.showToast);

  const loadMemories = useCallback(async () => {
    setLoading(true);
    try {
      const aid = getSettingsAgentId();
      const res = await hanaFetch(`/api/memories/timeline?agentId=${aid || ''}&days=30`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTimeline(Array.isArray(data.timeline) ? data.timeline : []);
      setProfile(data.inferredProfile || null);
      setExclusions(data.exclusions || { phrases: [] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTimeline([]);
      setProfile(null);
      setExclusions({ phrases: [] });
      showToast(label('settings.saveFailed', '保存失败') + ': ' + msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [getSettingsAgentId, showToast]);

  useEffect(() => {
    const handler = () => {
      setVisible(true);
      void loadMemories();
    };
    window.addEventListener('hana-view-memories', handler);
    return () => window.removeEventListener('hana-view-memories', handler);
  }, [loadMemories]);

  const close = () => setVisible(false);

  const handleCategoryChange = useCallback(async (id: number, category: string) => {
    setBusyId(id);
    try {
      const aid = getSettingsAgentId();
      const res = await hanaFetch(`/api/memories/${id}?agentId=${aid || ''}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTimeline((prev) => prev.map((group) => ({
        ...group,
        items: group.items.map((item) => item.id === id ? { ...item, category } : item),
      })));
      showToast(label('settings.autoSaved', '已自动保存'), 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(label('settings.saveFailed', '保存失败') + ': ' + msg, 'error');
    } finally {
      setBusyId(null);
    }
  }, [getSettingsAgentId, showToast]);

  const handleDelete = useCallback(async (id: number) => {
    setBusyId(id);
    try {
      const aid = getSettingsAgentId();
      const res = await hanaFetch(`/api/memories/${id}?agentId=${aid || ''}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTimeline((prev) => prev
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => item.id !== id),
        }))
        .filter((group) => group.items.length > 0));
      showToast(label('settings.memory.actions.clearSuccess', '记忆已清除'), 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(label('settings.saveFailed', '保存失败') + ': ' + msg, 'error');
    } finally {
      setBusyId(null);
    }
  }, [getSettingsAgentId, showToast]);

  const handleExclude = useCallback(async (phrase: string) => {
    const normalized = String(phrase || '').trim();
    if (!normalized) return;
    try {
      const aid = getSettingsAgentId();
      const res = await hanaFetch(`/api/memories/exclusions?agentId=${aid || ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phrase: normalized }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setExclusions(data.exclusions || { phrases: [] });
      showToast('已加入忽略列表', 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(label('settings.saveFailed', '保存失败') + ': ' + msg, 'error');
    }
  }, [getSettingsAgentId, showToast]);

  const handleRemoveExclusion = useCallback(async (phrase: string) => {
    const normalized = String(phrase || '').trim();
    if (!normalized) return;
    try {
      const aid = getSettingsAgentId();
      const res = await hanaFetch(`/api/memories/exclusions?agentId=${aid || ''}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phrase: normalized }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setExclusions(data.exclusions || { phrases: [] });
      showToast('已移除忽略规则', 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(label('settings.saveFailed', '保存失败') + ': ' + msg, 'error');
    }
  }, [getSettingsAgentId, showToast]);

  const traits = useMemo(() => (profile?.traits || []).filter((item) => item?.value), [profile]);
  const goals = useMemo(() => (profile?.goals || []).filter((item) => item?.goal), [profile]);

  if (!visible) return null;

  return (
    <div
      className={`${styles['memory-viewer-overlay']} ${styles['visible']}`}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className={`${styles['memory-viewer']} ${styles['memory-timeline-viewer']}`}>
        <div className={styles['memory-viewer-header']}>
          <div>
            <h3 className={styles['memory-viewer-title']}>{label('settings.memory.actions.viewTitle', '所有记忆')}</h3>
            <div className={styles['memory-timeline-subtitle']}>客观事实与推断画像分开展示，可直接纠错整理。</div>
          </div>
          <div className={styles['memory-viewer-header-actions']}>
            <button className={styles['memory-timeline-refresh']} onClick={() => void loadMemories()}>
              {loading ? '...' : '刷新'}
            </button>
            <button className={styles['memory-viewer-close']} onClick={close}>✕</button>
          </div>
        </div>

        <div className={`${styles['memory-viewer-body']} ${styles['memory-timeline-body']}`}>
          {loading ? (
            <div className="memory-viewer-empty">{label('settings.memory.actions.importing', '正在导入...')}</div>
          ) : (
            <>
              {(traits.length > 0 || goals.length > 0) && (
                <section className={styles['memory-inferred-section']}>
                  <div className={styles['memory-inferred-title']}>推断画像</div>
                  {traits.length > 0 && (
                    <div className={styles['memory-inferred-block']}>
                      <div className={styles['memory-inferred-label']}>特征</div>
                      <div className={styles['memory-inferred-list']}>
                        {traits.map((item, index) => (
                          <div key={`${item.dimension || 'trait'}-${index}`} className={styles['memory-inferred-item']}>
                            <span>{item.value}</span>
                            <span className={styles['memory-inferred-confidence']}>{confidenceText(item.confidence)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {goals.length > 0 && (
                    <div className={styles['memory-inferred-block']}>
                      <div className={styles['memory-inferred-label']}>目标</div>
                      <div className={styles['memory-inferred-list']}>
                        {goals.map((item, index) => (
                          <div key={`${item.goal || 'goal'}-${index}`} className={styles['memory-inferred-item']}>
                            <span>{item.goal}</span>
                            <span className={styles['memory-inferred-confidence']}>{confidenceText(item.confidence)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              )}

              {Array.isArray(exclusions.phrases) && exclusions.phrases.length > 0 && (
                <section className={styles['memory-inferred-section']}>
                  <div className={styles['memory-inferred-title']}>忽略规则</div>
                  <div className={styles['memory-inferred-list']}>
                    {exclusions.phrases.slice(0, 12).map((phrase) => (
                      <div key={phrase} className={styles['memory-inferred-item']}>
                        <span>{phrase}</span>
                        <button
                          className={styles['memory-timeline-secondary']}
                          onClick={() => void handleRemoveExclusion(phrase)}
                        >
                          移除
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {timeline.length === 0 ? (
                <div className="memory-viewer-empty">{label('settings.memory.actions.empty', '还没有记忆')}</div>
              ) : (
                timeline.map((group) => (
                  <section key={group.date} className={styles['memory-timeline-group']}>
                    <div className={styles['memory-timeline-date']}>{group.date || label('settings.memory.unknownDate', '未知日期')}</div>
                    <div className={styles['memory-timeline-list']}>
                      {group.items.map((item) => (
                        <article key={item.id} className={styles['memory-timeline-item']}>
                          <div className={styles['memory-timeline-meta']}>
                            <span className={`${styles['memory-category-badge']} ${styles[`memory-category-${item.category || 'other'}`]}`}>
                              {getCategoryLabel(item.category)}
                            </span>
                            <span className={styles['memory-source-badge']}>{getSourceLabel(item.sourceType)}</span>
                            <span className={styles['memory-confidence-badge']}>{confidenceText(item.confidence)}</span>
                          </div>

                          <div className={styles['memory-timeline-fact']}>{item.fact}</div>

                          {item.evidence && (
                            <div className={styles['memory-timeline-evidence']}>依据：{item.evidence}</div>
                          )}

                          {Array.isArray(item.tags) && item.tags.length > 0 && (
                            <div className={styles['memory-timeline-tags']}>
                              {item.tags.map((tag) => (
                                <span key={`${item.id}-${tag}`} className={styles['memory-timeline-tag']}>{tag}</span>
                              ))}
                            </div>
                          )}

                          <div className={styles['memory-timeline-actions']}>
                            <select
                              className={styles['memory-timeline-select']}
                              value={item.category || 'other'}
                              disabled={busyId === item.id}
                              onChange={(e) => void handleCategoryChange(item.id, e.target.value)}
                            >
                              {CATEGORY_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>{option.zh}</option>
                              ))}
                            </select>
                            <button
                              className={styles['memory-timeline-secondary']}
                              disabled={busyId === item.id}
                              onClick={() => void handleExclude(item.fact)}
                            >
                              不再记这个
                            </button>
                            <button
                              className={styles['memory-timeline-delete']}
                              disabled={busyId === item.id}
                              onClick={() => void handleDelete(item.id)}
                            >
                              删除
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
