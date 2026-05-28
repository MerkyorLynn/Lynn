export interface CronJob {
  id: string;
  enabled: boolean;
  label?: string;
  prompt?: string;
  schedule: string | number;
  model?: string;
  workspace?: string;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  latestRun?: {
    status?: string;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
    timestamp?: string;
  } | null;
  latestActivity?: {
    id?: string;
    summary?: string;
    status?: string;
    error?: string | null;
    startedAt?: number | null;
    finishedAt?: number | null;
    sessionFile?: string | null;
    outputFile?: string | null;
    workspace?: string;
  } | null;
}

export interface ModelOption {
  value: string;
  label: string;
  rawId: string;
  rawProvider: string;
}
