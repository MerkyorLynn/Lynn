/**
 * ExpertCard — 专家卡片组件
 *
 * 显示专家图标、名称、推荐模型、积分消耗、描述。
 * 点击触发 onSpawn 回调。
 */

import type { ExpertPreset } from '../../types';
import styles from './Channels.module.css';

interface ExpertCardProps {
  expert: ExpertPreset & { name: string; description: string };
  onSpawn: (slug: string) => void;
  disabled?: boolean;
  locale?: string;
}

export function ExpertCard({ expert, onSpawn, disabled }: ExpertCardProps) {
  return (
    <button
      className={styles.expertTplCard}
      onClick={() => onSpawn(expert.slug)}
      disabled={disabled}
    >
      <span className={styles.expertTplIcon}>{expert.icon}</span>
      <span className={styles.expertTplText}>
        <span className={styles.expertTplLabel}>{expert.name}</span>
        <span className={styles.expertTplDesc}>
          {expert.description}
        </span>
        <span className={styles.expertCardMeta}>
          {expert.model_binding?.preferred && (
            <span className={styles.expertCardModel}>
              {expert.model_binding.preferred}
            </span>
          )}
          {expert.credit_cost?.per_session > 0 && (
            <span className={styles.expertCardCost}>
              {expert.credit_cost.per_session} credits
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
