import { useCallback, useEffect, useState } from 'react';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from '../stores';

type CapabilitySnapshot = {
  enabledSkills?: number;
  learnedSkills?: number;
  externalSkills?: number;
  mcp?: {
    servers?: number;
    tools?: number;
  };
  projectInstructions?: {
    layers?: number;
    files?: string[];
  };
};

function joinSummary(parts: string[]) {
  return parts.filter(Boolean).join('、');
}

export function SidebarCapabilityBar() {
  const t = window.t ?? ((key: string) => key);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const agentName = useStore((s) => s.agentName) || 'Lynn';
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null);

  const loadSnapshot = useCallback(async () => {
    try {
      const res = await hanaFetch('/api/app-state');
      const data = await res.json();
      setSnapshot(data?.capabilities || null);
    } catch {
      setSnapshot(null);
    }
  }, []);

  useEffect(() => {
    void loadSnapshot();
  }, [currentAgentId, loadSnapshot]);

  useEffect(() => {
    const refresh = () => void loadSnapshot();
    window.addEventListener('focus', refresh);
    window.addEventListener('review-config-changed', refresh);
    window.addEventListener('skills-changed', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('review-config-changed', refresh);
      window.removeEventListener('skills-changed', refresh);
    };
  }, [loadSnapshot]);

  const summary = (() => {
    const parts = [
      t('sidebar.capability.web') || '会搜网页',
      t('sidebar.capability.files') || '改文件',
      t('sidebar.capability.shell') || '跑命令',
    ];
    if ((snapshot?.projectInstructions?.layers || 0) > 0) parts.push(t('sidebar.capability.instructions') || '已读项目指令');
    if ((snapshot?.mcp?.tools || 0) > 0) parts.push(t('sidebar.capability.mcp') || '能用 MCP');
    return joinSummary(parts);
  })();

  const chips = [
    { key: 'skills', label: `${t('sidebar.capability.skills') || '技能'} ${snapshot?.enabledSkills || 0}` },
    { key: 'mcp', label: `MCP ${snapshot?.mcp?.servers || 0}` },
    { key: 'agents', label: `${t('sidebar.capability.projectRules') || '指令'} ${snapshot?.projectInstructions?.layers || 0}` },
  ];

  return (
    <div className="sidebar-capability-bar">
      <div className="sidebar-capability-name">{agentName}</div>
      <div className="sidebar-capability-summary">{summary}</div>
      <div className="sidebar-capability-chips">
        {chips.map((chip) => (
          <span key={chip.key} className="sidebar-capability-chip">{chip.label}</span>
        ))}
      </div>
    </div>
  );
}
