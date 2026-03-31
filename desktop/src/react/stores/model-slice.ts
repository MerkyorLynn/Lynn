import type { Model } from '../types';

export type ThinkingLevel = 'off' | 'auto' | 'high' | 'xhigh';

export interface ModelSlice {
  models: Model[];
  currentModel: { id: string; provider: string } | null;
  utilityModel: { id: string; provider: string } | null;
  utilityLargeModel: { id: string; provider: string } | null;
  thinkingLevel: ThinkingLevel;
  setModels: (models: Model[]) => void;
  setCurrentModel: (model: { id: string; provider: string } | null) => void;
  setUtilityModel: (model: { id: string; provider: string } | null) => void;
  setUtilityLargeModel: (model: { id: string; provider: string } | null) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
}

export const createModelSlice = (
  set: (partial: Partial<ModelSlice>) => void
): ModelSlice => ({
  models: [],
  currentModel: null,
  utilityModel: null,
  utilityLargeModel: null,
  thinkingLevel: 'auto',
  setModels: (models) => set({ models }),
  setCurrentModel: (model) => set({ currentModel: model }),
  setUtilityModel: (model) => set({ utilityModel: model }),
  setUtilityLargeModel: (model) => set({ utilityLargeModel: model }),
  setThinkingLevel: (level) => set({ thinkingLevel: level }),
});
