import React from 'react';
import { t } from '../../helpers';
import {
  getDisplayYuanEntries,
  isBundledLynnAvatarSrc,
  normalizeYuanKey,
  resolveBundledAvatar,
} from '../../../utils/agent-helpers';

const kongBannerUrl = 'assets/kong-banner.jpg';

export function YuanSelector({ currentYuan, onChange }: { currentYuan: string; onChange: (key: string) => void }) {
  const types = t('yuan.types') || {};
  const entries = getDisplayYuanEntries(types);
  const normalizedCurrentYuan = normalizeYuanKey(currentYuan);

  const chips = entries.filter(([k]) => k !== 'kong');

  return (
    <div className="yuan-selector">
      <div className="yuan-chips">
        {chips.map(([key, meta]) => (
          <button
            key={key}
            className={`yuan-chip${key === normalizedCurrentYuan ? ' selected' : ''}`}
            type="button"
            onClick={() => { if (key !== normalizedCurrentYuan) onChange(key); }}
          >
            {(() => {
              const avatarSrc = resolveBundledAvatar(meta.avatar || 'Lynn.png');
              const isBundledLynnAvatar = isBundledLynnAvatarSrc(avatarSrc);
              return (
                <span className="yuan-chip-avatar-shell">
                  <img
                    className={`yuan-chip-avatar${isBundledLynnAvatar ? ' yuan-chip-avatar-bundled-lynn' : ''}`}
                    src={avatarSrc}
                    draggable={false}
                  />
                </span>
              );
            })()}
            <div className="yuan-chip-info">
              <span className="yuan-chip-name">{meta.name || key}</span>
              <span className="yuan-chip-desc">{meta.label || ''}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
