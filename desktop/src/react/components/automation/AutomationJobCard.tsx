import { cronToHuman } from '../../utils/format';
import fp from '../FloatingPanels.module.css';
import { formatAutomationDateTime } from './cron-utils';
import { folderLabel, resolveJobModelValue } from './job-utils';
import type { CronJob, ModelOption } from './types';

export function AutomationJobCard({
  job,
  modelOptions,
  isZh,
  defaultModelLabel,
  onToggle,
  onEdit,
  onRemove,
  onRunNow,
}: {
  job: CronJob;
  modelOptions: ModelOption[];
  isZh: boolean;
  defaultModelLabel: string;
  onToggle: (id: string) => void;
  onEdit: (job: CronJob) => void;
  onRemove: (id: string) => void;
  onRunNow: (id: string) => void;
}) {
  const selectedValue = resolveJobModelValue(job.model, modelOptions);
  const modelLabel = selectedValue
    ? modelOptions.find((option) => option.value === selectedValue)?.label || job.model || ''
    : defaultModelLabel;
  const workspaceLabel = folderLabel(job.workspace || null);
  const nextRunText = formatAutomationDateTime(job.nextRunAt || null);
  const lastRunText = formatAutomationDateTime(job.lastRunAt || job.latestRun?.finishedAt || job.latestRun?.timestamp || null);
  const latestRunStatus = String(job.latestRun?.status || job.latestActivity?.status || '').trim();
  const latestSummary = String(job.latestActivity?.summary || '').trim();
  const latestError = String(job.latestRun?.error || job.latestActivity?.error || '').trim();
  const hasRunRecord = Boolean(job.lastRunAt || job.latestRun || job.latestActivity);
  const statusLabel = latestRunStatus === 'success'
    ? (isZh ? '最近一次已完成' : 'Last run completed')
    : latestRunStatus === 'error'
      ? (isZh ? '最近一次失败' : 'Last run failed')
      : latestRunStatus === 'skipped'
        ? (isZh ? '最近一次跳过' : 'Last run skipped')
        : '';

  const openLatestResult = () => {
    const activityId = String(job.latestActivity?.id || '').trim();
    if (!activityId) return;
    window.dispatchEvent(new CustomEvent('hana-open-activity-session', { detail: { activityId } }));
  };

  const openLatestFile = () => {
    const filePath = String(job.latestActivity?.outputFile || '').trim();
    if (!filePath) return;
    window.platform?.openFile?.(filePath);
  };

  return (
    <div className={fp.automationJobCard}>
      <div className={fp.automationJobHead}>
        <div className={fp.automationJobTitle}>{job.label || job.prompt || job.id}</div>
        <button
          type="button"
          className={`${fp.automationJobSwitch}${job.enabled ? ` ${fp.automationJobSwitchOn}` : ''}`}
          onClick={() => onToggle(job.id)}
        >
          {job.enabled ? (isZh ? '已开启' : 'On') : (isZh ? '已暂停' : 'Paused')}
        </button>
      </div>
      <div className={fp.automationJobDesc}>{job.prompt || (isZh ? '暂无说明' : 'No description')}</div>
      <div className={fp.automationJobMeta}>
        <span className={fp.automationJobMetaChip}>{cronToHuman(job.schedule)}</span>
        <span className={fp.automationJobMetaChip}>{modelLabel}</span>
        {workspaceLabel ? <span className={fp.automationJobMetaChip}>{workspaceLabel}</span> : null}
        {nextRunText ? <span className={fp.automationJobMetaChip}>{isZh ? `下次 ${nextRunText}` : `Next ${nextRunText}`}</span> : null}
        {lastRunText ? <span className={fp.automationJobMetaChip}>{isZh ? `上次 ${lastRunText}` : `Last ${lastRunText}`}</span> : null}
      </div>
      {(statusLabel || latestSummary || latestError || !hasRunRecord) && (
        <div className={fp.automationJobResult}>
          {statusLabel ? <div className={fp.automationJobResultTitle}>{statusLabel}</div> : null}
          {latestSummary ? <div className={fp.automationJobResultSummary}>{latestSummary}</div> : null}
          {!latestSummary && latestError ? <div className={fp.automationJobResultError}>{latestError}</div> : null}
          {!latestSummary && !latestError && (statusLabel || !hasRunRecord) ? (
            <div className={fp.automationJobResultHint}>
              {hasRunRecord
                ? (isZh ? '结果会出现在活动记录里，并自动写入工作区里的 “Lynn-自动任务结果” 文件夹。' : 'Results appear in Activity and are also written into the workspace result folder.')
                : (isZh ? '还没有执行记录。到点后结果会出现在活动记录里，并自动写入工作区里的 “Lynn-自动任务结果” 文件夹。' : 'No run yet. When the task fires, the result will appear in Activity and in the workspace result folder.')}
            </div>
          ) : null}
        </div>
      )}
      <div className={fp.automationJobActions}>
        <button type="button" className={fp.automationLinkBtn} onClick={() => onRunNow(job.id)}>
          {isZh ? '立即执行' : 'Run now'}
        </button>
        {job.latestActivity?.outputFile ? (
          <button type="button" className={fp.automationLinkBtn} onClick={openLatestFile}>
            {isZh ? '打开文件' : 'Open file'}
          </button>
        ) : null}
        {job.latestActivity?.id ? (
          <button type="button" className={fp.automationLinkBtn} onClick={openLatestResult}>
            {isZh ? '查看结果' : 'Open result'}
          </button>
        ) : null}
        <button type="button" className={fp.automationLinkBtn} onClick={() => onEdit(job)}>
          {isZh ? '编辑' : 'Edit'}
        </button>
        <button
          type="button"
          className={`${fp.automationLinkBtn} ${fp.automationDangerBtn}`}
          onClick={() => onRemove(job.id)}
        >
          {isZh ? '删除' : 'Delete'}
        </button>
      </div>
    </div>
  );
}
