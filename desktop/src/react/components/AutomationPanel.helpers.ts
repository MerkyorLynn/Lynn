/**
 * AutomationPanel pure helpers — build the de-duplicated model-option list for
 * the automation scheduler. Extracted from AutomationPanel.tsx (GUI monolith
 * decomposition). No React/hooks/JSX — pure over the model list.
 */

import {
  collapseBrainModelChoices,
  normalizeDisplayModelName,
  normalizeDisplayProviderLabel,
} from '../utils/brain-models';
import type { ModelOption } from './automation/types';

export function toModelOptionValue(model: { id: string; provider?: string }): string {
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

export function buildAutomationModelOptions(models: Array<{ id: string; name?: string; provider?: string }>): ModelOption[] {
  const visibleModels = collapseBrainModelChoices(models);
  const labelCounts = new Map<string, number>();
  for (const model of visibleModels) {
    const label = normalizeDisplayModelName(model) || model.name || model.id;
    labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
  }

  return visibleModels.map((model) => {
    const baseLabel = normalizeDisplayModelName(model) || model.name || model.id;
    const needsProvider = (labelCounts.get(baseLabel) || 0) > 1;
    const providerLabel = normalizeDisplayProviderLabel(model.provider) || model.provider || '';
    return {
      value: toModelOptionValue(model),
      label: needsProvider && providerLabel ? `${baseLabel} · ${providerLabel}` : baseLabel,
      rawId: model.id,
      rawProvider: model.provider || '',
    };
  });
}
