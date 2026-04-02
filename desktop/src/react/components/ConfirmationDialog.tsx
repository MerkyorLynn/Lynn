import { useState } from 'react';
import { useStore } from '../stores';
import { useDialogA11y } from '../hooks/use-dialog-a11y';


export function ConfirmationDialog() {
  const confirm = useStore(s => s.pendingConfirm);
  const setPendingConfirm = useStore(s => s.setPendingConfirm);
  const [busy, setBusy] = useState(false);

  const handleCancel = () => {
    if (busy) return;
    confirm?.onCancel?.();
    setPendingConfirm(null);
  };

  const handleConfirm = async () => {
    if (busy || !confirm) return;
    setBusy(true);
    try {
      await confirm.onConfirm();
      setPendingConfirm(null);
    } catch {
      // Keep the dialog open on failure so callers can surface errors and let users retry.
    } finally {
      setBusy(false);
    }
  };

  const dialogRef = useDialogA11y({ open: !!confirm, onClose: handleCancel });

  if (!confirm) return null;

  return (
    <div className="hana-warning-overlay" onClick={handleCancel}>
      <div
        ref={dialogRef}
        className="hana-warning-box hana-confirm-box"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-dialog-title"
        tabIndex={-1}
      >
        <h3 id="confirmation-dialog-title" className="hana-warning-title">{confirm.title || window.t?.('common.confirm') || 'Confirm'}</h3>
        <div className="hana-warning-body">
          <p>{confirm.message}</p>
          {confirm.detail ? <p className="hana-confirm-detail">{confirm.detail}</p> : null}
        </div>
        <div className="hana-warning-actions">
          <button className="hana-warning-cancel" onClick={handleCancel} disabled={busy}>
            {confirm.cancelLabel || window.t?.('common.cancel') || 'Cancel'}
          </button>
          <button className="hana-warning-confirm" onClick={handleConfirm} disabled={busy}>
            {busy ? (window.t?.('common.executing') || 'Executing...') : (confirm.confirmLabel || window.t?.('common.confirm') || 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
