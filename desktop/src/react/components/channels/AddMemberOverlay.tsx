/**
 * AddMemberOverlay — 添加频道成员弹窗
 *
 * 两个区域：
 * 1. 已有 Agent — 复选框选择，排除已在频道中的成员
 * 2. 专家预设 — 先选中，再选模型，最后确认加入频道
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { hanaFetch, hanaUrl } from '../../hooks/use-hana-fetch';
import { addExpertToChannel, addMembersToChannel } from '../../stores/channel-actions';
import { yuanFallbackAvatar } from '../../utils/agent-helpers';
import { ExpertCard } from './ExpertCard';
import type { ExpertPreset, Model } from '../../types';
import styles from './Channels.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any -- API 响应 JSON 及 catch(err: any) */

let _avatarTs = Date.now();

type ExpertView = ExpertPreset;

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

function AgentChipAvatar({ agentId, yuan, hasAvatar }: {
  agentId: string; yuan?: string; hasAvatar?: boolean;
}) {
  const [error, setError] = useState(false);
  const src = hasAvatar ? hanaUrl(`/api/agents/${agentId}/avatar?t=${_avatarTs}`) : null;

  return (
    <span className={styles.chipAvatar}>
      {src && !error ? (
        <img
          src={src}
          className={styles.chipAvatarImg}
          onError={() => setError(true)}
        />
      ) : (
        <img src={yuanFallbackAvatar(yuan)} className={styles.chipAvatarImg} />
      )}
    </span>
  );
}

function expertName(expert: ExpertView | null): string {
  if (!expert) return '';
  return typeof expert.name === 'string' ? expert.name : (expert.name.zh || expert.name.en || expert.slug);
}

export function AddMemberOverlay() {
  const { t } = useI18n();
  const agents = useStore(s => s.agents);
  const visible = useStore(s => s.addMemberOverlayVisible);
  const setVisible = useStore(s => s.setAddMemberOverlayVisible);
  const targetChannel = useStore(s => s.addMemberTargetChannel);
  const channels = useStore(s => s.channels);
  const channelMembers = useStore(s => s.channelMembers);
  const addToast = useStore(s => s.addToast);

  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [experts, setExperts] = useState<ExpertView[]>([]);
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [selectedExpertSlug, setSelectedExpertSlug] = useState<string | null>(null);
  const [selectedModelValue, setSelectedModelValue] = useState('');

  const currentChannelData = channels.find(ch => ch.id === targetChannel);
  const existingMembers = currentChannelData?.members || channelMembers || [];
  const availableAgents = useMemo(
    () => agents.filter(a => !existingMembers.includes(a.id)),
    [agents, existingMembers],
  );
  const selectedExpert = useMemo(
    () => experts.find((expert) => expert.slug === selectedExpertSlug) || null,
    [experts, selectedExpertSlug],
  );

  useEffect(() => {
    if (!visible) return;

    _avatarTs = Date.now();
    setSelectedMembers([]);
    setAdding(false);
    setSelectedExpertSlug(null);
    setSelectedModelValue('');

    (async () => {
      try {
        const [expertsRes, modelsRes] = await Promise.all([
          hanaFetch('/api/experts'),
          hanaFetch('/api/models'),
        ]);
        const expertsData = await expertsRes.json().catch(() => ({}));
        const modelsData = await modelsRes.json().catch(() => ({}));
        setExperts(expertsData.experts || []);
        setAvailableModels(modelsData.models || []);
      } catch {
        setExperts([]);
        setAvailableModels([]);
      }
    })();
  }, [visible]);

  const toggleMember = useCallback((agentId: string) => {
    setSelectedMembers((prev) => (
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId]
    ));
  }, []);

  const handleCancel = useCallback(() => {
    setVisible(false);
  }, [setVisible]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setVisible(false);
    }
  }, [setVisible]);

  const handleSelectExpert = useCallback((slug: string) => {
    setSelectedExpertSlug((prev) => prev === slug ? null : slug);
    setSelectedModelValue('');
  }, []);

  const handleConfirm = useCallback(async () => {
    if (adding || !targetChannel) return;
    if (selectedMembers.length === 0 && !selectedExpertSlug) return;

    setAdding(true);
    try {
      if (selectedMembers.length > 0) {
        await addMembersToChannel(targetChannel, selectedMembers);
      }
      if (selectedExpertSlug) {
        const selectedModel = decodeModelValue(selectedModelValue);
        await addExpertToChannel(targetChannel, selectedExpertSlug, {
          modelId: selectedModel.id,
          provider: selectedModel.provider,
        });
      }
      setVisible(false);
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      addToast(`${t('channel.addMemberFailed') || 'Add failed'}: ${msg}`, 'error');
      console.error('[AddMemberOverlay] add members failed:', err);
    } finally {
      setAdding(false);
    }
  }, [addToast, adding, selectedExpertSlug, selectedMembers, selectedModelValue, setVisible, t, targetChannel]);

  return (
    <div
      className={`${styles.channelOverlay}${visible ? ` ${styles.channelOverlayVisible}` : ''}`}
      onClick={handleOverlayClick}
    >
      <div className={styles.channelOverlayCard}>
        <h3 className={styles.channelOverlayTitle}>{t('channel.addMemberTitle')}</h3>

        <div className={styles.channelOverlayField}>
          <label className={styles.channelOverlayLabel}>{t('channel.addMemberAgents')}</label>
          {availableAgents.length > 0 ? (
            <div className={styles.channelCreateMembers}>
              {availableAgents.map((agent) => {
                const isSelected = selectedMembers.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className={`${styles.channelCreateMemberChip}${isSelected ? ` ${styles.channelCreateMemberChipSelected}` : ''}`}
                    onClick={() => toggleMember(agent.id)}
                  >
                    <AgentChipAvatar agentId={agent.id} yuan={agent.yuan} hasAvatar={agent.hasAvatar} />
                    <span>{agent.name || agent.id}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className={styles.channelOverlayHint}>
              {t('channel.addMemberNone')}
            </p>
          )}
        </div>

        {experts.length > 0 && (
          <div className={styles.channelOverlayField}>
            <label className={styles.channelOverlayLabel}>{t('channel.addMemberExperts')}</label>
            <p className={styles.channelOverlayHint}>
              {t('channel.expertSelectHint') || '先选顾问，再选模型，最后确认加入频道'}
            </p>
            <div className={styles.expertTemplates}>
              {experts.map((expert) => (
                <ExpertCard
                  key={expert.slug}
                  expert={expert}
                  onSelect={handleSelectExpert}
                  disabled={adding}
                  selected={expert.slug === selectedExpertSlug}
                  actionLabel={expert.slug === selectedExpertSlug ? (t('channel.expertSelected') || '已选中') : undefined}
                />
              ))}
            </div>
          </div>
        )}

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
          </div>
        )}

        <div className={styles.channelOverlayActions}>
          <button className={styles.channelOverlayCancel} onClick={handleCancel}>
            {t('channel.createCancel')}
          </button>
          <button
            className={styles.channelOverlayConfirm}
            onClick={handleConfirm}
            disabled={adding || (selectedMembers.length === 0 && !selectedExpertSlug)}
          >
            {adding
              ? (t('channel.expertAdding') || '处理中...')
              : (t('channel.addMemberConfirm') || '添加')}
          </button>
        </div>
      </div>
    </div>
  );
}
