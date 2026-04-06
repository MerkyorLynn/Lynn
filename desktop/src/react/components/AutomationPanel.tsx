import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { cronToHuman } from '../utils/format';
import {
  collapseBrainModelChoices,
  normalizeDisplayModelName,
  normalizeDisplayProviderLabel,
} from '../utils/brain-models';
import fp from './FloatingPanels.module.css';

interface CronJob {
  id: string;
  enabled: boolean;
  label?: string;
  prompt?: string;
  schedule: string | number;
  model?: string;
  workspace?: string;
}

interface ModelOption {
  value: string;
  label: string;
  rawId: string;
  rawProvider: string;
}

type AutomationCategory = 'reports' | 'organize' | 'followup';
type SchedulePreset = 'daily' | 'weekdays' | 'weekly' | 'custom';

interface TemplateDefinition {
  id: string;
  category: AutomationCategory;
  icon: string;
  zhTitle: string;
  enTitle: string;
  zhDesc: string;
  enDesc: string;
  promptZh: string;
  promptEn: string;
  defaultLabelZh: string;
  defaultLabelEn: string;
  defaultPreset: SchedulePreset;
  defaultHour: string;
  defaultMinute: string;
  defaultWeeklyDay?: number;
  defaultDays?: number[];
}

const DAY_KEYS = ['日', '一', '二', '三', '四', '五', '六'];
const DAY_KEYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_SET = '1,2,3,4,5';

