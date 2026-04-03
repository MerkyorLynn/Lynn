/**
 * PermissionsStep.tsx — Workspace + notifications setup
 */

import { useCallback, useEffect, useState } from 'react';
import type { NotificationPermissionStatus } from '../../types';
import { saveHomeFolder } from '../onboarding-actions';
import type { OnboardingFetch } from '../onboarding-actions';
import { Multiline, StepContainer } from '../onboarding-ui';

type OnboardingTrack = 'quick' | 'advanced';

interface PermissionsStepProps {
  preview: boolean;
  onboardingFetch: OnboardingFetch;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
  track: OnboardingTrack;
}

function getNotificationStatusKey(status: NotificationPermissionStatus, loading: boolean): string {
  if (loading) return 'checking';
  if (status === 'not-determined') return 'pending';
  return status;
}

function getNotificationStatusTone(status: NotificationPermissionStatus, loading: boolean): string {
  if (loading || status === 'not-determined') return 'pending';
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  return 'neutral';
}

export function PermissionsStep({
  preview,
  onboardingFetch,
  goToStep,
  showError,
  track,
}: PermissionsStepProps) {
  const [workspacePath, setWorkspacePath] = useState('');
  const [notificationStatus, setNotificationStatus] = useState<NotificationPermissionStatus>('unsupported');
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [configRes, currentNotificationStatus] = await Promise.all([
          onboardingFetch('/api/config'),
          window.platform?.getNotificationPermissionStatus?.(),
        ]);
        const config = await configRes.json();

        if (cancelled) return;
        setWorkspacePath(config?.desk?.home_folder || '');
        setNotificationStatus(currentNotificationStatus || 'unsupported');
      } catch (err) {
        console.error('[onboarding] load permissions context failed:', err);
        if (!cancelled) {
          setNotificationStatus('unsupported');
        }
      } finally {
        if (!cancelled) setLoadingStatus(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [onboardingFetch]);

  const continueToTutorial = useCallback(() => {
    goToStep(6);
  }, [goToStep]);

  const runAuthorizationFlow = useCallback(async () => {
    if (preview) {
      continueToTutorial();
      return;
    }

    setSaving(true);
    try {
      if (!workspacePath) {
        const folder = await window.platform?.selectFolder?.();
        if (folder) {
          await saveHomeFolder(onboardingFetch, folder);
          setWorkspacePath(folder);
        }
      }

      if (notificationStatus === 'not-determined') {
        const nextStatus = await window.platform?.requestNotificationPermission?.();
        setNotificationStatus(nextStatus || 'unsupported');
      }

      continueToTutorial();
    } catch (err) {
      console.error('[onboarding] authorize permissions failed:', err);
      showError(t('onboarding.error'));
      setSaving(false);
      return;
    }

    setSaving(false);
  }, [continueToTutorial, notificationStatus, onboardingFetch, preview, showError, workspacePath]);

  const notificationStatusKey = getNotificationStatusKey(notificationStatus, loadingStatus);
  const notificationStatusTone = getNotificationStatusTone(notificationStatus, loadingStatus);
  const backStep = track === 'quick' ? 1 : 4;

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.permissions.title')}</h1>
      <Multiline className="onboarding-subtitle" text={t('onboarding.permissions.subtitle')} />

      <div className="permission-grid">
        <div className="permission-card">
          <div className="permission-card-header">
            <span className="permission-card-title">{t('onboarding.permissions.workspace.title')}</span>
            <span className={`permission-card-status permission-card-status-${workspacePath ? 'granted' : 'pending'}`}>
              {t(workspacePath ? 'onboarding.permissions.workspace.selected' : 'onboarding.permissions.workspace.pending')}
            </span>
          </div>
          <Multiline className="permission-card-desc" text={t('onboarding.permissions.workspace.desc')} />
          <div className="permission-card-value" title={workspacePath || undefined}>
            {workspacePath || t('onboarding.permissions.workspace.placeholder')}
          </div>
        </div>

        <div className="permission-card">
          <div className="permission-card-header">
            <span className="permission-card-title">{t('onboarding.permissions.notifications.title')}</span>
            <span className={`permission-card-status permission-card-status-${notificationStatusTone}`}>
              {t(`onboarding.permissions.notifications.status.${notificationStatusKey}`)}
            </span>
          </div>
          <Multiline className="permission-card-desc" text={t('onboarding.permissions.notifications.desc')} />
          <div className="permission-card-value">
            {t('onboarding.permissions.notifications.detail')}
          </div>
        </div>
      </div>

      <p className="ob-step-note">{t('onboarding.permissions.note')}</p>

      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(backStep)}>
          {t('onboarding.permissions.back')}
        </button>
        <button className="ob-btn ob-btn-primary" disabled={saving} onClick={runAuthorizationFlow}>
          {t(saving ? 'onboarding.permissions.working' : 'onboarding.permissions.continue')}
        </button>
      </div>
    </StepContainer>
  );
}
