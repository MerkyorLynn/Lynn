import type { DeskFile } from '../types';

export interface DeskSkillInfo {
  name: string;
  enabled: boolean;
  source?: string;
  externalLabel?: string | null;
}

export interface CwdSkillInfo {
  name: string;
  description: string;
  source: string;
  filePath: string;
  baseDir: string;
  providerLabel?: string | null;
}

export interface DeskOpenDocument {
  path: string;
  name: string;
  content: string;
}

export interface DeskPatrolStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  text: string;
  updatedAt: number | null;
}

export interface DeskAutomationJob {
  id: string;
  label: string;
  enabled: boolean;
  schedule: string | number;
  nextRunAt: string | null;
  workspace: string;
  model?: string | null;
}

export interface DeskAutomationStatus {
  count: number;
  enabledCount: number;
  pausedCount: number;
  nextRunAt: string | null;
  text: string;
}

export interface DeskSlice {
  deskFiles: DeskFile[];
  deskBasePath: string;
  deskCurrentPath: string;
  deskJianContent: string | null;
  deskOpenDoc: DeskOpenDocument | null;
  deskPatrolStatus: DeskPatrolStatus | null;
  deskAutomationJobs: DeskAutomationJob[];
  deskAutomationStatus: DeskAutomationStatus | null;
  deskSkills: DeskSkillInfo[];
  cwdSkills: CwdSkillInfo[];
  cwdSkillsOpen: boolean;
  homeFolder: string | null;
  trustedRoots: string[];
  selectedFolder: string | null;
  cwdHistory: string[];
  setCwdSkills: (skills: CwdSkillInfo[]) => void;
  setCwdSkillsOpen: (open: boolean) => void;
  toggleCwdSkillsOpen: () => void;
  setDeskFiles: (files: DeskFile[]) => void;
  setDeskBasePath: (path: string) => void;
  setDeskCurrentPath: (path: string) => void;
  setDeskJianContent: (content: string | null) => void;
  setDeskOpenDoc: (doc: DeskOpenDocument | null) => void;
  setDeskPatrolStatus: (status: DeskPatrolStatus | null) => void;
  setDeskAutomationJobs: (jobs: DeskAutomationJob[]) => void;
  setDeskAutomationStatus: (status: DeskAutomationStatus | null) => void;
  setDeskSkills: (skills: DeskSkillInfo[]) => void;
  setHomeFolder: (folder: string | null) => void;
  setTrustedRoots: (roots: string[]) => void;
  setSelectedFolder: (folder: string | null) => void;
  setCwdHistory: (history: string[]) => void;
}

export const createDeskSlice = (
  set: (partial: Partial<DeskSlice>) => void,
  get?: () => DeskSlice,
): DeskSlice => ({
  deskFiles: [],
  deskBasePath: '',
  deskCurrentPath: '',
  deskJianContent: null,
  deskOpenDoc: null,
  deskPatrolStatus: null,
  deskAutomationJobs: [],
  deskAutomationStatus: null,
  deskSkills: [],
  cwdSkills: [],
  cwdSkillsOpen: false,
  homeFolder: null,
  trustedRoots: [],
  selectedFolder: null,
  cwdHistory: [],
  setCwdSkills: (skills) => set({ cwdSkills: skills }),
  setCwdSkillsOpen: (open) => set({ cwdSkillsOpen: open }),
  toggleCwdSkillsOpen: () => set({ cwdSkillsOpen: !get?.().cwdSkillsOpen }),
  setDeskFiles: (files) => set({ deskFiles: files }),
  setDeskBasePath: (path) => set({ deskBasePath: path }),
  setDeskCurrentPath: (path) => set({ deskCurrentPath: path }),
  setDeskJianContent: (content) => set({ deskJianContent: content }),
  setDeskOpenDoc: (doc) => set({ deskOpenDoc: doc }),
  setDeskPatrolStatus: (status) => set({ deskPatrolStatus: status }),
  setDeskAutomationJobs: (jobs) => set({ deskAutomationJobs: jobs }),
  setDeskAutomationStatus: (status) => set({ deskAutomationStatus: status }),
  setDeskSkills: (skills) => set({ deskSkills: skills }),
  setHomeFolder: (folder) => set({ homeFolder: folder }),
  setTrustedRoots: (roots) => set({ trustedRoots: roots }),
  setSelectedFolder: (folder) => set({ selectedFolder: folder }),
  setCwdHistory: (history) => set({ cwdHistory: history }),
});
