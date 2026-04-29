/**
 * AgentDiscoveryDialog.tsx — 已安装 AI 工具技能自动发现弹窗
 *
 * 首次启动时，如果检测到设备上存在其他 AI 工具的技能库，
 * 弹窗告知用户启用后的好处，用户可一键启用或稍后再说。
 */

import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { useDialogA11y } from '../hooks/use-dialog-a11y';

interface DiscoveredAgent {
  dirPath: string;
  label?: string;
}

export function AgentDiscoveryDialog() {
  const { t } = useI18n();
  const visible = useStore(s => s.agentDiscoveryVisible);
  const agents = useStore(s => s.discoveredAgents);

  const dismiss = () => {
    try { localStorage.setItem('agent-discovery-seen', 'true'); } catch { /* localStorage may be unavailable */ }
    useStore.setState({ agentDiscoveryVisible: false });
  };

  const dialogRef = useDialogA11y({ open: visible && agents.length > 0, onClose: dismiss });

  if (!visible || agents.length === 0) return null;

  const enableAll = async () => {
    try {
      const paths = (agents as DiscoveredAgent[]).map((a) => a.dirPath);
      await hanaFetch('/api/skills/external-paths', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
    } catch (err) {
      console.warn('[AgentDiscovery] enable failed:', err);
    }
    dismiss();
  };

  // 只取前 5 个，超出的折叠
  const shown = agents.slice(0, 5);
  const rest = agents.length - shown.length;

  return (
    <div className="hana-warning-overlay" onClick={dismiss}>
      <div
        ref={dialogRef}
        className="hana-warning-box"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-discovery-title"
        tabIndex={-1}
      >
        <h3 id="agent-discovery-title" className="hana-warning-title">{t('agentDiscovery.title')}</h3>
        <div className="hana-warning-body">
          <p>{t('agentDiscovery.body')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '10px 0', justifyContent: 'center' }}>
            {(shown as DiscoveredAgent[]).map((agent) => (
              <span
                key={agent.dirPath}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '3px 10px',
                  borderRadius: '999px',
                  background: 'rgba(var(--accent-rgb), 0.10)',
                  color: 'var(--accent)',
                  fontSize: '0.82rem',
                  fontWeight: 500,
                }}
              >
                {agent.label}
              </span>
            ))}
            {rest > 0 && (
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', alignSelf: 'center' }}>
                +{rest}
              </span>
            )}
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #aaa)', marginTop: '6px', lineHeight: 1.5 }}>
            {t('agentDiscovery.benefit')}
          </p>
        </div>
        <div className="hana-warning-actions">
          <button className="hana-warning-cancel" onClick={dismiss}>
            {t('agentDiscovery.later')}
          </button>
          <button className="hana-warning-confirm" onClick={enableAll}>
            {t('agentDiscovery.enable')}
          </button>
        </div>
      </div>
    </div>
  );
}
