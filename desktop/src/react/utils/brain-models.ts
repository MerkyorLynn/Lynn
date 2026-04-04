import {
  BRAIN_DEFAULT_META_LABEL,
  BRAIN_DEFAULT_MODEL_ID,
  BRAIN_PROVIDER_ID,
  getBrainDisplayName,
  isBrainModelRef,
} from '../../../../shared/brain-provider.js';

type BrainModelLike = {
  id: string;
  name?: string;
  provider?: string;
  isCurrent?: boolean;
  contextWindow?: number | null;
  maxTokens?: number | null;
  locked?: boolean;
  metaLabel?: string;
};

function cloneCollapsedBrainModel<T extends BrainModelLike>(model: T, isCurrent: boolean): T {
  return {
    ...model,
    id: BRAIN_DEFAULT_MODEL_ID,
    provider: BRAIN_PROVIDER_ID,
    name: getBrainDisplayName(),
    metaLabel: BRAIN_DEFAULT_META_LABEL,
    isCurrent,
  };
}

export function isDisplayDefaultModel(modelId?: string | null, provider?: string | null): boolean {
  return isBrainModelRef(modelId || '', provider || '');
}

export function normalizeDisplayModelId(modelId?: string | null, provider?: string | null): string {
  if (isDisplayDefaultModel(modelId, provider)) return BRAIN_DEFAULT_MODEL_ID;
  return String(modelId || '');
}

export function normalizeDisplayModelName(model: BrainModelLike | null | undefined): string {
  if (!model?.id) return '';
  if (isDisplayDefaultModel(model.id, model.provider)) return getBrainDisplayName();
  return model.name || model.id;
}

export function normalizeDisplayProviderLabel(provider?: string | null): string {
  if (String(provider || '').trim() === BRAIN_PROVIDER_ID) return getBrainDisplayName();
  return String(provider || '');
}

export function collapseBrainModelChoices<T extends BrainModelLike>(models: T[]): T[] {
  const brainModels = models.filter((model) => isDisplayDefaultModel(model.id, model.provider));
  if (brainModels.length === 0) return models;

  const brainCurrent = brainModels.find((model) => model.isCurrent) || brainModels[0];
  const hasCurrentBrain = brainModels.some((model) => model.isCurrent);
  const collapsed = cloneCollapsedBrainModel(brainCurrent, hasCurrentBrain);

  const result: T[] = [];
  let inserted = false;
  for (const model of models) {
    if (isDisplayDefaultModel(model.id, model.provider)) {
      if (!inserted) {
        result.push(collapsed);
        inserted = true;
      }
      continue;
    }
    result.push(model);
  }

  if (!inserted) result.unshift(collapsed);
  return result;
}

export function formatCompactModelLabel(model: { id?: string | null; provider?: string | null } | null | undefined): string | null {
  if (!model?.id) return null;
  if (isDisplayDefaultModel(model.id, model.provider)) return getBrainDisplayName();
  return model.provider ? `${model.provider} / ${model.id}` : model.id;
}
