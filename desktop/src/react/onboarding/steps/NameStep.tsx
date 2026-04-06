/**
 * NameStep.tsx — Name input for quick start / advanced setup
 */

import { useState, useCallback } from 'react';
import { saveUserName } from '../onboarding-actions';
import type { OnboardingFetch } from '../onboarding-actions';
import { StepContainer } from '../onboarding-ui';

type OnboardingTrack = 'quick' | 'advanced';

interface NameStepProps {
  preview: boolean;
  onboardingFetch: OnboardingFetch;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
  track: OnboardingTrack;
}

export function NameStep({ preview, onboardingFetch, goToStep, showError, track }: NameStepProps) {
  const [userName, setUserName] = useState('');
  const isQuickTrack = track === 'quick';

  const onNext = useCallback(async () => {
    if (preview) {
      goToStep(isQuickTrack ? 5 : 2);
      return;
    }

    const trimmed = userName.trim();
    try {
      if (trimmed) {
        await saveUserName(onboardingFetch, trimmed);
      }
      goToStep(isQuickTrack ? 5 : 2);
    } catch (err) {
      console.error('[onboarding] save name failed:', err);
      showError(t('onboarding.error'));
    }
  }, [goToStep, onboardingFetch, isQuickTrack, preview, showError, userName]);

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.name.title')}</h1>
      <p className="onboarding-subtitle">{t(isQuickTrack ? 'onboarding.name.quickSubtitle' : 'onboarding.name.subtitle')}</p>
      <input
        className="ob-input"
        type="text"
        style={{ textAlign: 'center', maxWidth: 260 }}
        placeholder={t('onboarding.name.placeholder')}
        value={userName}
        onChange={e => setUserName(e.target.value)}
        autoComplete="off"
      />
      {isQuickTrack && <p className="ob-step-note">{t('onboarding.name.quickHint')}</p>}
      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(0)}>
          {t('onboarding.name.back')}
        </button>
        <button
          className="ob-btn ob-btn-primary"
          onClick={onNext}
        >
          {t(isQuickTrack ? 'onboarding.name.quickNext' : 'onboarding.name.next')}
        </button>
      </div>
    </StepContainer>
  );
}
