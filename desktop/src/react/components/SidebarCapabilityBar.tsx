import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../stores';
import { sendPrompt } from '../stores/prompt-actions';
import { requestRuntimeSnapshotRefresh } from '../utils/runtime-snapshot';
import { formatCompactModelLabel } from '../utils/brain-models';
import { loadDeskAutomationStatus, loadDeskPatrolStatus } from '../stores/desk-actions';
import { collectSessionDiffs } from '../utils/change-review';

function joinSummary(parts: string[]) {
  return parts.filter(Boolean).join('、');
}

function countJianTodos(content: string | null) {
  const text = String(content || '');
  const matches = text.match(/^- \[( |x|X)\] /gm) || [];
  const done = matches.filter((item) => /\[(x|X)\]/.test(item)).length;
  const pending = matches.length - done;
  return { pending, done };
}

function summarizeJianFocus(content: string | null) {
  const lines = String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const preferred = lines.find((line) => /^- \[ \] /.test(line))
    || lines.find((line) => line.startsWith('# '))
    || lines.find((line) => !line.startsWith('>'));
  if (!preferred) return '';
  const normalized = preferred
    .replace(/^#\s+/, '')
    .replace(/^- \[[ xX]\]\s+/, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .trim();
  if (!normalized) return '';
  return normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized;
}

function getJianPendingPreviews(content: string | null, max = 3): string[] {
  return String(content || '')
    .split('\n')
    .filter((line) => /^- \[ \] /.test(line.trim()))
    .slice(0, max)
    .map((line) => {
      const text = line.trim().replace(/^- \[ \]\s+/, '').replace(/\[(.*?)\]\((.*?)\)/g, '$1').trim();
      return text.length > 24 ? `${text.slice(0, 24)}…` : text;
    });
}

export function SidebarCapabilityBar() {
  const t = window.t ?? ((key: string) => key);
  const tt = useCallback((key: string, fallback: string) => {
    const value = t(key);
    return !value || value === key ? fallback : value;
  }, [t]);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const agentName = useStore((s) => s.agentName) || 'Lynn';
  const agentYuan = useStore((s: any) => s.agentYuan) || 'lynn';
  const [expanded, setExpanded] = useState(false);
  const deskJianContent = useStore((s) => s.deskJianContent);
  const automationCount = useStore((s) => s.automationCount);
  const capabilitySnapshot = useStore((s) => s.capabilitySnapshot);
  const taskSnapshot = useStore((s) => s.taskSnapshot);
  const deskPatrolStatus = useStore((s) => s.deskPatrolStatus);
  const deskAutomationStatus = useStore((s) => s.deskAutomationStatus);
  const currentSessionPath = useStore((s) => s.currentSessionPath);
  const chatSessions = useStore((s) => s.chatSessions);

  // 改动摘要 chip
  const sessionItems = currentSessionPath ? chatSessions[currentSessionPath]?.items || [] : [];
  const changesSummary = useMemo(() => collectSessionDiffs(sessionItems), [sessionItems]);
  const models = useStore((s) => s.models);
  const currentModel = useStore((s) => s.currentModel);
  const currentModelName = formatCompactModelLabel(currentModel, { role: agentYuan, purpose: 'chat' })
    || models.find((model) => model.isCurrent)?.name
    || tt('input.embeddedModel.name', '默认模型');

  // 模型特点标签
  const currentModelObj = models.find((m) =>
    m.id === currentModel?.id && m.provider === currentModel?.provider,
  ) || models.find((m) => m.isCurrent);
  const modelTags: string[] = [];
  if (currentModelObj?.reasoning) modelTags.push(tt('sidebar.capability.modelTag.reasoning', '推理'));
  if (currentModelObj?.vision) modelTags.push(tt('sidebar.capability.modelTag.vision', '视觉'));
  if (currentModelObj?.contextWindow && currentModelObj.contextWindow >= 128000) modelTags.push(tt('sidebar.capability.modelTag.longCtx', '长上下文'));
  if (!currentModelObj?.reasoning && !modelTags.length) modelTags.push(tt('sidebar.capability.modelTag.fast', '通用'));

  const startQuickPrompt = useCallback(async (prompt: string) => {
    useStore.setState({ welcomeVisible: false });
    await sendPrompt({ text: prompt, displayText: prompt });
  }, []);

  const insertAtHint = useCallback(() => {
    useStore.setState({
      welcomeVisible: false,
      composerText: '@',
    });
    useStore.getState().requestInputFocus();
  }, []);

  const openCapabilityPanel = useCallback((target: 'skills' | 'mcp') => {
    useStore.setState({ welcomeVisible: false });
    window.dispatchEvent(new CustomEvent('desk-capability-open', { detail: { target } }));
  }, []);

  const openAutomationPanel = useCallback(() => {
    useStore.setState({
      welcomeVisible: false,
      activePanel: 'automation',
    });
  }, []);

  const openDeskPanel = useCallback(() => {
    useStore.setState({
      welcomeVisible: false,
      jianOpen: true,
    });
  }, []);

  useEffect(() => {
    void loadDeskPatrolStatus();
    void loadDeskAutomationStatus();
    requestRuntimeSnapshotRefresh();
  }, [currentAgentId]);

  useEffect(() => {
    const refresh = () => requestRuntimeSnapshotRefresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('hana-task-updated', refresh);
    window.addEventListener('review-config-changed', refresh);
    window.addEventListener('skills-changed', refresh);
    window.addEventListener('models-changed', refresh);
    window.addEventListener('hana-activity-updated', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('hana-task-updated', refresh);
      window.removeEventListener('review-config-changed', refresh);
      window.removeEventListener('skills-changed', refresh);
      window.removeEventListener('models-changed', refresh);
      window.removeEventListener('hana-activity-updated', refresh);
    };
  }, []);

  useEffect(() => {
    const refreshDesk = () => {
      void loadDeskPatrolStatus();
      void loadDeskAutomationStatus();
    };
    window.addEventListener('focus', refreshDesk);
    window.addEventListener('hana-task-updated', refreshDesk);
    window.addEventListener('hana-activity-updated', refreshDesk);
    return () => {
      window.removeEventListener('focus', refreshDesk);
      window.removeEventListener('hana-task-updated', refreshDesk);
      window.removeEventListener('hana-activity-updated', refreshDesk);
    };
  }, []);

  const capabilities = capabilitySnapshot || null;
  const tasks = taskSnapshot || null;
  const summary = (() => {
    const parts = [
      tt('sidebar.capability.web', '会搜网页'),
      tt('sidebar.capability.files', '改文件'),
      tt('sidebar.capability.shell', '跑命令'),
    ];
    if (Number(capabilities?.projectInstructions?.layers || 0) > 0) parts.push(tt('sidebar.capability.instructions', '已读项目指令'));
    if ((capabilities?.mcp?.tools || 0) > 0) parts.push(tt('sidebar.capability.mcp', '能用 MCP'));
    return joinSummary(parts);
  })();

  const continueLabel = (() => {
    const currentLabel = tasks?.recent?.find((item) => item?.currentLabel)?.currentLabel;
    if (currentLabel) return currentLabel;
    if ((tasks?.activeCount || 0) > 0) {
      return tt('sidebar.capability.continueBusy', '有任务正在推进');
    }
    return tt('sidebar.capability.continueIdle', '工作区就绪 · 试试"帮我看看项目"');
  })();

  const jianStats = countJianTodos(deskJianContent);
  const jianFocus = summarizeJianFocus(deskJianContent);
  const jianPreviews = getJianPendingPreviews(deskJianContent);
  const patrolLabel = deskPatrolStatus?.text || tt('desk.patrolIdle', '打开笺后会自动巡检一次');
  const automationLabel = deskAutomationStatus?.text || tt('desk.automationIdle', '笺里的重复待办会自动变成自动任务');

  const chips = [
    {
      key: 'todo',
      label: `${tt('sidebar.capability.todo', '待办')} ${jianStats.pending}`,
      onClick: openDeskPanel,
    },
    {
      key: 'done',
      label: `${tt('sidebar.capability.done', '完成')} ${jianStats.done}`,
      onClick: openDeskPanel,
    },
    {
      key: 'automation',
      label: `${tt('sidebar.capability.automation', '自动任务')} ${automationCount || 0}`,
      onClick: openAutomationPanel,
    },
    ...(changesSummary.linesAdded + changesSummary.linesRemoved > 0 ? [{
      key: 'changes',
      label: `+${changesSummary.linesAdded} -${changesSummary.linesRemoved}`,
      onClick: () => {
        useStore.setState({ welcomeVisible: false, activePanel: 'changes' });
      },
    }] : []),
    {
      key: 'skills',
      label: tt('sidebar.capability.skillsCenter', '技能中心'),
      onClick: () => openCapabilityPanel('skills'),
    },
    {
      key: 'mcp',
      label: tt('sidebar.capability.mcpHub', 'MCP 接入'),
      onClick: () => openCapabilityPanel('mcp'),
    },
  ].filter(Boolean) as Array<{ key: string; label: string; onClick?: () => void }>;

  return (
    <div className="sidebar-capability-bar">
      <div className="sidebar-capability-name" onClick={() => setExpanded(!expanded)} role="button" tabIndex={0} style={{ cursor: 'pointer' }}>
        {agentName}
        <span className={`sidebar-capability-expand-arrow${expanded ? ' expanded' : ''}`}>▾</span>
      </div>
      <div className="sidebar-capability-summary">{summary}</div>
      <div className="sidebar-capability-state">
        <div className="sidebar-capability-state-line">
          <span className="sidebar-capability-state-label">{tt('sidebar.capability.state', '现在')}</span>
          <span>{continueLabel}</span>
        </div>
        {expanded && (
          <>
            <div className="sidebar-capability-state-line">
              <span className="sidebar-capability-state-label">{tt('sidebar.capability.model', '模型')}</span>
              <span>
                {currentModelName}
                {modelTags.length > 0 && (
                  <span className="sidebar-capability-model-tags">
                    {modelTags.map((tag) => (
                      <span key={tag} className="sidebar-capability-model-tag">{tag}</span>
                    ))}
                  </span>
                )}
              </span>
            </div>
            <div className="sidebar-capability-state-line">
              <span className="sidebar-capability-state-label">{tt('sidebar.capability.patrol', '巡检')}</span>
              <span>{patrolLabel}</span>
            </div>
            <div className="sidebar-capability-state-line">
              <span className="sidebar-capability-state-label">{tt('sidebar.capability.automation', '自动任务')}</span>
              <span>{automationLabel}</span>
            </div>
            {jianFocus ? (
              <div className="sidebar-capability-state-line">
                <span className="sidebar-capability-state-label">{tt('sidebar.capability.jian', '笺')}</span>
                <span>{jianFocus}</span>
              </div>
            ) : null}
            {jianPreviews.length > 0 && (
              <div className="sidebar-capability-jian-previews" onClick={openDeskPanel} role="button" tabIndex={0}>
                {jianPreviews.map((text, i) => (
                  <div key={i} className="sidebar-capability-jian-preview-item">
                    <span className="sidebar-capability-jian-checkbox">☐</span>
                    <span>{text}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className="sidebar-capability-chips">
        {chips.map((chip) => (
          chip.onClick ? (
            <button
              key={chip.key}
              type="button"
              className="sidebar-capability-chip sidebar-capability-chip-button"
              onClick={chip.onClick}
            >
              {chip.label}
            </button>
          ) : (
            <span key={chip.key} className="sidebar-capability-chip">{chip.label}</span>
          )
        ))}
        <button
          type="button"
          className="sidebar-capability-chip sidebar-capability-chip-action"
          onClick={insertAtHint}
        >
          {tt('sidebar.capability.tryAt', '@ 引用文件')}
        </button>
        <button
          type="button"
          className="sidebar-capability-chip sidebar-capability-chip-action"
          onClick={() => {
            const prompt = (tasks?.activeCount || 0) > 0
              ? tt('sidebar.capability.resumePrompt', '继续刚才的任务，先告诉我当前进度和下一步。')
              : tt('sidebar.capability.workspacePrompt', '先快速读一下当前工作区，告诉我你会从哪里开始。');
            void startQuickPrompt(prompt);
          }}
        >
          {(tasks?.activeCount || 0) > 0
            ? tt('sidebar.capability.resumeTask', '继续任务')
            : tt('sidebar.capability.startWorkspace', '浏览工作区')}
        </button>
      </div>
    </div>
  );
}
