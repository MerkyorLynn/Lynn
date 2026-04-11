export type StartupStepStatus = 'pending' | 'running' | 'success' | 'error' | 'warning';

export type StartupStep = {
  id: string;
  label: string;
  status: StartupStepStatus;
  at: string;
  detail?: string | null;
  meta?: Record<string, unknown> | null;
};

export interface StartupSlice {
  startupSteps: StartupStep[];
  startupPhase: 'idle' | 'running' | 'ready' | 'degraded';
  startupStartedAt: string | null;
  startupFinishedAt: string | null;
  resetStartupDiagnostics: () => void;
  markStartupStep: (
    id: string,
    label: string,
    status: StartupStepStatus,
    detail?: string | null,
    meta?: Record<string, unknown> | null
  ) => void;
  setStartupPhase: (phase: StartupSlice['startupPhase']) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

export const createStartupSlice = (
  set: (
    partial:
      | Partial<StartupSlice>
      | ((state: StartupSlice) => Partial<StartupSlice>)
  ) => void
): StartupSlice => ({
  startupSteps: [],
  startupPhase: 'idle',
  startupStartedAt: null,
  startupFinishedAt: null,

  resetStartupDiagnostics: () =>
    set({
      startupSteps: [],
      startupPhase: 'running',
      startupStartedAt: nowIso(),
      startupFinishedAt: null,
    }),

  markStartupStep: (id, label, status, detail = null, meta = null) =>
    set((state) => {
      const timestamp = nowIso();
      const nextStep: StartupStep = {
        id,
        label,
        status,
        at: timestamp,
        detail,
        meta,
      };
      const existingIndex = state.startupSteps.findIndex((item) => item.id === id);
      const startupSteps = [...state.startupSteps];
      if (existingIndex >= 0) startupSteps[existingIndex] = nextStep;
      else startupSteps.push(nextStep);

      const hasError = startupSteps.some((item) => item.status === 'error');
      const hasWarning = startupSteps.some((item) => item.status === 'warning');
      const allFinished = startupSteps.length > 0 && startupSteps.every((item) => item.status !== 'running' && item.status !== 'pending');
      const startupPhase: StartupSlice['startupPhase'] =
        hasError ? 'degraded'
          : allFinished
            ? (hasWarning ? 'degraded' : 'ready')
            : 'running';

      return {
        startupSteps,
        startupPhase,
        startupFinishedAt: allFinished ? timestamp : null,
      };
    }),

  setStartupPhase: (phase) =>
    set({
      startupPhase: phase,
      startupFinishedAt: phase === 'ready' || phase === 'degraded' ? nowIso() : null,
    }),
});
