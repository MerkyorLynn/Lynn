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
import { createChannel, createChannelWithExpert } from '../../stores/channel-actions';
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

function encodeModelValue(model: Model): string {
  return `${model.provider || ''}::${model.id}`;
}

function decodeModelValue(value: string): { id?: string; provider?: string } {
  if (!value) return {};
  const splitIndex = value.indexOf('::');
  if (splitIndex === -1) return { id: value };
  return {
    provider: value.slice(0, splitIndex) || undefined,
    id: value.slice(splitIndex + 2) || undefined,
  };
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
  const [selectedExpertSlug, setSelectedExpertSlug] = useState<string | null>(null);
  const [selectedModelValue, setSelectedModelValue] = useState('');

  const hasEnoughAgents = agents.length >= 1;
  const selectedExpert = useMemo(
    () => experts.find((expert) => expert.slug === selectedExpertSlug) || null,
    [experts, selectedExpertSlug],
  );

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
    setSelectedExpertSlug((prev) => prev === slug ? null : slug);
    setSelectedModelValue('');
  }, []);

  const handleCreateWithExpert = useCallback(async () => {
    if (!selectedExpertSlug || creating) return;
    setCreating(true);
    try {
      const selectedModel = decodeModelValue(selectedModelValue);
      await createChannelWithExpert(selectedExpertSlug, {
        modelId: selectedModel.id,
        provider: selectedModel.provider,
      });
    } catch (err) {
      console.error('[ExpertTeamGuide] create with expert failed:', err);
    } finally {
      setCreating(false);
    }
  }, [creating, selectedExpertSlug, selectedModelValue]);

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
                selected={expert.slug === selectedExpertSlug}
                actionLabel={expert.slug === selectedExpertSlug ? (t('channel.expertSelected') || '已选中') : undefined}
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
                {availableModels.map((model) => (
                  <option key={`${model.provider}:${model.id}`} value={encodeModelValue(model)}>
                    {model.name || model.id}{model.provider ? ` · ${model.provider}` : ''}
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
