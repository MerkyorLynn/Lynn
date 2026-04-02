/**
 * ExpertCard — 专家卡片组件
 *
 * 显示专家头像、名称、推荐模型、思维风格与描述。
 * 点击只是选中，不会立刻入群。
 */

import { useMemo, useState } from 'react';
import { useI18n } from '../../hooks/use-i18n';
import { hanaUrl } from '../../hooks/use-hana-fetch';
import { yuanFallbackAvatar } from '../../utils/agent-helpers';
import type { ExpertPreset } from '../../types';
import styles from './Channels.module.css';

function expertYuanProfile(category: string | undefined): { key: string; label: string; emoji: string } {
  const MING = new Set(['finance', 'legal', 'business', 'tech', 'engineering', 'data']);
  const BUTTER = new Set(['wellness', 'psychology', 'education', 'creative']);
  if (MING.has(category || '')) return { key: 'ming', label: '逻辑拆解', emoji: '🧊' };
  if (BUTTER.has(category || '')) return { key: 'butter', label: '共情洞察', emoji: '🌸' };
  return { key: 'hanako', label: '平衡通用', emoji: '✿' };
}

function displayText(value: string | Record<string, string> | undefined, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return value.zh || value['zh-CN'] || value.en || Object.values(value)[0] || fallback;
  }
  return fallback;
}

interface ExpertCardProps {
  expert: ExpertPreset;
  onSelect: (slug: string) => void;
  disabled?: boolean;
  selected?: boolean;
  actionLabel?: string;
}

export function ExpertCard({ expert, onSelect, disabled, selected = false, actionLabel }: ExpertCardProps) {
  const { t } = useI18n();
  const yuan = expertYuanProfile(expert.category);
  const name = displayText(expert.name, expert.slug);
  const description = displayText(expert.description, '');
  const [avatarError, setAvatarError] = useState(false);
  const avatarSrc = useMemo(() => {
    if (!expert.avatarUrl) return null;
    return hanaUrl(expert.avatarUrl);
  }, [expert.avatarUrl]);

  return (
    <button
      type="button"
      className={`${styles.expertTplCard}${selected ? ` ${styles.expertTplCardSelected}` : ''}`}
      onClick={() => onSelect(expert.slug)}
      disabled={disabled}
      aria-pressed={selected}
    >
      <span className={styles.expertTplAvatar}>
        {avatarSrc && !avatarError ? (
          <img
            src={avatarSrc}
            className={styles.expertTplAvatarImg}
            alt={name}
            onError={() => setAvatarError(true)}
          />
        ) : (
          <img
            src={yuanFallbackAvatar(yuan.key)}
            className={styles.expertTplAvatarImg}
            alt={name}
          />
        )}
      </span>
      <span className={styles.expertTplText}>
        <span className={styles.expertTplLabel}>{name}</span>
        <span className={styles.expertTplDesc}>{description}</span>
        <span className={styles.expertCardMeta}>
          <span className={styles.expertCardYuan} title={t('expert.yuanStyle') || 'Thinking style'}>
            {yuan.emoji} {yuan.label}
          </span>
          {expert.model_binding?.preferred && (
            <span className={styles.expertCardModel} title={t('expert.recommendedModel') || 'Recommended model'}>
              ⚡ {expert.model_binding.preferred}
            </span>
          )}
          {actionLabel && <span className={styles.expertCardAction}>{actionLabel}</span>}
        </span>
      </span>
    </button>
  );
}
