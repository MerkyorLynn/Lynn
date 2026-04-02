import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../stores';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { cronToHuman } from '../utils/format';
import { yuanFallbackAvatar } from '../utils/agent-helpers';
import fp from './FloatingPanels.module.css';

interface CronJob {
  id: string;
  enabled: boolean;
  label?: string;
  prompt?: string;
  schedule: string | number;
  model?: string;
}

/* ── 预设模板 ── */
interface Template {
  icon: string;
  labelKey: string;
  descKey: string;
  job: { type: string; schedule: string; prompt: string; label: string };
}

const TEMPLATES: Template[] = [
  {
    icon: '📰',
    labelKey: 'automation.tpl.newsLabel',
    descKey: 'automation.tpl.newsDesc',
    job: { type: 'cron', schedule: '0 9 * * *', prompt: '搜索今天的科技新闻，整理成简报发给我', label: '每日科技简报' },
  },
  {
    icon: '📝',
    labelKey: 'automation.tpl.diaryLabel',
    descKey: 'automation.tpl.diaryDesc',
    job: { type: 'cron', schedule: '0 22 * * *', prompt: '帮我写今天的日记', label: '每晚日记' },
  },
  {
    icon: '💻',
    labelKey: 'automation.tpl.repoLabel',
    descKey: 'automation.tpl.repoDesc',
    job: { type: 'cron', schedule: '0 10 * * 1-5', prompt: '检查当前项目的 GitHub Issues 和 PR，整理待办清单', label: '工作日项目巡检' },
  },
  {
    icon: '🧹',
    labelKey: 'automation.tpl.cleanLabel',
    descKey: 'automation.tpl.cleanDesc',
    job: { type: 'cron', schedule: '0 3 * * 0', prompt: '清理书桌上超过 30 天的临时文件和日志', label: '每周清理' },
  },
];

const DAY_KEYS = ['日', '一', '二', '三', '四', '五', '六'];
const DAY_KEYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Parse hour:minute from a cron schedule string */
function parseCronTime(schedule: string | number): { hour: string; minute: string } | null {
  if (typeof schedule === 'number') return null;
  const parts = String(schedule).split(' ');
  if (parts.length !== 5) return null;
  const [min, hour] = parts;
  if (hour === '*' || min === '*') return null;
  return { hour: hour.padStart(2, '0'), minute: min.padStart(2, '0') };
}

/** Build cron from hour, minute, and days array (0=Sun..6=Sat). Empty days = every day */
function buildCron(hour: string, minute: string, days: number[]): string {
  const dowPart = days.length === 0 || days.length === 7 ? '*' : days.sort((a, b) => a - b).join(',');
  return `${parseInt(minute, 10)} ${parseInt(hour, 10)} * * ${dowPart}`;
}

