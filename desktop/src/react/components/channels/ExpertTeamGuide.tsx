/**
 * ExpertTeamGuide — 频道空状态引导
 *
 * 两个区域：
 * 1. 预设频道模板（使用已有 agents）
 * 2. 专家市集预览（先选择专家与模型，再创建频道）
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useI18n } from '../../hooks/use-i18n';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { createChannel, createChannelWithExpert, createRoundtableWithExperts } from '../../stores/channel-actions';
import {
  buildUserVisibleModelOptions,
  decodeUserVisibleModelValue,
} from '../../utils/brain-models';
import { ExpertCard } from './ExpertCard';
import type { Agent, ExpertPreset, Model } from '../../types';
import styles from './Channels.module.css';

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

interface ExpertTeamGuideProps {
  agents: Agent[];
}

function expertName(expert: ExpertPreset | null): string {
  if (!expert) return '';
  return typeof expert.name === 'string' ? expert.name : (expert.name.zh || expert.name.en || expert.slug);
}

export function ExpertTeamGuide({ agents }: ExpertTeamGuideProps) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [experts, setExperts] = useState<ExpertPreset[]>([]);
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [selectedExpertSlugs, setSelectedExpertSlugs] = useState<string[]>([]);
  const [selectedModelValue, setSelectedModelValue] = useState('');
  const [roundtableTopic, setRoundtableTopic] = useState('');

  const hasEnoughAgents = agents.length >= 1;
  const selectedExperts = useMemo(
    () => experts.filter((expert) => selectedExpertSlugs.includes(expert.slug)),
    [experts, selectedExpertSlugs],
  );
  const visibleModels = useMemo(
    () => buildUserVisibleModelOptions(availableModels),
    [availableModels],
  );
  const selectedExpert = selectedExperts.length === 1 ? selectedExperts[0] : null;
  const hasRoundtableSelection = selectedExperts.length >= 2;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [expertsRes, modelsRes] = await Promise.all([
          hanaFetch('/api/experts'),
          hanaFetch('/api/models'),
        ]);
        if (cancelled) return;
        const expertsData = await expertsRes.json().catch(() => ({}));
        const modelsData = await modelsRes.json().catch(() => ({}));
        setExperts(expertsData.experts || []);
        setAvailableModels(modelsData.models || []);
      } catch (err) {
        if (!cancelled) {
          console.warn('[ExpertTeamGuide] load experts failed:', err);
          setExperts([]);
          setAvailableModels([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

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

  const handleSelectExpert = useCallback((slug: string) => {
    setSelectedExpertSlugs((prev) => (
      prev.includes(slug)
        ? prev.filter((item) => item !== slug)
        : [...prev, slug]
    ));
    setSelectedModelValue('');
    setRoundtableTopic('');
  }, []);

  const handleCreateWithExpert = useCallback(async () => {
    if (!selectedExpert || creating) return;
    setCreating(true);
    try {
      const selectedModel = decodeUserVisibleModelValue(selectedModelValue);
      await createChannelWithExpert(selectedExpert.slug, {
        modelId: selectedModel.id,
        provider: selectedModel.provider,
      });
    } catch (err) {
      console.error('[ExpertTeamGuide] create with expert failed:', err);
    } finally {
      setCreating(false);
    }
  }, [creating, selectedExpert, selectedModelValue]);

  const handleCreateRoundtable = useCallback(async () => {
    if (!hasRoundtableSelection || creating) return;
    setCreating(true);
    try {
      await createRoundtableWithExperts(selectedExpertSlugs, {
        topic: roundtableTopic.trim() || undefined,
        channelName: roundtableTopic.trim() || undefined,
      });
    } catch (err) {
      console.error('[ExpertTeamGuide] create roundtable failed:', err);
    } finally {
      setCreating(false);
    }
  }, [creating, hasRoundtableSelection, roundtableTopic, selectedExpertSlugs]);

  return (
    <div className={styles.expertGuide}>
      <div className={styles.expertGuideIcon}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </div>

      <p className={styles.expertGuideTitle}>{t('channel.expertTeam.guideTitle')}</p>
      <p className={styles.expertGuideDesc}>{t('channel.expertTeam.guideDesc')}</p>

      {!hasEnoughAgents && (
        <p className={styles.expertGuideWarn}>{t('channel.expertTeam.needMoreAgents')}</p>
      )}

      {experts.length > 0 && (
        <>
          <p className={styles.expertSectionTitle}>{t('channel.expertTeam.expertPresets')}</p>
          <div className={styles.expertTemplates}>
            {experts.map((expert) => (
              <ExpertCard
                key={expert.slug}
                expert={expert}
                onSelect={handleSelectExpert}
                disabled={creating}
                selected={selectedExpertSlugs.includes(expert.slug)}
                actionLabel={selectedExpertSlugs.includes(expert.slug)
                  ? (hasRoundtableSelection ? (t('channel.expertSelected') || '已选中') : (t('channel.expertSelected') || '已选中'))
                  : undefined}
              />
            ))}
          </div>

          {selectedExpert && (
            <div className={styles.expertConfigPanel}>
              <div className={styles.expertConfigTitle}>{t('channel.expertConfigTitle') || '待加入顾问'}</div>
              <div className={styles.expertConfigName}>{expertName(selectedExpert)}</div>
              <label className={styles.channelOverlayLabel}>{t('settings.agent.chatModel') || '使用模型'}</label>
              <select
                className={styles.channelOverlayInput}
                value={selectedModelValue}
                onChange={(e) => setSelectedModelValue(e.target.value)}
              >
                <option value="">{t('channel.expertModelAuto') || '默认（优先推荐 / 当前可用模型）'}</option>
                {visibleModels.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.label}
                  </option>
                ))}
              </select>
              <p className={styles.expertConfigHint}>
                {selectedExpert.model_binding?.preferred
                  ? `${t('channel.expertRecommendedModel') || '推荐模型'}：${selectedExpert.model_binding.preferred}`
                  : (t('channel.expertModelFallback') || '未单独指定时，会使用推荐模型或当前可用模型')}
              </p>
              <div className={styles.channelOverlayActions}>
                <button
                  className={styles.channelOverlayConfirm}
                  onClick={handleCreateWithExpert}
                  disabled={creating}
                >
                  {creating
                    ? (t('channel.expertCreating') || '创建中...')
                    : (t('channel.expertCreateChannel') || '创建与 Ta 的频道')}
                </button>
              </div>
            </div>
          )}

          {hasRoundtableSelection && (
            <div className={styles.expertConfigPanel}>
              <div className={styles.expertConfigTitle}>{t('channel.expertTeam.roundtableTitle') || '圆桌会议'}</div>
              <div className={styles.expertConfigName}>
                {selectedExperts.map((expert) => expertName(expert)).join('、')}
              </div>
              <label className={styles.channelOverlayLabel}>{t('channel.createIntro') || '频道介绍'}</label>
              <input
                className={styles.channelOverlayInput}
                type="text"
                value={roundtableTopic}
                placeholder={t('channel.expertTeam.roundtablePlaceholder') || '比如：一起讨论当前项目的下一步'}
                onChange={(e) => setRoundtableTopic(e.target.value)}
              />
              <p className={styles.expertConfigHint}>
                {t('channel.expertTeam.roundtableHint') || '会先创建多个专家，再自动拉起一个多专家讨论频道。'}
              </p>
              <div className={styles.channelOverlayActions}>
                <button
                  className={styles.channelOverlayConfirm}
                  onClick={handleCreateRoundtable}
                  disabled={creating}
                >
                  {creating
                    ? (t('channel.expertCreating') || '创建中...')
                    : (t('channel.expertTeam.roundtableCreate') || '启动圆桌会议')}
                </button>
              </div>
            </div>
          )}
        </>
      )}

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

      <p className={styles.expertGuideTip}>{t('channel.expertTeam.guideTip')}</p>
    </div>
  );
}
