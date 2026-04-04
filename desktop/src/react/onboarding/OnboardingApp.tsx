/** OnboardingApp.tsx — Orchestration layer for quick start and advanced setup */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { OnboardingFetch } from './onboarding-actions';
import { LocaleStep } from './steps/LocaleStep';
import { NameStep } from './steps/NameStep';
import { ProviderStep } from './steps/ProviderStep';
import { ModelStep } from './steps/ModelStep';
import { ThemeStep } from './steps/ThemeStep';
import { PermissionsStep } from './steps/PermissionsStep';
import { TutorialStep } from './steps/TutorialStep';

interface OnboardingAppProps { preview: boolean; skipToTutorial: boolean }

type OnboardingTrack = 'quick' | 'advanced';

const QUICK_START_STEPS = [0, 1, 5, 6] as const;
const ADVANCED_SETUP_STEPS = [0, 1, 2, 3, 4, 5, 6] as const;

export function OnboardingApp({ preview, skipToTutorial }: OnboardingAppProps) {
  const [serverPort, setServerPort] = useState<string | null>(null);
  const [serverToken, setServerToken] = useState<string | null>(null);
  const [step, setStep] = useState(skipToTutorial ? 5 : 0);
  const [stepKey, setStepKey] = useState(0);
  const [track, setTrack] = useState<OnboardingTrack | null>(skipToTutorial ? 'quick' : null);
  const [agentName, setAgentName] = useState('Lynn');
  const [avatarSrc, setAvatarSrc] = useState('assets/Lynn-512-opt.png');
  const [locale, setLocale] = useState('zh-CN');
  const [i18nReady, setI18nReady] = useState(false);

  // Provider info passed from ProviderStep to ModelStep
  const [providerName, setProviderName] = useState('');
  const [providerUrl, setProviderUrl] = useState('');
  const [providerApi, setProviderApi] = useState('openai-completions');
  const [apiKey, setApiKey] = useState('');

  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onboardingFetch: OnboardingFetch = useCallback((path, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
    if (serverToken) headers.Authorization = `Bearer ${serverToken}`;
    return fetch(`http://127.0.0.1:${serverPort}${path}`, { ...opts, headers });
  }, [serverPort, serverToken]);

  const showError = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 3000);
  }, []);

  const goToStep = useCallback((index: number) => {
    if (index < 0 || index > 6) return;
    setStepKey(k => k + 1);
    setStep(index);
  }, []);

  const onLocaleChange = useCallback((loc: string) => {
    setLocale(loc);
    setI18nReady(false);
    requestAnimationFrame(() => setI18nReady(true));
  }, []);

  const onProviderReady = useCallback((name: string, url: string, api: string, key: string) => {
    setProviderName(name);
    setProviderUrl(url);
    setProviderApi(api);
    setApiKey(key);
  }, []);

  const selectTrack = useCallback((nextTrack: OnboardingTrack) => {
    setTrack(nextTrack);
    goToStep(1);
  }, [goToStep]);

  useEffect(() => {
    (async () => {
      try {
        const port = await window.hana.getServerPort();
        const token = await window.hana.getServerToken();
        setServerPort(port);
        setServerToken(token);
        const splashInfo = await window.hana.getSplashInfo?.();
        const loc = splashInfo?.locale || 'zh-CN';
        const name = splashInfo?.agentName || 'Lynn';
        setLocale(loc);
        setAgentName(name);
        await i18n.load(loc);
        i18n.defaultName = name;
        setI18nReady(true);
        try {
          const localPath = await window.hana.getAvatarPath?.('agent');
          if (localPath) setAvatarSrc(`file://${encodeURI(localPath)}`);
        } catch { /* ignore */ }
      } catch (err) {
        console.error('[onboarding] init failed:', err);
      }
    })();
  }, []);

  const progressSteps = useMemo(() => {
    if (step === 0 && !track) return [] as number[];
    return track === 'advanced'
      ? [...ADVANCED_SETUP_STEPS]
      : [...QUICK_START_STEPS];
  }, [step, track]);

  const progressIndex = progressSteps.indexOf(step);

  if (!i18nReady) return null;

  return (
    <div className="onboarding">
      {progressSteps.length > 0 && (
        <div className="onboarding-progress">
          {progressSteps.map((stepId, idx) => (
            <div
              key={`dot-${stepId}`}
              className={`onboarding-dot${idx === progressIndex ? ' active' : ''}${progressIndex >= 0 && idx < progressIndex ? ' done' : ''}`}
            />
          ))}
        </div>
      )}

      {step === 0 && (
        <LocaleStep
          key={`step-0-${stepKey}`}
          preview={preview}
          onboardingFetch={onboardingFetch}
          avatarSrc={avatarSrc}
          initialLocale={locale}
          showError={showError}
          onLocaleChange={onLocaleChange}
          onSelectTrack={selectTrack}
        />
      )}
      {step === 1 && track && (
        <NameStep
          key={`step-1-${stepKey}`}
          preview={preview}
          onboardingFetch={onboardingFetch}
          goToStep={goToStep}
          showError={showError}
          track={track}
        />
      )}
      {step === 2 && (
        <ProviderStep
          key={`step-2-${stepKey}`}
          preview={preview}
          onboardingFetch={onboardingFetch}
          goToStep={goToStep}
          showError={showError}
          onProviderReady={onProviderReady}
          track={track ?? 'advanced'}
        />
      )}
      {step === 3 && (
        <ModelStep
          key={`step-3-${stepKey}`}
          preview={preview}
          onboardingFetch={onboardingFetch}
          providerName={providerName}
          providerUrl={providerUrl}
          providerApi={providerApi}
          apiKey={apiKey}
          goToStep={goToStep}
          showError={showError}
        />
      )}
      {step === 4 && <ThemeStep key={`step-4-${stepKey}`} goToStep={goToStep} />}
      {step === 5 && (
        <PermissionsStep
          key={`step-5-${stepKey}`}
          preview={preview}
          onboardingFetch={onboardingFetch}
          goToStep={goToStep}
          showError={showError}
          track={track ?? 'quick'}
        />
      )}
      {step === 6 && (
        <TutorialStep
          key={`step-6-${stepKey}`}
          preview={preview}
          showError={showError}
          track={track ?? 'quick'}
        />
      )}

      {toastMsg && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: 'var(--coral, #c66)', color: '#fff', padding: '8px 20px', borderRadius: 8, fontSize: '0.82rem', zIndex: 999 }}>
          {toastMsg}
        </div>
      )}
    </div>
  );
}
