import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../stores';
import { sendPrompt } from '../stores/prompt-actions';
import { requestRuntimeSnapshotRefresh } from '../utils/runtime-snapshot';
import { formatCompactModelLabel } from '../utils/brain-models';
import { loadDeskAutomationStatus, loadDeskPatrolStatus } from '../stores/desk-actions';
import { collectSessionDiffs } from '../utils/change-review';
import { isChineseLocale } from '../utils/locale';

function joinSummary(parts: string[]) {
  return parts.filter(Boolean).join('、');
}

type CapabilityChip = {
  key: string;
  label: string;
  count?: number;
  tone?: 'default' | 'quiet' | 'attention';
  onClick?: () => void;
  title?: string;
};

export function SidebarCapabilityBar() {
  // 订阅 locale：语言切换后要立刻重渲染，否则 tt() 仍拿到上一次的文案。
  const locale = useStore((s) => s.locale);
  const tt = useCallback((key: string, zhFallback: string, enFallback?: string) => {
    const value = window.t ? window.t(key) : key;
    if (value && value !== key) return value;
    return isChineseLocale(locale) ? zhFallback : (enFallback ?? zhFallback);
  }, [locale]);
  const currentAgentId = useStore((s) => s.currentAgentId);
  const agentName = useStore((s) => s.agentName) || 'Lynn';
  const agentYuan = useStore((s) => s.agentYuan) || 'lynn';
  const [expanded, setExpanded] = useState(false);
  const automationCount = useStore((s) => s.automationCount);
  const capabilitySnapshot = useStore((s) => s.capabilitySnapshot);
  const taskSnapshot = useStore((s) => s.taskSnapshot);
  const deskPatrolStatus = useStore((s) => s.deskPatrolStatus);
  const deskAutomationStatus = useStore((s) => s.deskAutomationStatus);
  const currentSessionPath = useStore((s) => s.currentSessionPath);
  const chatSessions = useStore((s) => s.chatSessions);

  // 改动摘要 chip
  const sessionItems = useMemo(
    () => (currentSessionPath ? chatSessions[currentSessionPath]?.items || [] : []),
    [chatSessions, currentSessionPath],
  );
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

  const openCapabilityPanel = useCallback((target: 'skills') => {
    useStore.setState({ welcomeVisible: false });
    window.dispatchEvent(new CustomEvent('desk-capability-open', { detail: { target } }));
  }, []);

  const openAutomationPanel = useCallback(() => {
    useStore.setState({
      welcomeVisible: false,
      activePanel: 'automation',
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

  const patrolLabel = deskPatrolStatus?.text || tt('desk.patrolIdle', '工作地图会在巡检后更新状态');
  const automationLabel = deskAutomationStatus?.text || tt('desk.automationIdle', '自动任务会从对话和工作台里的计划生成');

  const chips: CapabilityChip[] = [
    ...(automationCount > 0 ? [{
      key: 'automation',
      label: tt('sidebar.capability.automation', '自动任务'),
      count: automationCount,
      tone: 'attention' as const,
      onClick: openAutomationPanel,
    }] : []),
    ...(changesSummary.linesAdded + changesSummary.linesRemoved > 0 ? [{
      key: 'changes',
      label: `+${changesSummary.linesAdded} -${changesSummary.linesRemoved}`,
      tone: 'attention' as const,
      onClick: () => {
        useStore.setState({ welcomeVisible: false, activePanel: 'changes' });
      },
    }] : []),
    ...(expanded ? [{
      key: 'skills',
      label: tt('sidebar.capability.skillsCenter', '技能中心'),
      tone: 'quiet' as const,
      onClick: () => openCapabilityPanel('skills'),
    }] : []),
  ];

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
          </>
        )}
      </div>
      <div className="sidebar-capability-chips">
        {chips.map((chip) => {
          const content = (
            <>
              <span>{chip.label}</span>
              {typeof chip.count === 'number' && chip.count > 0 ? (
                <span className="sidebar-capability-chip-count">{Math.min(chip.count, 99)}</span>
              ) : null}
            </>
          );
          const className = `sidebar-capability-chip sidebar-capability-chip-${chip.tone || 'default'}${chip.onClick ? ' sidebar-capability-chip-button' : ''}`;
          return chip.onClick ? (
            <button
              key={chip.key}
              type="button"
              className={className}
              onClick={chip.onClick}
              title={chip.title}
            >
              {content}
            </button>
          ) : (
            <span key={chip.key} className={className}>{content}</span>
          );
        })}
        {expanded && (
          <button
            type="button"
            className="sidebar-capability-chip sidebar-capability-chip-action"
            onClick={insertAtHint}
          >
            {tt('sidebar.capability.tryAt', '@ 引用文件')}
          </button>
        )}
        {((tasks?.activeCount || 0) > 0 || expanded) && (
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
        )}
      </div>
    </div>
  );
}
