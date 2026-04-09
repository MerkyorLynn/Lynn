import {
  BRAIN_DEFAULT_META_LABEL,
  BRAIN_DEFAULT_MODEL_ID,
  BRAIN_PROVIDER_ID,
  getBrainDisplayName,
  isBrainModelRef,
} from '../../../../shared/brain-provider.js';
import { getUserFacingModelAlias } from '../../../../shared/assistant-role-models.js';
import { parseSharedModelRef } from './model-ref';

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

export interface UserVisibleModelOption {
  value: string;
  label: string;
  rawId: string;
  rawProvider: string;
}

type ModelLabelContext = {
  role?: string | null;
  purpose?: 'chat' | 'review' | 'utility' | 'utility_large' | null;
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

export function normalizeDisplayModelName(model: BrainModelLike | null | undefined, context?: ModelLabelContext): string {
  if (!model?.id) return '';
  const alias = getUserFacingModelAlias({
    modelId: model.id,
    provider: model.provider,
    role: context?.role,
    purpose: context?.purpose,
  });
  if (alias) return alias;
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

export function formatCompactModelLabel(
  model: { id?: string | null; provider?: string | null } | null | undefined,
  context?: ModelLabelContext,
): string | null {
  if (!model?.id) return null;
  const alias = getUserFacingModelAlias({
    modelId: model.id,
    provider: model.provider || undefined,
    role: context?.role,
    purpose: context?.purpose,
  });
  if (alias) return alias;
  if (isDisplayDefaultModel(model.id, model.provider)) return getBrainDisplayName();
  return model.provider ? `${model.provider} / ${model.id}` : model.id;
}

export function formatUserFacingModelRef(ref: unknown): string | null {
  const parsed = parseSharedModelRef(ref);
  if (!parsed.id) return null;
  return normalizeDisplayModelName({
    id: parsed.id,
    provider: parsed.provider || undefined,
    name: parsed.id,
  }) || parsed.id;
}

export function encodeUserVisibleModelValue(model: { id: string; provider?: string | null }): string {
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

export function decodeUserVisibleModelValue(value: string): { id?: string; provider?: string } {
  if (!value) return {};
  const splitIndex = value.indexOf('/');
  if (splitIndex === -1) return { id: value };
  return {
    provider: value.slice(0, splitIndex) || undefined,
    id: value.slice(splitIndex + 1) || undefined,
  };
}

export function buildUserVisibleModelOptions<T extends BrainModelLike>(models: T[]): UserVisibleModelOption[] {
  const visibleModels = collapseBrainModelChoices(models);
  const labelCounts = new Map<string, number>();

  for (const model of visibleModels) {
    const label = normalizeDisplayModelName(model) || model.name || model.id;
    labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
  }

  return visibleModels.map((model) => {
    const baseLabel = normalizeDisplayModelName(model) || model.name || model.id;
    const providerLabel = normalizeDisplayProviderLabel(model.provider) || model.provider || '';
    const needsProvider = (labelCounts.get(baseLabel) || 0) > 1;
    return {
      value: encodeUserVisibleModelValue(model),
      label: needsProvider && providerLabel ? `${baseLabel} · ${providerLabel}` : baseLabel,
      rawId: model.id,
      rawProvider: model.provider || '',
    };
  });
}
