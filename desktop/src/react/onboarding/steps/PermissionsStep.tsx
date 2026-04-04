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

function uniquePaths(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of paths) {
    const trimmed = String(entry || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function PermissionsStep({
  preview,
  onboardingFetch,
  goToStep,
  showError,
  track,
}: PermissionsStepProps) {
  const [workspacePath, setWorkspacePath] = useState('');
  const [trustedRoots, setTrustedRoots] = useState<string[]>([]);
  const [notificationStatus, setNotificationStatus] = useState<NotificationPermissionStatus>('unsupported');
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [configRes, currentNotificationStatus, defaults] = await Promise.all([
          onboardingFetch('/api/config'),
          window.platform?.getNotificationPermissionStatus?.(),
          window.platform?.getOnboardingDefaults?.(),
        ]);
        const config = await configRes.json();
        const configuredHome = String(config?.desk?.home_folder || '').trim();
        const configuredRoots = uniquePaths(
          Array.isArray(config?.desk?.trusted_roots) ? config.desk.trusted_roots : [],
        );
        const suggestedWorkspace = String(defaults?.workspacePath || '').trim();
        const installRoot = String(defaults?.installRoot || '').trim();
        const preferredWorkspace = !configuredHome || configuredHome === installRoot
          ? (suggestedWorkspace || configuredHome)
          : configuredHome;
        const nextRoots = uniquePaths([
          ...configuredRoots,
          ...(Array.isArray(defaults?.trustedRoots) ? defaults.trustedRoots : []),
          preferredWorkspace,
        ]);

        if (cancelled) return;
        setWorkspacePath(preferredWorkspace);
        setTrustedRoots(nextRoots);
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
      let nextWorkspacePath = workspacePath;
      if (!workspacePath) {
        const folder = await window.platform?.selectFolder?.();
        if (folder) {
          nextWorkspacePath = folder;
        }
      }

      const nextTrustedRoots = uniquePaths([...trustedRoots, nextWorkspacePath]);
      if (nextWorkspacePath) {
        await saveHomeFolder(onboardingFetch, nextWorkspacePath, nextTrustedRoots);
        setWorkspacePath(nextWorkspacePath);
        setTrustedRoots(nextTrustedRoots);
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
          {trustedRoots.length > 0 && (
            <div className="permission-card-meta">
              <span className="permission-card-meta-title">{t('onboarding.permissions.workspace.safeRoots')}</span>
              <div className="permission-card-meta-list">
                {trustedRoots.map((root) => (
                  <span key={root} className="permission-card-root-chip">{root}</span>
                ))}
              </div>
            </div>
          )}
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
