/**
 * AgentDiscoveryDialog.tsx — 其他 AI 智能体发现弹窗
 *
 * 首次启动时，如果检测到设备上存在其他 AI 工具（如 CodeBuddy）的技能库，
 * 弹窗展示发现结果，用户可一键启用技能复用或稍后再说。
 */

import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';

declare function t(key: string, vars?: Record<string, string | number>): string;

export function AgentDiscoveryDialog() {
  const visible = useStore(s => s.agentDiscoveryVisible);
  const agents = useStore(s => s.discoveredAgents);

  if (!visible || agents.length === 0) return null;

  const dismiss = () => {
    try { localStorage.setItem('agent-discovery-seen', 'true'); } catch {}
    useStore.setState({ agentDiscoveryVisible: false });
  };

  const enableAll = async () => {
    try {
      const paths = agents.map(a => a.dirPath);
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

  return (
    <div className="hana-warning-overlay" onClick={dismiss}>
      <div className="hana-warning-box" onClick={(e) => e.stopPropagation()}>
        <h3 className="hana-warning-title">{t('agentDiscovery.title')}</h3>
        <div className="hana-warning-body">
          <p>{t('agentDiscovery.body')}</p>
          <ul style={{ margin: '8px 0', paddingLeft: '1.2em' }}>
            {agents.map(agent => (
              <li key={agent.dirPath} style={{ marginBottom: 4 }}>
                <strong>{agent.label}</strong>
                <br />
                <span style={{ fontSize: '0.78rem', opacity: 0.7 }}>{agent.dirPath}</span>
              </li>
            ))}
          </ul>
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
