/**
 * CompatSkillsStep.tsx — 检测外部 AI 工具的 skills,主动提示启用
 *
 * 自动扫 ~/.claude/skills 等 10 个目录(core/engine.js WELL_KNOWN_SKILL_PATHS)。
 * 若未发现任何 external skill,自动 skip 到 Tutorial,用户无感知。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OnboardingFetch } from '../onboarding-actions';
import { StepContainer } from '../onboarding-ui';

type OnboardingTrack = 'quick' | 'advanced';

interface CompatSkillsStepProps {
  preview: boolean;
  onboardingFetch: OnboardingFetch;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
  track: OnboardingTrack;
}

interface ExternalSkill {
  name: string;
  description: string;
  externalLabel: string | null;
  externalPath: string | null;
  source: string;
  enabled: boolean;
}

const NEXT_STEP = 7;

async function resolveAgentId(onboardingFetch: OnboardingFetch): Promise<string> {
  try {
    const res = await onboardingFetch('/api/agents');
    const data = await res.json();
    const agents = Array.isArray(data?.agents) ? data.agents : [];
    const current = agents.find((a: { isCurrent?: boolean }) => a?.isCurrent);
    const primary = agents.find((a: { isPrimary?: boolean }) => a?.isPrimary);
    const resolved = current?.id || primary?.id || agents[0]?.id;
    if (typeof resolved === 'string' && resolved.trim()) return resolved.trim();
  } catch {
    // fall through
  }
  return 'lynn';
}

export function CompatSkillsStep({
  preview,
  onboardingFetch,
  goToStep,
  showError,
}: CompatSkillsStepProps) {
  const [loading, setLoading] = useState(true);
  const [agentId, setAgentId] = useState<string>('lynn');
  const [externalSkills, setExternalSkills] = useState<ExternalSkill[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const id = await resolveAgentId(onboardingFetch);
        if (cancelled) return;
        setAgentId(id);

        const res = await onboardingFetch(`/api/skills?agentId=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (cancelled) return;
        const all = Array.isArray(data?.skills) ? data.skills : [];
        const external = all.filter((s: ExternalSkill) => s.source === 'external');

        if (external.length === 0) {
          goToStep(NEXT_STEP);
          return;
        }

        setExternalSkills(external);
        setSelected(new Set(external.filter((s: ExternalSkill) => !s.enabled).map((s: ExternalSkill) => s.name)));
      } catch (err) {
        console.error('[compat-skills] load failed:', err);
        goToStep(NEXT_STEP);
        return;
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [onboardingFetch, goToStep]);

  const grouped = useMemo(() => {
    const map = new Map<string, ExternalSkill[]>();
    for (const skill of externalSkills) {
      const label = skill.externalLabel || '外部 skill';
      const list = map.get(label) || [];
      list.push(skill);
      map.set(label, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b, 'zh-Hans-CN'));
  }, [externalSkills]);

  const toggleSkill = useCallback((name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((groupLabel: string, enable: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      const groupSkills = externalSkills.filter(s => (s.externalLabel || '外部 skill') === groupLabel);
      for (const s of groupSkills) {
        if (enable) next.add(s.name);
        else next.delete(s.name);
      }
      return next;
    });
  }, [externalSkills]);

  const onSkip = useCallback(() => {
    goToStep(NEXT_STEP);
  }, [goToStep]);

  const onContinue = useCallback(async () => {
    if (preview) { goToStep(NEXT_STEP); return; }
    if (selected.size === 0) { goToStep(NEXT_STEP); return; }

    setSaving(true);
    try {
      const res = await onboardingFetch(`/api/skills?agentId=${encodeURIComponent(agentId)}`);
      const data = await res.json();
      const currentEnabled: string[] = (Array.isArray(data?.skills) ? data.skills : [])
        .filter((s: ExternalSkill) => s.enabled)
        .map((s: ExternalSkill) => s.name);
      const nextEnabled = Array.from(new Set([...currentEnabled, ...selected]));

      const putRes = await onboardingFetch(`/api/agents/${encodeURIComponent(agentId)}/skills`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const putData = await putRes.json();
      if (putData?.error) throw new Error(putData.error);

      goToStep(NEXT_STEP);
    } catch (err) {
      console.error('[compat-skills] enable failed:', err);
      showError(t('onboarding.error'));
      setSaving(false);
    }
  }, [preview, selected, agentId, onboardingFetch, goToStep, showError]);

  if (loading) {
    return (
      <StepContainer className="onboarding-step-compat-skills">
        <h1 className="onboarding-title">{t('onboarding.compatSkills.scanning') || '正在扫描已装的 AI 工具…'}</h1>
      </StepContainer>
    );
  }

  return (
    <StepContainer className="onboarding-step-compat-skills">
      <h1 className="onboarding-title">
        {t('onboarding.compatSkills.title') || '发现可复用的 skill'}
      </h1>
      <p className="onboarding-subtitle">
        {t('onboarding.compatSkills.subtitle', { count: externalSkills.length }) || `Lynn 在你的电脑上发现了 ${externalSkills.length} 个来自其他 AI 工具的 skill,勾选后即可直接使用。`}
      </p>

      <div className="compat-skills-groups" style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 20, maxWidth: 560 }}>
        {grouped.map(([label, skills]) => {
          const allSelected = skills.every(s => selected.has(s.name));
          const anySelected = skills.some(s => selected.has(s.name));
          return (
            <div key={label} className="compat-skills-group" style={{ border: '1px solid var(--border, #e0e0e0)', borderRadius: 10, padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <strong>{label}</strong>
                <button
                  type="button"
                  onClick={() => toggleGroup(label, !allSelected)}
                  style={{ fontSize: '0.75rem', padding: '3px 10px', background: 'transparent', border: '1px solid var(--border, #ccc)', borderRadius: 14, cursor: 'pointer' }}
                >
                  {allSelected ? (t('onboarding.compatSkills.deselectAll') || '全部取消') : anySelected ? (t('onboarding.compatSkills.selectAll') || '全部选择') : (t('onboarding.compatSkills.selectAll') || '全部选择')}
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {skills.map(skill => (
                  <label key={skill.name} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', fontSize: '0.85rem' }}>
                    <input
                      type="checkbox"
                      checked={selected.has(skill.name)}
                      onChange={() => toggleSkill(skill.name)}
                      style={{ marginTop: 3 }}
                    />
                    <span>
                      <span style={{ fontWeight: 500 }}>{skill.name}</span>
                      {skill.description && (
                        <span style={{ display: 'block', opacity: 0.7, fontSize: '0.78rem', marginTop: 2 }}>{skill.description}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="onboarding-actions" style={{ marginTop: 24, display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
        <button type="button" className="ob-secondary-btn" onClick={onSkip} disabled={saving}>
          {t('onboarding.compatSkills.skip') || '暂不启用'}
        </button>
        <button type="button" className="ob-primary-btn" onClick={onContinue} disabled={saving}>
          {saving
            ? (t('onboarding.compatSkills.enabling') || '启用中…')
            : selected.size > 0
              ? (t('onboarding.compatSkills.enableCount', { count: selected.size }) || `启用 ${selected.size} 个 skill 并继续`)
              : (t('onboarding.compatSkills.continue') || '继续')}
        </button>
      </div>
    </StepContainer>
  );
}