export function AutomationPanel() {
  const activePanel = useStore(s => s.activePanel);
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const agentName = useStore(s => s.agentName);
  const agentYuan = useStore(s => s.agentYuan);
  const currentAgentId = useStore(s => s.currentAgentId);
  const setPendingConfirm = useStore(s => s.setPendingConfirm);
  const addToast = useStore(s => s.addToast);

  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [showCustomForm, setShowCustomForm] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [cronRes, modelsRes] = await Promise.all([
        hanaFetch('/api/desk/cron'),
        hanaFetch('/api/models'),
      ]);
      const cronData = await cronRes.json();
      let modelIds: string[] = [];
      try {
        const modelsData = await modelsRes.json();
        modelIds = (modelsData.models || []).map((m: { id: string }) => m.id);
      } catch {}
      setJobs(cronData.jobs || []);
      setAvailableModels(modelIds);
      updateBadge(cronData.jobs || []);
    } catch (err) {
      console.error('[automation] load failed:', err);
    }
  }, []);

  useEffect(() => {
    if (activePanel === 'automation') loadData();
  }, [activePanel, loadData]);

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
    } catch (err) {
      console.error('[automation] toggle failed:', err);
    }
  }, [loadData]);

  const removeJob = useCallback(async (jobId: string) => {
    const t = window.t ?? ((p: string) => p);
    setPendingConfirm({
      title: t('common.delete') || 'Delete',
      message: t('automation.deleteConfirm') || '确定要删除这个定时任务吗？',
      confirmLabel: t('common.delete') || 'Delete',
      cancelLabel: t('common.cancel') || 'Cancel',
      onConfirm: async () => {
        try {
          const res = await hanaFetch('/api/desk/cron', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'remove', id: jobId }),
          });
          const data = await res.json();
          if (data?.error) throw new Error(data.error);
          await loadData();
          addToast(t('automation.delete') || 'Deleted', 'success');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addToast(`${t('settings.saveFailed') || 'Operation failed'}: ${msg}`, 'error');
          console.error('[automation] remove failed:', err);
          throw err;
        }
      },
    });
  }, [addToast, loadData, setPendingConfirm]);

  const updateJob = useCallback(async (jobId: string, fields: Record<string, unknown>) => {
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id: jobId, ...fields }),
      });
      await loadData();
    } catch (err) {
      console.error('[automation] update failed:', err);
    }
  }, [loadData]);

  const addFromTemplate = useCallback(async (tpl: Template) => {
    setAdding(true);
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', ...tpl.job }),
      });
      await loadData();
    } catch (err) {
      console.error('[automation] add from template failed:', err);
    } finally {
      setAdding(false);
    }
  }, [loadData]);

  const addCustomJob = useCallback(async (job: { label: string; prompt: string; schedule: string; model?: string }) => {
    setAdding(true);
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', type: 'cron', ...job }),
      });
      await loadData();
      setShowCustomForm(false);
    } catch (err) {
      console.error('[automation] add custom failed:', err);
    } finally {
      setAdding(false);
    }
  }, [loadData]);

  if (activePanel !== 'automation') return null;

  const t = window.t ?? ((p: string) => p);

  return (
    <div className={fp.floatingPanel} id="automationPanel" role="dialog" aria-modal="true" aria-label="Automation Panel">
      <div className={fp.floatingPanelInner}>
        <div className={fp.floatingPanelHeader}>
          <h2 className={fp.floatingPanelTitle}>{t('automation.title')}</h2>
          <button className={fp.floatingPanelClose} onClick={close} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className={fp.floatingPanelBody}>
          <div className={fp.automationList} id="automationList">
            {jobs.length === 0 && !showCustomForm ? (
              <AutomationEmptyGuide templates={TEMPLATES} onUseTemplate={addFromTemplate} adding={adding} />
            ) : (
              jobs.map(job => (
                <AutomationItem
                  key={job.id}
                  job={job}
                  availableModels={availableModels}
                  agentAvatarUrl={agentAvatarUrl}
                  agentName={agentName}
                  agentYuan={agentYuan}
                  currentAgentId={currentAgentId}
                  onToggle={toggleJob}
                  onRemove={removeJob}
                  onUpdate={updateJob}
                />
              ))
            )}
          </div>

          {/* Custom task form */}
          {showCustomForm && (
            <CustomTaskForm
              availableModels={availableModels}
              adding={adding}
              onSubmit={addCustomJob}
              onCancel={() => setShowCustomForm(false)}
            />
          )}

          {/* Add custom task button */}
          {!showCustomForm && (
            <button
              className={fp.addCustomBtn}
              onClick={() => setShowCustomForm(true)}
            >
              {t('automation.addCustom')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── 空状态引导 ── */

function AutomationEmptyGuide({
  templates,
  onUseTemplate,
  adding,
}: {
  templates: Template[];
  onUseTemplate: (tpl: Template) => void;
  adding: boolean;
}) {
  const t = window.t ?? ((p: string) => p);

  return (
    <div className={fp.automationGuide}>
      <div className={fp.automationGuideIcon}>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.5">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </div>
      <p className={fp.automationGuideTitle}>{t('automation.guideTitle')}</p>
      <p className={fp.automationGuideDesc}>{t('automation.guideDesc')}</p>

      <div className={fp.automationTemplates}>
        {templates.map((tpl, i) => (
          <button
            key={i}
            className={fp.automationTplCard}
            onClick={() => onUseTemplate(tpl)}
            disabled={adding}
          >
            <span className={fp.automationTplIcon}>{tpl.icon}</span>
            <span className={fp.automationTplText}>
              <span className={fp.automationTplLabel}>{t(tpl.labelKey)}</span>
              <span className={fp.automationTplDesc}>{t(tpl.descKey)}</span>
            </span>
          </button>
        ))}
      </div>

      <p className={fp.automationGuideTip}>{t('automation.guideTip')}</p>
    </div>
  );
}

function updateBadge(jobs: CronJob[]) {
  useStore.setState({ automationCount: jobs.length });
}

/* ── Time Picker inline ── */

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
    <span className={fp.timePicker}>
      <input
        type="number"
        className={fp.timeInput}
        min={0}
        max={23}
        value={hour}
        onChange={e => {
          let v = parseInt(e.target.value, 10);
          if (isNaN(v)) v = 0;
          if (v < 0) v = 0;
          if (v > 23) v = 23;
          onChange(String(v).padStart(2, '0'), minute);
        }}
      />
      <span className={fp.timeColon}>:</span>
      <input
        type="number"
        className={fp.timeInput}
        min={0}
        max={59}
        value={minute}
        onChange={e => {
          let v = parseInt(e.target.value, 10);
          if (isNaN(v)) v = 0;
          if (v < 0) v = 0;
          if (v > 59) v = 59;
          onChange(hour, String(v).padStart(2, '0'));
        }}
      />
    </span>
  );
}

/* ── Day Selector ── */

function DaySelector({
  selected,
  onChange,
}: {
  selected: number[];
  onChange: (days: number[]) => void;
}) {
  const t = window.t ?? ((p: string) => p);
  const dayNames: string[] = (window.t as (...args: unknown[]) => unknown)?.('cron.dayNames') as string[] || DAY_KEYS;
  const labels = Array.isArray(dayNames) ? dayNames : DAY_KEYS;

  return (
    <div className={fp.daySelector}>
      {labels.map((label, i) => (
        <button
          key={i}
          type="button"
          className={`${fp.dayBtn}${selected.includes(i) ? ` ${fp.dayBtnActive}` : ''}`}
          onClick={() => {
            if (selected.includes(i)) {
              onChange(selected.filter(d => d !== i));
            } else {
              onChange([...selected, i]);
            }
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* ── Custom Task Form ── */

function CustomTaskForm({
  availableModels,
  adding,
  onSubmit,
  onCancel,
}: {
  availableModels: string[];
  adding: boolean;
  onSubmit: (job: { label: string; prompt: string; schedule: string; model?: string }) => void;
  onCancel: () => void;
}) {
  const t = window.t ?? ((p: string) => p);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [days, setDays] = useState<number[]>([]);
  const [hour, setHour] = useState('09');
  const [minute, setMinute] = useState('00');

  const handleSubmit = () => {
    if (!name.trim() || !prompt.trim()) return;
    const schedule = buildCron(hour, minute, days);
    onSubmit({
      label: name.trim(),
      prompt: prompt.trim(),
      schedule,
      ...(model ? { model } : {}),
    });
  };

  return (
    <div className={fp.customForm}>
      <div className={fp.customFormField}>
        <label className={fp.customFormLabel}>{t('automation.customName')}</label>
        <input
          type="text"
          className={fp.customFormInput}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('automation.customName')}
        />
      </div>
      <div className={fp.customFormField}>
        <label className={fp.customFormLabel}>{t('automation.customPrompt')}</label>
        <textarea
          className={fp.customFormTextarea}
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          rows={3}
          placeholder={t('automation.customPrompt')}
        />
      </div>
      {availableModels.length > 0 && (
        <div className={fp.customFormField}>
          <label className={fp.customFormLabel}>{t('automation.customModel')}</label>
          <select
            className={fp.customFormSelect}
            value={model}
            onChange={e => setModel(e.target.value)}
          >
            <option value="">{t('automation.defaultModel')}</option>
            {availableModels.map(mid => (
              <option key={mid} value={mid}>{mid}</option>
            ))}
          </select>
        </div>
      )}
      <div className={fp.customFormField}>
        <label className={fp.customFormLabel}>{t('automation.customDays')}</label>
        <DaySelector selected={days} onChange={setDays} />
      </div>
      <div className={fp.customFormField}>
        <label className={fp.customFormLabel}>{t('automation.customTime')}</label>
        <TimePicker hour={hour} minute={minute} onChange={(h, m) => { setHour(h); setMinute(m); }} />
      </div>
      <div className={fp.customFormActions}>
        <button className={fp.customFormCancel} onClick={onCancel} type="button">
          {t('automation.customCancel')}
        </button>
        <button
          className={fp.customFormSubmit}
          onClick={handleSubmit}
          disabled={adding || !name.trim() || !prompt.trim()}
          type="button"
        >
          {t('automation.customSubmit')}
        </button>
      </div>
    </div>
  );
}

/* ── Automation Item ── */

function AutomationItem({
  job,
  availableModels,
  agentAvatarUrl,
  agentName,
  agentYuan,
  currentAgentId,
  onToggle,
  onRemove,
  onUpdate,
}: {
  job: CronJob;
  availableModels: string[];
  agentAvatarUrl: string | null;
  agentName: string;
  agentYuan: string;
  currentAgentId: string | null;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, fields: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [editingTime, setEditingTime] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const labelText = job.label || job.prompt?.slice(0, 40) || job.id;
  const cronTime = parseCronTime(job.schedule);

  const startEdit = useCallback(() => {
    setEditValue(labelText);
    setEditing(true);
  }, [labelText]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commitEdit = useCallback(() => {
    const newText = editValue.trim();
    if (newText && newText !== labelText) {
      onUpdate(job.id, { label: newText });
    }
    setEditing(false);
  }, [editValue, labelText, job.id, onUpdate]);

  const handleTimeChange = useCallback((hour: string, minute: string) => {
    // Rebuild cron preserving existing dow
    const existing = typeof job.schedule === 'string' ? job.schedule : '';
    const parts = existing.split(' ');
    const dow = parts.length === 5 ? parts[4] : '*';
    const newSchedule = `${parseInt(minute, 10)} ${parseInt(hour, 10)} * * ${dow}`;
    onUpdate(job.id, { schedule: newSchedule });
    setEditingTime(false);
  }, [job.id, job.schedule, onUpdate]);

  const avatarSrc = agentAvatarUrl || yuanFallbackAvatar(agentYuan);

  // 构建模型选项
  const jobModelId = typeof job.model === 'object' && job.model !== null
    ? (job.model as unknown as { id: string }).id
    : (job.model || '');
  const modelOptions: string[] = [];
  const modelSet = new Set(availableModels);
  if (jobModelId && !modelSet.has(jobModelId)) modelOptions.push(jobModelId);
  modelOptions.push(...availableModels);

  return (
    <div className={fp.autoItem}>
      <button
        className={'hana-toggle' + (job.enabled ? ' on' : '')}
        title={job.enabled ? 'Disable' : 'Enable'}
        aria-label={job.enabled ? 'Disable automation' : 'Enable automation'}
        onClick={() => onToggle(job.id)}
      />
      <div className={fp.autoItemInfo}>
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            className={fp.autoItemLabelInput}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); inputRef.current?.blur(); }
              if (e.key === 'Escape') { setEditValue(labelText); inputRef.current?.blur(); }
            }}
          />
        ) : (
          <span className={fp.autoItemLabel} onDoubleClick={startEdit}>{labelText}</span>
        )}
        <div className={fp.autoItemMeta}>
          <div className={fp.autoItemExecutor}>
            <img
              className={fp.autoItemExecutorAvatar}
              src={avatarSrc}
              onError={e => { (e.target as HTMLImageElement).onerror = null; (e.target as HTMLImageElement).src = yuanFallbackAvatar(agentYuan); }}
            />
            <span className={fp.autoItemExecutorName}>{agentName}</span>
          </div>
          {editingTime && cronTime ? (
            <TimePicker
              hour={cronTime.hour}
              minute={cronTime.minute}
              onChange={handleTimeChange}
            />
          ) : (
            <span
              className={`${fp.autoItemSchedule}${cronTime ? ` ${fp.autoItemScheduleEditable}` : ''}`}
              onClick={() => { if (cronTime) setEditingTime(true); }}
              title={cronTime ? ((window.t ?? ((p: string) => p))('automation.changeTime')) : undefined}
            >
              {cronToHuman(job.schedule)}
            </span>
          )}
          {availableModels.length > 0 && (
            <span className={fp.autoItemModelWrap}>
              <select
                className={fp.autoItemModelSelect}
                title="Model"
                value={jobModelId}
                onChange={e => onUpdate(job.id, { model: e.target.value })}
              >
                <option value="">{(window.t ?? ((p: string) => p))('automation.defaultModel')}</option>
                {modelOptions.map(mid => (
                  <option key={mid} value={mid}>{mid}</option>
                ))}
              </select>
            </span>
          )}
        </div>
      </div>
      <div className={fp.autoItemActions}>
        <button className={fp.autoItemBtn} title={(window.t ?? ((p: string) => p))('automation.edit')} onClick={startEdit}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
        <button className={`${fp.autoItemBtn} ${fp.autoItemBtnDanger}`} title={(window.t ?? ((p: string) => p))('automation.delete')} onClick={() => onRemove(job.id)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
