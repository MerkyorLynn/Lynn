/**
 * ChannelCreateOverlay — 创建频道弹窗
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { hanaUrl } from '../../hooks/use-hana-fetch';
import { createChannel } from '../../stores/channel-actions';
import { yuanFallbackAvatar } from '../../utils/agent-helpers';
import styles from './Channels.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any -- catch(err: any) 提取 message */

let _avatarTs = Date.now();
export function refreshCreateAvatarTs() { _avatarTs = Date.now(); }

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

export function ChannelCreateOverlay() {
  const { t } = useI18n();
  const agents = useStore(s => s.agents);
  const currentAgentId = useStore(s => s.currentAgentId);
  const visible = useStore(s => s.channelCreateOverlayVisible);
  const setVisible = useStore(s => s.setChannelCreateOverlayVisible);

  const [name, setName] = useState('');
  const [intro, setIntro] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [membersError, setMembersError] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const baseAgent = useMemo(
    () => agents.find((agent) => agent.id === currentAgentId)
      || agents.find((agent) => agent.isPrimary)
      || agents[0]
      || null,
    [agents, currentAgentId],
  );

  const selectableAgents = useMemo(
    () => agents.filter((agent) => agent.id !== baseAgent?.id),
    [agents, baseAgent],
  );

  useEffect(() => {
    if (visible) {
      setName('');
      setIntro('');
      setSelectedMembers([]);
      setNameError(false);
      setMembersError(false);
      _avatarTs = Date.now();
      requestAnimationFrame(() => nameRef.current?.focus());
    }
  }, [visible]);

  const toggleMember = useCallback((agentId: string) => {
    setSelectedMembers((prev) => (
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId]
    ));
    setMembersError(false);
  }, []);

  const handleCancel = useCallback(() => {
    setVisible(false);
  }, [setVisible]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setVisible(false);
    }
  }, [setVisible]);

  const handleSubmit = useCallback(async () => {
    if (creating) return;
    if (!name.trim()) {
      nameRef.current?.focus();
      return;
    }
    if (!baseAgent || selectedMembers.length < 1) {
      setMembersError(true);
      setTimeout(() => setMembersError(false), 1500);
      return;
    }

    setCreating(true);
    try {
      const members = Array.from(new Set([baseAgent.id, ...selectedMembers]));
      await createChannel(name.trim(), members, intro.trim() || undefined);
      setVisible(false);
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (msg.includes('已存在') || msg.includes('409')) {
        setNameError(true);
        nameRef.current?.focus();
        setTimeout(() => setNameError(false), 2000);
      } else {
        setVisible(false);
      }
    } finally {
      setCreating(false);
    }
  }, [baseAgent, creating, intro, name, selectedMembers, setVisible]);

  const handleNameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') handleCancel();
  }, [handleCancel]);

  return (
    <div
      className={`${styles.channelOverlay}${visible ? ` ${styles.channelOverlayVisible}` : ''}`}
      onClick={handleOverlayClick}
    >
      <div className={styles.channelOverlayCard}>
        <h3 className={styles.channelOverlayTitle}>{t('channel.createTitle')}</h3>
        <div className={styles.channelOverlayField}>
          <label className={styles.channelOverlayLabel}>{t('channel.createName')}</label>
          <input
            ref={nameRef}
            className={styles.channelOverlayInput}
            type="text"
            placeholder={nameError ? t('channel.nameExists') : t('channel.createNamePlaceholder')}
            autoComplete="off"
            value={name}
            onChange={(e) => { setName(e.target.value); setNameError(false); }}
            onKeyDown={handleNameKeyDown}
            style={nameError ? { outline: '1.5px solid var(--danger, #c44)' } : undefined}
          />
        </div>

        <div className={styles.channelOverlayField}>
          <label className={styles.channelOverlayLabel}>{t('channel.createBaseAgent') || '已包含当前助手'}</label>
          {baseAgent ? (
            <div className={styles.channelCreateMembers}>
              <div className={`${styles.channelCreateMemberChip} ${styles.channelCreateMemberChipSelected} ${styles.channelCreateMemberChipLocked}`}>
                <AgentChipAvatar agentId={baseAgent.id} yuan={baseAgent.yuan} hasAvatar={baseAgent.hasAvatar} />
                <span>{baseAgent.name || baseAgent.id}</span>
              </div>
            </div>
          ) : (
            <p className={styles.channelOverlayHint}>
              {t('channel.createNeedAssistant') || '当前没有可用助手，无法创建频道'}
            </p>
          )}
        </div>

        <div className={styles.channelOverlayField}>
          <label className={styles.channelOverlayLabel}>{t('channel.createSelectAdvisors') || '再选择要加入的顾问'}</label>
          {selectableAgents.length > 0 ? (
            <div
              className={styles.channelCreateMembers}
              style={membersError ? { outline: '1.5px solid var(--danger, #c44)', borderRadius: '10px', padding: '6px' } : undefined}
            >
              {selectableAgents.map((agent) => {
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
              {t('channel.createNeedAdvisor') || '至少需要先有 1 位顾问智能体'}
            </p>
          )}
        </div>

        <div className={styles.channelOverlayField}>
          <label className={styles.channelOverlayLabel}>
            {t('channel.createIntro')}{' '}
            <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>
              {t('channel.createIntroOptional')}
            </span>
          </label>
          <textarea
            className={`${styles.channelOverlayInput} ${styles.channelCreateIntro}`}
            rows={2}
            placeholder={t('channel.createIntroPlaceholder')}
            style={{ resize: 'vertical', minHeight: '2.4rem' }}
            value={intro}
            onChange={(e) => setIntro(e.target.value)}
          />
        </div>
        <div className={styles.channelOverlayActions}>
          <button className={styles.channelOverlayCancel} onClick={handleCancel}>
            {t('channel.createCancel')}
          </button>
          <button className={styles.channelOverlayConfirm} onClick={handleSubmit} disabled={creating || !baseAgent}>
            {t('channel.createConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
