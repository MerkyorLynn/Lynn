/**
 * ChannelWarningModal — 频道启用确认对话框
 *
 * 替代原先命令式 DOM 构建的 showChannelWarning()，
 * 用 React 组件 + 全局 CSS class 渲染确认弹窗。
 */

import { useI18n } from '../../hooks/use-i18n';
import { useDialogA11y } from '../../hooks/use-dialog-a11y';

interface ChannelWarningModalProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ChannelWarningModal({ open, onConfirm, onCancel }: ChannelWarningModalProps) {
  const { t } = useI18n();
  const dialogRef = useDialogA11y({ open, onClose: onCancel });

  if (!open) return null;

  const bodyText = t('channel.warningBody') || '';
  const paragraphs = bodyText.split('\n\n');

  return (
    <div className="hana-warning-overlay" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="hana-warning-box"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-warning-title"
        tabIndex={-1}
      >
        <h3 id="channel-warning-title" className="hana-warning-title">{t('channel.warningTitle')}</h3>
        <div className="hana-warning-body">
          {paragraphs.map((para, i) => {
            const lines = para.split('\n');
            return (
              <p key={`warning-para-${i}`}>
                {lines.map((line, j) => (
                  j === 0
                    ? <span key={`warning-line-${i}-${j}`}>{line}</span>
                    : <span key={`warning-line-${i}-${j}`}><br />{line}</span>
                ))}
              </p>
            );
          })}
        </div>
        <div className="hana-warning-actions">
          <button className="hana-warning-cancel" onClick={onCancel}>
            {t('channel.createCancel')}
          </button>
          <button className="hana-warning-confirm" onClick={onConfirm}>
            {t('channel.warningConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