const TEMPLATES: TemplateDefinition[] = [
  {
    id: 'daily-standup',
    category: 'reports',
    icon: '📰',
    zhTitle: '昨日工作简报',
    enTitle: "Yesterday's work update",
    zhDesc: '总结昨天推进了什么、卡在哪里、今天最该继续跟进什么。',
    enDesc: "Summarize what moved yesterday, what is blocked, and what deserves attention today.",
    promptZh: '根据当前工作区、笺和最近活动，整理一段昨日工作简报：昨天做了什么、卡在哪里、今天最该继续推进什么。',
    promptEn: 'Use the current workspace, note, and recent activity to summarize what moved yesterday, what is blocked, and what deserves attention today.',
    defaultLabelZh: '昨日工作简报',
    defaultLabelEn: "Yesterday's work update",
    defaultPreset: 'daily',
    defaultHour: '09',
    defaultMinute: '00',
  },
  {
    id: 'weekly-highlights',
    category: 'reports',
    icon: '🧾',
    zhTitle: '每周工作周报',
    enTitle: 'Weekly work summary',
    zhDesc: '汇总这周完成了什么、遗留了什么，以及下周最值得推进的重点。',
    enDesc: 'Summarize what got done this week, what remains open, and what to focus on next week.',
    promptZh: '结合当前工作区、笺和最近活动，整理一份每周工作周报：这周完成了什么、遗留了什么、下周重点是什么。',
    promptEn: 'Use the workspace, note, and recent activity to prepare a weekly work summary with completed work, open items, and next-week priorities.',
    defaultLabelZh: '每周工作周报',
    defaultLabelEn: 'Weekly work summary',
    defaultPreset: 'weekly',
    defaultHour: '18',
    defaultMinute: '00',
    defaultWeeklyDay: 5,
  },
  {
    id: 'daily-hourly-summary',
    category: 'reports',
    icon: '⏱️',
    zhTitle: '定时工作小结',
    enTitle: 'Timed work summary',
    zhDesc: '按固定时间整理当前项目、笺和活动流，生成一段简短进展小结。',
    enDesc: 'Generate a short status update from the project, note, and activity feed on a fixed cadence.',
    promptZh: '按当前工作区、笺和最近活动，生成一段简洁的工作进展小结，方便我快速回看。',
    promptEn: 'Use the current workspace, note, and recent activity to create a short work summary I can quickly review.',
    defaultLabelZh: '定时工作小结',
    defaultLabelEn: 'Timed work summary',
    defaultPreset: 'daily',
    defaultHour: '10',
    defaultMinute: '00',
  },
  {
    id: 'file-summary-digest',
    category: 'organize',
    icon: '🗂️',
    zhTitle: '文件自动归纳',
    enTitle: 'File digest',
    zhDesc: '整理工作区里新增或变化的文件，提炼重点并给出归档建议。',
    enDesc: 'Summarize new or changed files and suggest how to organize them.',
    promptZh: '查看当前工作区里最近新增或变化的文件，整理出重点、归类建议和需要我确认的事项。',
    promptEn: 'Review recent new or changed files in the workspace and summarize key points, organization suggestions, and anything needing confirmation.',
    defaultLabelZh: '文件自动归纳',
    defaultLabelEn: 'File digest',
    defaultPreset: 'weekdays',
    defaultHour: '17',
    defaultMinute: '00',
  },
  {
    id: 'document-summary',
    category: 'organize',
    icon: '📝',
    zhTitle: '文档摘要整理',
    enTitle: 'Document digest',
    zhDesc: '定期把文档、笔记和产出整理成可复用的摘要与下一步建议。',
    enDesc: 'Turn notes and documents into reusable summaries and next steps.',
    promptZh: '整理当前工作区中的文档、笔记和产出，生成一份简洁摘要，并给出下一步建议。',
    promptEn: 'Summarize the current workspace documents and notes into a concise digest with recommended next steps.',
    defaultLabelZh: '文档摘要整理',
    defaultLabelEn: 'Document digest',
    defaultPreset: 'weekly',
    defaultHour: '11',
    defaultMinute: '00',
    defaultWeeklyDay: 1,
  },
  {
    id: 'workday-reminder',
    category: 'followup',
    icon: '🔔',
    zhTitle: '工作日巡检提醒',
    enTitle: 'Workday check-in',
    zhDesc: '在工作日固定时间查看笺、活动和文件变化，提醒我今天最该跟进什么。',
    enDesc: 'Check the note, recent activity, and file changes on workdays and remind me what to follow up on.',
    promptZh: '在工作日固定时间查看笺、最近活动和文件变化，提醒我今天最应该先跟进的事项。',
    promptEn: 'On workdays, check the note, recent activity, and file changes, then remind me what deserves attention first.',
    defaultLabelZh: '工作日巡检提醒',
    defaultLabelEn: 'Workday check-in',
    defaultPreset: 'weekdays',
    defaultHour: '09',
    defaultMinute: '30',
  },
  {
    id: 'weekly-next-steps',
    category: 'followup',
    icon: '📌',
    zhTitle: '下周重点提醒',
    enTitle: 'Next-step roundup',
    zhDesc: '汇总这周未完成事项、风险和下周最值得推进的重点。',
    enDesc: 'Summarize unfinished work, risks, and priorities for the coming week.',
    promptZh: '结合笺、活动和最近产出，整理本周未完成事项、风险和下周最值得推进的重点。',
    promptEn: 'Use the note, activity, and recent outputs to summarize unfinished work, risks, and next-week priorities.',
    defaultLabelZh: '下周重点提醒',
    defaultLabelEn: 'Next-step roundup',
    defaultPreset: 'weekly',
    defaultHour: '19',
    defaultMinute: '00',
    defaultWeeklyDay: 5,
  },
];

const CATEGORY_DEFS: Array<{ key: AutomationCategory; zhLabel: string; enLabel: string }> = [
  { key: 'reports', zhLabel: '日报 / 周报', enLabel: 'Reports' },
  { key: 'organize', zhLabel: '文件整理', enLabel: 'Files' },
  { key: 'followup', zhLabel: '提醒跟进', enLabel: 'Reminders' },
];

