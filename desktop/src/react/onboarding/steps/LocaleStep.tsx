/**
 * LocaleStep.tsx — Welcome + locale selection + start track choice
 */

import { useState, useCallback } from 'react';
import { LOCALES } from '../constants';
import { saveLocale } from '../onboarding-actions';
import type { OnboardingFetch } from '../onboarding-actions';
import { StepContainer, Multiline } from '../onboarding-ui';

type OnboardingTrack = 'quick' | 'advanced';

interface LocaleStepProps {
  preview: boolean;
  onboardingFetch: OnboardingFetch;
  avatarSrc: string;
  initialLocale: string;
  showError: (msg: string) => void;
  onLocaleChange: (locale: string) => void;
  onSelectTrack: (track: OnboardingTrack) => void;
}

export function LocaleStep({
  preview, onboardingFetch, avatarSrc, initialLocale,
  showError, onLocaleChange, onSelectTrack,
}: LocaleStepProps) {
  const [locale, setLocale] = useState(initialLocale);
  const [submittingTrack, setSubmittingTrack] = useState<OnboardingTrack | null>(null);

  const changeLocale = useCallback(async (loc: string) => {
    if (locale === loc) return;
    setLocale(loc);
    onLocaleChange(loc);
    await i18n.load(loc);
  }, [locale, onLocaleChange]);

  const handleSelectTrack = useCallback(async (track: OnboardingTrack) => {
    if (submittingTrack) return;
    setSubmittingTrack(track);
    try {
      if (!preview) {
        await saveLocale(onboardingFetch, locale);
      }
      onSelectTrack(track);
    } catch (err) {
      console.error('[onboarding] save locale failed:', err);
      showError(t('onboarding.error'));
      setSubmittingTrack(null);
    }
  }, [onboardingFetch, locale, onSelectTrack, preview, showError, submittingTrack]);

  const isBundledLynnAvatar = avatarSrc.includes('assets/Lynn-512-opt.png') || avatarSrc.includes('assets/Lynn.png');

  return (
    <StepContainer>
      <div className={`onboarding-avatar-shell${isBundledLynnAvatar ? ' onboarding-avatar-shell-bundled-lynn' : ''}`}>
        <img className="onboarding-avatar" src={avatarSrc} draggable={false} alt="" />
      </div>
      <h1 className="onboarding-title">{t('onboarding.welcome.title')}</h1>
      <Multiline className="onboarding-subtitle" text={t('onboarding.welcome.subtitle')} />
      <div className="ob-locale-picker">
        {LOCALES.map(loc => (
          <button
            key={loc.value}
            className={`ob-locale-btn${locale === loc.value ? ' active' : ''}`}
            onClick={() => changeLocale(loc.value)}
          >
            <span>{loc.label}</span>
          </button>
        ))}
      </div>

      <div className="ob-track-grid">
        <button
          className="ob-track-card ob-track-card-primary"
          disabled={!!submittingTrack}
          onClick={() => handleSelectTrack('quick')}
        >
          <span className="ob-track-badge">Quick Start</span>
          <span className="ob-track-title">{t('onboarding.welcome.quickTitle')}</span>
          <Multiline className="ob-track-desc" text={t('onboarding.welcome.quickDesc')} />
          <span className="ob-track-action">{t('onboarding.welcome.quickAction')}</span>
        </button>

        <button
          className="ob-track-card"
          disabled={!!submittingTrack}
          onClick={() => handleSelectTrack('advanced')}
        >
          <span className="ob-track-badge">Advanced Setup</span>
          <span className="ob-track-title">{t('onboarding.welcome.advancedTitle')}</span>
          <Multiline className="ob-track-desc" text={t('onboarding.welcome.advancedDesc')} />
          <span className="ob-track-action ob-track-action-secondary">{t('onboarding.welcome.advancedAction')}</span>
        </button>
      </div>
    </StepContainer>
  );
}
