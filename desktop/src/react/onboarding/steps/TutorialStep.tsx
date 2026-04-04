/**
 * TutorialStep.tsx — Finish step for quick start / advanced setup
 */

import { useState, useCallback } from 'react';
import { StepContainer, Multiline } from '../onboarding-ui';

// ── SVG Icons ──

const MemoryIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v0m0 8c0-2 1.5-2.5 1.5-4.5a1.5 1.5 0 10-3 0C10.5 13.5 12 14 12 16z" />
  </svg>
);

const SkillsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
);

const WorkspaceIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
  </svg>
);

const JianIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
);

const PatrolIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l7 4v5c0 5-3.5 7.7-7 9-3.5-1.3-7-4-7-9V7l7-4z" />
    <path d="M9.5 12l1.8 1.8L15 10.1" />
  </svg>
);

const ActivityIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="M7 15l3-3 2 2 5-5" />
  </svg>
);

function TutorialCard({ icon, title, desc }: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="tutorial-card">
      <div className="tutorial-card-header">
        <span className="tutorial-card-icon">{icon}</span>
        <span className="tutorial-card-title">{title}</span>
      </div>
      <Multiline className="tutorial-card-desc" text={desc} />
    </div>
  );
}

type OnboardingTrack = 'quick' | 'advanced';

interface TutorialStepProps {
  preview: boolean;
  showError: (msg: string) => void;
  track: OnboardingTrack;
}

export function TutorialStep({ preview, showError, track }: TutorialStepProps) {
  const [finishing, setFinishing] = useState(false);
  const isQuickTrack = track === 'quick';

  const onFinish = useCallback(async () => {
    if (preview) { window.close(); return; }
    setFinishing(true);
    try {
      await window.hana.onboardingComplete?.();
    } catch (err) {
      console.error('[onboarding] complete failed:', err);
      showError(t('onboarding.error'));
      setFinishing(false);
    }
  }, [preview, showError]);

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t(isQuickTrack ? 'onboarding.tutorial.quickTitle' : 'onboarding.tutorial.title')}</h1>
      {isQuickTrack && (
        <div className="ob-step-banner">
          <div className="ob-step-banner-title">{t('onboarding.tutorial.quickBannerTitle')}</div>
          <Multiline className="ob-step-banner-desc" text={t('onboarding.tutorial.quickBannerDesc')} />
        </div>
      )}

      <div className="tutorial-cards">
        <TutorialCard
          icon={<WorkspaceIcon />}
          title={t('onboarding.tutorial.workspace.title')}
          desc={t('onboarding.tutorial.workspace.desc')}
        />
        <TutorialCard
          icon={<JianIcon />}
          title={t('onboarding.tutorial.jian.title')}
          desc={t('onboarding.tutorial.jian.desc')}
        />
        <TutorialCard
          icon={<PatrolIcon />}
          title={t('onboarding.tutorial.patrol.title')}
          desc={t('onboarding.tutorial.patrol.desc')}
        />
        <TutorialCard
          icon={<MemoryIcon />}
          title={t('onboarding.tutorial.memory.title')}
          desc={t('onboarding.tutorial.memory.desc')}
        />
        <TutorialCard
          icon={<ActivityIcon />}
          title={t('onboarding.tutorial.activity.title')}
          desc={t('onboarding.tutorial.activity.desc')}
        />
        <TutorialCard
          icon={<SkillsIcon />}
          title={t('onboarding.tutorial.skills.title')}
          desc={t('onboarding.tutorial.skills.desc')}
        />
      </div>

      <div className="onboarding-actions onboarding-actions-finish">
        <button className="ob-finish-btn" disabled={finishing} onClick={onFinish}>
          {t(isQuickTrack ? 'onboarding.tutorial.quickFinish' : 'onboarding.tutorial.finish')}
        </button>
      </div>
    </StepContainer>
  );
}