function toModelOptionValue(model: { id: string; provider?: string }): string {
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function buildAutomationModelOptions(models: Array<{ id: string; name?: string; provider?: string }>): ModelOption[] {
  const visibleModels = collapseBrainModelChoices(models);
  const labelCounts = new Map<string, number>();
  for (const model of visibleModels) {
    const label = normalizeDisplayModelName(model) || model.name || model.id;
    labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
  }

  return visibleModels.map((model) => {
    const baseLabel = normalizeDisplayModelName(model) || model.name || model.id;
    const needsProvider = (labelCounts.get(baseLabel) || 0) > 1;
    const providerLabel = normalizeDisplayProviderLabel(model.provider) || model.provider || '';
    return {
      value: toModelOptionValue(model),
      label: needsProvider && providerLabel ? `${baseLabel} · ${providerLabel}` : baseLabel,
      rawId: model.id,
      rawProvider: model.provider || '',
    };
  });
}

function resolveJobModelValue(modelRef: string | undefined, options: ModelOption[]): string {
  const raw = String(modelRef || '').trim();
  if (!raw) return '';
  const exact = options.find((option) => option.value === raw);
  if (exact) return exact.value;
  const byRawId = options.find((option) => option.rawId === raw);
  return byRawId?.value || raw;
}

function folderLabel(folderPath: string | null): string {
  if (!folderPath) return '';
  const parts = folderPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || folderPath;
}

function parseCronTime(schedule: string | number): { hour: string; minute: string } | null {
  if (typeof schedule !== 'string') return null;
  const parts = String(schedule).split(' ');
  if (parts.length !== 5) return null;
  const [min, hour] = parts;
  if (hour === '*' || min === '*') return null;
  return {
    hour: String(parseInt(hour, 10)).padStart(2, '0'),
    minute: String(parseInt(min, 10)).padStart(2, '0'),
  };
}

function parseCronDays(schedule: string | number): number[] {
  if (typeof schedule !== 'string') return [];
  const parts = String(schedule).split(' ');
  if (parts.length !== 5) return [];
  const dow = String(parts[4] || '').trim();
  if (!dow || dow === '*') return [0, 1, 2, 3, 4, 5, 6];
  if (dow === '1-5') return [1, 2, 3, 4, 5];
  return dow
    .split(',')
    .map((value) => parseInt(value, 10))
    .filter((value) => !Number.isNaN(value) && value >= 0 && value <= 6);
}

function inferSchedulePreset(schedule: string | number): SchedulePreset {
  if (typeof schedule !== 'string') return 'custom';
  const parts = String(schedule).split(' ');
  if (parts.length !== 5) return 'custom';
  const dow = String(parts[4] || '').trim();
  if (!dow || dow === '*') return 'daily';
  if (dow === '1-5' || dow === WEEKDAY_SET) return 'weekdays';
  if (/^\d$/.test(dow)) return 'weekly';
  return 'custom';
}

function buildCron(hour: string, minute: string, days: number[]): string {
  const normalizedHour = String(parseInt(hour || '9', 10)).padStart(2, '0');
  const normalizedMinute = String(parseInt(minute || '0', 10)).padStart(2, '0');
  const uniqueDays = Array.from(new Set(days)).sort((left, right) => left - right);
  const dowPart = uniqueDays.length === 0 || uniqueDays.length === 7 ? '*' : uniqueDays.join(',');
  return `${parseInt(normalizedMinute, 10)} ${parseInt(normalizedHour, 10)} * * ${dowPart}`;
}

function buildScheduleFromPreset(
  preset: SchedulePreset,
  hour: string,
  minute: string,
  weeklyDay: number,
  customDays: number[],
): string {
  if (preset === 'daily') return buildCron(hour, minute, []);
  if (preset === 'weekdays') return buildCron(hour, minute, [1, 2, 3, 4, 5]);
  if (preset === 'weekly') return buildCron(hour, minute, [weeklyDay]);
  return buildCron(hour, minute, customDays.length > 0 ? customDays : [1]);
}

function DaySelector({
  selected,
  single = false,
  onChange,
  isZh,
}: {
  selected: number[];
  single?: boolean;
  onChange: (days: number[]) => void;
  isZh: boolean;
}) {
  const labels = isZh ? DAY_KEYS : DAY_KEYS_EN;
  return (
    <div className={fp.automationDaySelector}>
      {labels.map((label, index) => {
        const active = selected.includes(index);
        return (
          <button
            key={`${label}-${index}`}
            type="button"
            className={`${fp.automationDayBtn}${active ? ` ${fp.automationDayBtnActive}` : ''}`}
            onClick={() => {
              if (single) {
                onChange([index]);
                return;
              }
              if (active) {
                onChange(selected.filter((day) => day !== index));
              } else {
                onChange([...selected, index]);
              }
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function TimePicker({
  hour,
  minute,
  onChange,
}: {
  hour: string;
  minute: string;
  onChange: (hour: string, minute: string) => void;
}) {
  return (
    <span className={fp.automationTimePicker}>
      <input
        type="number"
        className={fp.automationTimeInput}
        min={0}
        max={23}
        value={hour}
        onChange={(event) => {
          let next = parseInt(event.target.value, 10);
          if (Number.isNaN(next)) next = 0;
          next = Math.max(0, Math.min(23, next));
          onChange(String(next).padStart(2, '0'), minute);
        }}
      />
      <span className={fp.automationTimeColon}>:</span>
      <input
        type="number"
        className={fp.automationTimeInput}
        min={0}
        max={59}
        value={minute}
        onChange={(event) => {
          let next = parseInt(event.target.value, 10);
          if (Number.isNaN(next)) next = 0;
          next = Math.max(0, Math.min(59, next));
          onChange(hour, String(next).padStart(2, '0'));
        }}
      />
    </span>
  );
}

function updateBadge(jobs: CronJob[]) {
  useStore.setState({ automationCount: jobs.length });
}

function AutomationJobCard({
  job,
  modelOptions,
  isZh,
  onToggle,
  onEdit,
  onRemove,
}: {
  job: CronJob;
  modelOptions: ModelOption[];
  isZh: boolean;
  onToggle: (id: string) => void;
  onEdit: (job: CronJob) => void;
  onRemove: (id: string) => void;
}) {
  const selectedValue = resolveJobModelValue(job.model, modelOptions);
  const modelLabel = selectedValue
    ? modelOptions.find((option) => option.value === selectedValue)?.label || job.model || ''
    : (isZh ? '默认模型' : 'Default model');
  const workspaceLabel = folderLabel(job.workspace || null);

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
      </div>
      <div className={fp.automationJobActions}>
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

export function AutomationPanel() {
  const activePanel = useStore((s) => s.activePanel);
  const locale = useStore((s) => s.locale || 'zh');
  const selectedFolder = useStore((s) => s.selectedFolder || '');
  const homeFolder = useStore((s) => s.homeFolder || '');
  const currentSessionPath = useStore((s) => s.currentSessionPath);
  const sessions = useStore((s) => s.sessions);
  const setPendingConfirm = useStore((s) => s.setPendingConfirm);
  const addToast = useStore((s) => s.addToast);
  const isZh = locale.startsWith('zh');
  const t = window.t ?? ((key: string) => key);
  const tt = useCallback((key: string, zhText: string, enText: string) => {
    const value = t(key);
    return !value || value === key ? (isZh ? zhText : enText) : value;
  }, [isZh, t]);

  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeCategory, setActiveCategory] = useState<AutomationCategory>('reports');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftPrompt, setDraftPrompt] = useState('');
  const [draftProject, setDraftProject] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [draftSchedulePreset, setDraftSchedulePreset] = useState<SchedulePreset>('daily');
  const [draftHour, setDraftHour] = useState('09');
  const [draftMinute, setDraftMinute] = useState('00');
  const [draftWeeklyDay, setDraftWeeklyDay] = useState(1);
  const [draftCustomDays, setDraftCustomDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<AutomationCategory, HTMLDivElement | null>>({
    reports: null,
    organize: null,
    followup: null,
  });

  const currentSession = useMemo(
    () => sessions.find((session) => session.path === currentSessionPath) || null,
    [sessions, currentSessionPath],
  );

  const projectOptions = useMemo(() => {
    const seen = new Set<string>();
    const rawPaths = [selectedFolder, homeFolder, currentSession?.cwd || ''].filter(Boolean);
    return rawPaths
      .map((value) => String(value).trim())
      .filter((value) => value && !seen.has(value) && (seen.add(value), true))
      .map((value) => ({
        value,
        label: folderLabel(value),
        meta: value,
      }));
  }, [currentSession?.cwd, homeFolder, selectedFolder]);

  const resetComposer = useCallback(() => {
    setSelectedTemplateId(null);
    setEditingJobId(null);
    setDraftName('');
    setDraftPrompt('');
    setDraftModel('');
    setDraftProject(projectOptions[0]?.value || '');
    setDraftSchedulePreset('daily');
    setDraftHour('09');
    setDraftMinute('00');
    setDraftWeeklyDay(1);
    setDraftCustomDays([1, 2, 3, 4, 5]);
  }, [projectOptions]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [cronRes, modelsRes] = await Promise.all([
        hanaFetch('/api/desk/cron'),
        hanaFetch('/api/models'),
      ]);
      const cronData = await cronRes.json();
      const modelsData = await modelsRes.json();
      const nextJobs = (cronData.jobs || []) as CronJob[];
      const nextModels = buildAutomationModelOptions(modelsData.models || []);
      setJobs(nextJobs);
      setAvailableModels(nextModels);
      updateBadge(nextJobs);
    } catch (error) {
      console.error('[automation] load failed:', error);
      setLoadError(
        isZh
          ? '自动任务面板刚才没完全加载好。点一次重试，我会重新读取任务、模板和模型。'
          : 'The automation panel did not load correctly. Retry to reload tasks, templates, and models.',
      );
    } finally {
      setLoading(false);
    }
  }, [isZh]);

  useEffect(() => {
    if (activePanel === 'automation') {
      void loadData();
    }
  }, [activePanel, loadData]);

  useEffect(() => {
    if (activePanel !== 'automation') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        useStore.getState().setActivePanel(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activePanel]);

  useEffect(() => {
    if (!draftProject) {
      setDraftProject(projectOptions[0]?.value || '');
    }
  }, [draftProject, projectOptions]);

  const startFromTemplate = useCallback((template: TemplateDefinition) => {
    setSelectedTemplateId(template.id);
    setEditingJobId(null);
    setDraftName(isZh ? template.defaultLabelZh : template.defaultLabelEn);
    setDraftPrompt(isZh ? template.promptZh : template.promptEn);
    setDraftProject(projectOptions[0]?.value || '');
    setDraftModel('');
    setDraftSchedulePreset(template.defaultPreset);
    setDraftHour(template.defaultHour);
    setDraftMinute(template.defaultMinute);
    setDraftWeeklyDay(template.defaultWeeklyDay ?? 1);
    setDraftCustomDays(template.defaultDays || [1, 2, 3, 4, 5]);
  }, [isZh, projectOptions]);

  const startCustom = useCallback(() => {
    setSelectedTemplateId('custom');
    setEditingJobId(null);
    setDraftName(isZh ? '自定义自动任务' : 'Custom task');
    setDraftPrompt('');
    setDraftProject(projectOptions[0]?.value || '');
    setDraftModel('');
    setDraftSchedulePreset('daily');
    setDraftHour('09');
    setDraftMinute('00');
    setDraftWeeklyDay(1);
    setDraftCustomDays([1, 2, 3, 4, 5]);
  }, [isZh, projectOptions]);

  const editJob = useCallback((job: CronJob) => {
    const preset = inferSchedulePreset(job.schedule);
    const cronTime = parseCronTime(job.schedule) || { hour: '09', minute: '00' };
    const cronDays = parseCronDays(job.schedule);
    setSelectedTemplateId(null);
    setEditingJobId(job.id);
    setDraftName(job.label || '');
    setDraftPrompt(job.prompt || '');
    setDraftProject(job.workspace || projectOptions[0]?.value || '');
    setDraftModel(resolveJobModelValue(job.model, availableModels));
    setDraftSchedulePreset(preset);
    setDraftHour(cronTime.hour);
    setDraftMinute(cronTime.minute);
    setDraftWeeklyDay(cronDays.find((day) => day >= 0 && day <= 6) ?? 1);
    setDraftCustomDays(cronDays.length > 0 ? cronDays : [1, 2, 3, 4, 5]);
  }, [availableModels, projectOptions]);

  const close = useCallback(() => {
    useStore.getState().setActivePanel(null);
  }, []);

  const toggleJob = useCallback(async (jobId: string) => {
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', id: jobId }),
      });
      await loadData();
    } catch (error) {
      console.error('[automation] toggle failed:', error);
    }
  }, [loadData]);

  const removeJob = useCallback(async (jobId: string) => {
    setPendingConfirm({
      title: tt('common.delete', '删除任务', 'Delete task'),
      message: tt('automation.deleteConfirm', '确定要删除这个定时任务吗？', 'Delete this scheduled task?'),
      confirmLabel: tt('common.delete', '删除', 'Delete'),
      cancelLabel: tt('common.cancel', '取消', 'Cancel'),
      onConfirm: async () => {
        await hanaFetch('/api/desk/cron', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove', id: jobId }),
        });
        await loadData();
      },
    });
  }, [loadData, setPendingConfirm, tt]);

  const saveDraft = useCallback(async () => {
    if (!draftName.trim() || !draftPrompt.trim()) return;
    setSaving(true);
    try {
      const schedule = buildScheduleFromPreset(
        draftSchedulePreset,
        draftHour,
        draftMinute,
        draftWeeklyDay,
        draftCustomDays,
      );
      const payload: Record<string, unknown> = editingJobId
        ? {
            action: 'update',
            id: editingJobId,
            label: draftName.trim(),
            prompt: draftPrompt.trim(),
            schedule,
            workspace: draftProject,
          }
        : {
            action: 'add',
            type: 'cron',
            label: draftName.trim(),
            prompt: draftPrompt.trim(),
            schedule,
            workspace: draftProject,
          };
      if (draftModel) payload.model = draftModel;
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await loadData();
      addToast(
        editingJobId
          ? tt('settings.saved', '自动任务已更新', 'Task updated')
          : tt('settings.saved', '自动任务已创建', 'Task created'),
        'success',
      );
      resetComposer();
    } catch (error) {
      console.error('[automation] save failed:', error);
      addToast(tt('settings.saveFailed', '自动任务保存失败', 'Failed to save task'), 'error');
    } finally {
      setSaving(false);
    }
  }, [
    addToast,
    draftCustomDays,
    draftHour,
    draftMinute,
    draftModel,
    draftName,
    draftProject,
    draftPrompt,
    draftSchedulePreset,
    draftWeeklyDay,
    editingJobId,
    loadData,
    resetComposer,
    tt,
  ]);

  const currentTemplate = selectedTemplateId
    ? TEMPLATES.find((template) => template.id === selectedTemplateId) || null
    : null;
  const templateSections = useMemo(() => {
    return CATEGORY_DEFS.map((category) => ({
      ...category,
      templates: TEMPLATES.filter((template) => template.category === category.key),
    }));
  }, []);

  const scrollToCategory = useCallback((category: AutomationCategory) => {
    setActiveCategory(category);
    const container = scrollContainerRef.current;
    const section = sectionRefs.current[category];
    if (!container || !section) return;
    const top = section.offsetTop - 8;
    container.scrollTo({ top, behavior: 'smooth' });
  }, []);

  if (activePanel !== 'automation') return null;

  return (
    <div className={fp.automationOverlay} onClick={close}>
      <div
        className={fp.automationDialog}
        role="dialog"
        aria-modal="true"
        aria-label={tt('automation.title', '自动任务', 'Scheduled tasks')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={fp.automationDialogHeader}>
          <div className={fp.automationDialogTitleBlock}>
            <div className={fp.automationDialogTitle}>{tt('automation.title', '自动任务', 'Scheduled tasks')}</div>
              <div className={fp.automationDialogSubtitle}>
                {tt(
                  'automation.guideDesc',
                  '先选一个日常工作模板，再在底部设置项目、时间和模型。创建后，Lynn 会按计划自动执行并回写结果。',
                  'Pick a daily-work template, then set the project, schedule, and model at the bottom.',
                )}
              </div>
          </div>
          <div className={fp.automationDialogActions}>
            <button type="button" className={fp.automationGhostBtn} onClick={startCustom}>
              {isZh ? '新建自定义任务' : 'New custom task'}
            </button>
            <button type="button" className={fp.automationCloseBtn} onClick={close} aria-label={isZh ? '关闭' : 'Close'}>
              ×
            </button>
          </div>
        </div>

        <div className={fp.automationDialogBody}>
          <aside className={fp.automationSidebar}>
            {CATEGORY_DEFS.map((category) => (
              <button
                key={category.key}
                type="button"
                className={`${fp.automationCategoryBtn}${activeCategory === category.key ? ` ${fp.automationCategoryBtnActive}` : ''}`}
                onClick={() => scrollToCategory(category.key)}
              >
                {isZh ? category.zhLabel : category.enLabel}
              </button>
            ))}
          </aside>

          <section className={fp.automationMain}>
            <div
              ref={scrollContainerRef}
              className={fp.automationScroll}
            >
              {loadError && (
                <div className={fp.automationPanelNotice}>
                  <div>{loadError}</div>
                  <button
                    type="button"
                    className={fp.automationLinkBtn}
                    onClick={() => void loadData()}
                    style={{ marginTop: 10 }}
                  >
                    {isZh ? '重试' : 'Retry'}
                  </button>
                </div>
              )}

              {jobs.length > 0 && (
                <div className={fp.automationSection}>
                  <div className={fp.automationSectionHeader}>
                    <div className={fp.automationSectionTitle}>{isZh ? '已创建任务' : 'Created tasks'}</div>
                    <div className={fp.automationSectionMeta}>{jobs.length}</div>
                  </div>
                  <div className={fp.automationJobGrid}>
                    {jobs.map((job) => (
                      <AutomationJobCard
                        key={job.id}
                        job={job}
                        modelOptions={availableModels}
                        isZh={isZh}
                        onToggle={toggleJob}
                        onEdit={editJob}
                        onRemove={removeJob}
                      />
                    ))}
                  </div>
                </div>
              )}

              {templateSections.map((category) => (
                <div
                  key={category.key}
                  id={`automation-section-${category.key}`}
                  ref={(node) => {
                    sectionRefs.current[category.key] = node;
                  }}
                  className={fp.automationSection}
                >
                  <div className={fp.automationSectionHeader}>
                    <div className={fp.automationSectionTitle}>
                      {isZh ? category.zhLabel : category.enLabel}
                    </div>
                    <div className={fp.automationSectionMeta}>{category.templates.length}</div>
                  </div>
                  <div className={fp.automationTemplateGrid}>
                    {category.templates.map((template) => {
                      const selected = selectedTemplateId === template.id;
                      return (
                        <button
                          key={template.id}
                          type="button"
                          className={`${fp.automationTemplateCard}${selected ? ` ${fp.automationTemplateCardActive}` : ''}`}
                          onClick={() => startFromTemplate(template)}
                        >
                          <div className={fp.automationTemplateIcon}>{template.icon}</div>
                          <div className={fp.automationTemplateBody}>
                            <div className={fp.automationTemplateTitle}>
                              {isZh ? template.zhTitle : template.enTitle}
                            </div>
                            <div className={fp.automationTemplateDesc}>
                              {isZh ? template.zhDesc : template.enDesc}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {loading && (
                <div className={fp.automationPanelNotice}>
                  {isZh ? '正在读取自动任务…' : 'Loading scheduled tasks...'}
                </div>
              )}
            </div>

            <div className={fp.automationComposer}>
              <div className={fp.automationComposerTop}>
                <div className={fp.automationComposerTitle}>
                  {editingJobId
                    ? (isZh ? '编辑自动任务' : 'Edit task')
                    : currentTemplate
                      ? (isZh ? `使用模板：${currentTemplate.zhTitle}` : `Use template: ${currentTemplate.enTitle}`)
                      : (isZh ? '先选一个模板，或新建自定义任务' : 'Pick a template or create a custom task')}
                </div>
                <div className={fp.automationComposerHint}>
                  {isZh
                    ? '不选模型时会走默认模型。项目会作为这条自动任务的执行工作区保存。'
                    : 'Leave model empty to use the default model. The selected project becomes the task workspace.'}
                </div>
              </div>

              <div className={fp.automationComposerFields}>
                <label className={fp.automationField}>
                  <span className={fp.automationFieldLabel}>{isZh ? '任务名称' : 'Task name'}</span>
                  <input
                    className={fp.automationFieldInput}
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    placeholder={isZh ? '例如：工作日项目巡检' : 'e.g. Weekday project review'}
                  />
                </label>
                <label className={fp.automationField}>
                  <span className={fp.automationFieldLabel}>{isZh ? '项目' : 'Project'}</span>
                  <select
                    className={fp.automationFieldSelect}
                    value={draftProject}
                    onChange={(event) => setDraftProject(event.target.value)}
                  >
                    {projectOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label} · {option.meta}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={fp.automationField}>
                  <span className={fp.automationFieldLabel}>{isZh ? '频率' : 'Schedule'}</span>
                  <select
                    className={fp.automationFieldSelect}
                    value={draftSchedulePreset}
                    onChange={(event) => setDraftSchedulePreset(event.target.value as SchedulePreset)}
                  >
                    <option value="daily">{isZh ? '每天' : 'Daily'}</option>
                    <option value="weekdays">{isZh ? '工作日' : 'Weekdays'}</option>
                    <option value="weekly">{isZh ? '每周' : 'Weekly'}</option>
                    <option value="custom">{isZh ? '定制' : 'Custom'}</option>
                  </select>
                </label>
                <label className={fp.automationField}>
                  <span className={fp.automationFieldLabel}>{isZh ? '模型' : 'Model'}</span>
                  <select
                    className={fp.automationFieldSelect}
                    value={draftModel}
                    onChange={(event) => setDraftModel(event.target.value)}
                  >
                    <option value="">{tt('automation.defaultModel', '默认模型', 'Default model')}</option>
                    {availableModels.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className={fp.automationField}>
                  <span className={fp.automationFieldLabel}>{isZh ? '时间' : 'Time'}</span>
                  <TimePicker hour={draftHour} minute={draftMinute} onChange={(hour, minute) => {
                    setDraftHour(hour);
                    setDraftMinute(minute);
                  }} />
                </div>
              </div>

              {(draftSchedulePreset === 'weekly' || draftSchedulePreset === 'custom') && (
                <div className={fp.automationComposerDays}>
                  <div className={fp.automationFieldLabel}>
                    {draftSchedulePreset === 'weekly'
                      ? (isZh ? '每周哪天' : 'Day of week')
                      : (isZh ? '定制日期' : 'Custom days')}
                  </div>
                  <DaySelector
                    isZh={isZh}
                    selected={draftSchedulePreset === 'weekly' ? [draftWeeklyDay] : draftCustomDays}
                    single={draftSchedulePreset === 'weekly'}
                    onChange={(days) => {
                      if (draftSchedulePreset === 'weekly') {
                        setDraftWeeklyDay(days[0] ?? 1);
                      } else {
                        setDraftCustomDays(days);
                      }
                    }}
                  />
                </div>
              )}

              <label className={`${fp.automationField} ${fp.automationFieldGrow}`}>
                <span className={fp.automationFieldLabel}>{isZh ? '任务内容' : 'Prompt'}</span>
                <textarea
                  className={fp.automationFieldTextarea}
                  rows={4}
                  value={draftPrompt}
                  onChange={(event) => setDraftPrompt(event.target.value)}
                  placeholder={isZh ? '写下这条自动任务要替你做什么' : 'Describe what this scheduled task should do'}
                />
              </label>

              <div className={fp.automationComposerActions}>
                <button type="button" className={fp.automationGhostBtn} onClick={resetComposer}>
                  {isZh ? '清空' : 'Clear'}
                </button>
                <button
                  type="button"
                  className={fp.automationPrimaryBtn}
                  disabled={saving || !draftName.trim() || !draftPrompt.trim()}
                  onClick={() => void saveDraft()}
                >
                  {saving
                    ? (isZh ? '处理中…' : 'Saving...')
                    : editingJobId
                      ? (isZh ? '保存修改' : 'Save changes')
                      : (isZh ? '创建自动任务' : 'Create task')}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
