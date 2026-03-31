/**
 * ExpertTeamGuide — 频道空状态引导
 *
 * 两个区域：
 * 1. 预设频道模板（代码审查组等，使用已有 agents）
 * 2. 专家市集预览（从 API 加载专家预设，点击 spawn + 加入频道）
 */

import { useState, useCallback, useEffect } from 'react';
import { useI18n } from '../../hooks/use-i18n';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { createChannel } from '../../stores/channel-actions';
import { ExpertCard } from './ExpertCard';
import type { Agent, ExpertPreset } from '../../types';
import styles from './Channels.module.css';

// ── 预设模板（使用已有 agents 创建频道） ──

interface ExpertTemplate {
  key: string;
  icon: string;
  members: number;
  labelKey: string;
  descKey: string;
  introKey: string;
}

const EXPERT_TEMPLATES: ExpertTemplate[] = [
  {
    key: 'codeReview',
    icon: '🔍',
    members: 3,
    labelKey: 'channel.expertTeam.tpl.codeReview.label',
    descKey: 'channel.expertTeam.tpl.codeReview.desc',
    introKey: 'channel.expertTeam.tpl.codeReview.intro',
  },
  {
    key: 'productBrainstorm',
    icon: '💡',
    members: 3,
    labelKey: 'channel.expertTeam.tpl.productBrainstorm.label',
    descKey: 'channel.expertTeam.tpl.productBrainstorm.desc',
    introKey: 'channel.expertTeam.tpl.productBrainstorm.intro',
  },
  {
    key: 'archDiscussion',
    icon: '🏗️',
    members: 3,
    labelKey: 'channel.expertTeam.tpl.archDiscussion.label',
    descKey: 'channel.expertTeam.tpl.archDiscussion.desc',
    introKey: 'channel.expertTeam.tpl.archDiscussion.intro',
  },
];

// ── 组件 ──

interface ExpertTeamGuideProps {
  agents: Agent[];
}

export function ExpertTeamGuide({ agents }: ExpertTeamGuideProps) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [experts, setExperts] = useState<(ExpertPreset & { name: string; description: string })[]>([]);
  const [spawning, setSpawning] = useState<string | null>(null);

  const hasEnoughAgents = agents.length >= 1;

  // 加载专家预设列表
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await hanaFetch('/api/experts');
        if (res.ok && !cancelled) {
          const data = await res.json();
          setExperts(data.experts || []);
        }
      } catch (err) {
        console.warn('[ExpertTeamGuide] load experts failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 使用已有 agents 创建频道模板
  const handleCreate = useCallback(async (tpl: ExpertTemplate) => {
    if (creating || !hasEnoughAgents) return;

    const count = Math.min(tpl.members, agents.length);
    const members = agents.slice(0, count).map((a) => a.id);

    const name = t(tpl.labelKey);
    const intro = t(tpl.introKey);

    setCreating(true);
    try {
      await createChannel(name, members, intro);
    } catch (err) {
      console.error('[ExpertTeamGuide] create failed:', err);
    } finally {
      setCreating(false);
    }
  }, [creating, hasEnoughAgents, agents, t]);

  // Spawn 专家并自动创建频道
  const handleSpawnExpert = useCallback(async (slug: string) => {
    if (spawning) return;
    setSpawning(slug);
    try {
      const res = await hanaFetch(`/api/experts/${encodeURIComponent(slug)}/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.ok && data.agentId) {
        // 创建频道，成员包含新专家 + 已有 agents
        const primaryAgent = agents.find(a => a.isPrimary) || agents[0];
        const members = primaryAgent
          ? [primaryAgent.id, data.agentId]
          : [data.agentId];
        await createChannel(data.name, members);
      }
    } catch (err) {
      console.error('[ExpertTeamGuide] spawn expert failed:', err);
    } finally {
      setSpawning(null);
    }
  }, [spawning, agents]);

  return (
    <div className={styles.expertGuide}>
      {/* 顶部图标 */}
      <div className={styles.expertGuideIcon}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </div>

      {/* 标题 + 描述 */}
      <p className={styles.expertGuideTitle}>{t('channel.expertTeam.guideTitle')}</p>
      <p className={styles.expertGuideDesc}>{t('channel.expertTeam.guideDesc')}</p>

      {/* 不足 agent 提示 */}
      {!hasEnoughAgents && (
        <p className={styles.expertGuideWarn}>{t('channel.expertTeam.needMoreAgents')}</p>
      )}

      {/* ── 专家预设卡片 ── */}
      {experts.length > 0 && (
        <>
          <p className={styles.expertSectionTitle}>{t('channel.expertTeam.expertPresets')}</p>
          <div className={styles.expertTemplates}>
            {experts.map((expert) => (
              <ExpertCard
                key={expert.slug}
                expert={expert}
                onSpawn={handleSpawnExpert}
                disabled={!!spawning}
              />
            ))}
          </div>
        </>
      )}

      {/* ── 频道模板（使用已有 agents） ── */}
      {hasEnoughAgents && (
        <>
          <p className={styles.expertSectionTitle}>{t('channel.expertTeam.channelTemplates')}</p>
          <div className={styles.expertTemplates}>
            {EXPERT_TEMPLATES.map((tpl) => (
              <button
                key={tpl.key}
                className={styles.expertTplCard}
                onClick={() => handleCreate(tpl)}
                disabled={creating}
              >
                <span className={styles.expertTplIcon}>{tpl.icon}</span>
                <span className={styles.expertTplText}>
                  <span className={styles.expertTplLabel}>{t(tpl.labelKey)}</span>
                  <span className={styles.expertTplDesc}>{t(tpl.descKey)}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* 底部提示 */}
      <p className={styles.expertGuideTip}>{t('channel.expertTeam.guideTip')}</p>
    </div>
  );
}
