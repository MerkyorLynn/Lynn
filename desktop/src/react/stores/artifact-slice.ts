import type { Artifact } from '../types';

interface TabState {
  openTabs: string[];
  activeTabId: string | null;
}

export interface ArtifactSlice {
  artifacts: Artifact[];
  openTabs: string[];
  activeTabId: string | null;
  editorDetached: boolean;
  tabStateBySession: Record<string, TabState>;
  setArtifacts: (artifacts: Artifact[]) => void;
  setEditorDetached: (detached: boolean) => void;
  openTab: (id: string) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  saveTabState: (sessionPath: string) => void;
  restoreTabState: (sessionPath: string) => void;
}

export const createArtifactSlice = (
  set: (partial: Partial<ArtifactSlice> | ((s: ArtifactSlice) => Partial<ArtifactSlice>)) => void
): ArtifactSlice => ({
  artifacts: [],
  openTabs: [],
  activeTabId: null,
  editorDetached: false,
  tabStateBySession: {},
  setArtifacts: (artifacts) => set({ artifacts }),
  setEditorDetached: (detached) => set({ editorDetached: detached }),
  openTab: (id) =>
    set((s) => {
      const tabs = s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id];
      return { openTabs: tabs, activeTabId: id };
    }),
  closeTab: (id) =>
    set((s) => {
      const idx = s.openTabs.indexOf(id);
      if (idx < 0) return {};
      const tabs = s.openTabs.filter((t) => t !== id);
      let active = s.activeTabId;
      if (active === id) {
        active = tabs[Math.max(0, idx - 1)] ?? null;
      }
      return { openTabs: tabs, activeTabId: active };
    }),
  setActiveTab: (id) => set({ activeTabId: id }),
  saveTabState: (sessionPath) =>
    set((s) => ({
      tabStateBySession: {
        ...s.tabStateBySession,
        [sessionPath]: { openTabs: s.openTabs, activeTabId: s.activeTabId },
      },
    })),
  restoreTabState: (sessionPath) =>
    set((s) => {
      const saved = s.tabStateBySession[sessionPath];
      if (saved) return { openTabs: saved.openTabs, activeTabId: saved.activeTabId };
      return { openTabs: [], activeTabId: null };
    }),
});

// ── Selectors ──
export const selectArtifacts = (s: ArtifactSlice) => s.artifacts;
export const selectActiveTabId = (s: ArtifactSlice) => s.activeTabId;
export const selectEditorDetached = (s: ArtifactSlice) => s.editorDetached;
