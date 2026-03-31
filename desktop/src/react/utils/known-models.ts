import knownModels from '../../../../lib/known-models.json';

export interface KnownModelMeta {
  name?: string;
  provider?: string;
  context?: number | null;
  contextWindow?: number | null;
  maxOutput?: number | null;
  maxTokens?: number | null;
  vision?: boolean;
  reasoning?: boolean;
}

type KnownProviderModels = Record<string, KnownModelMeta>;
type KnownModelsDict = Record<string, string | KnownProviderModels>;

const dict = knownModels as unknown as KnownModelsDict;

function findInProvider(provider: string, modelId: string): KnownModelMeta | null {
  const models = dict[provider];
  if (!models || typeof models !== 'object') return null;
  return models[modelId] || null;
}

export function lookupKnownModel(provider: string, modelId: string): KnownModelMeta | null {
  if (!modelId) return null;

  const bare = modelId.includes('/') ? modelId.split('/').pop() || '' : '';
  const scoped = provider ? (findInProvider(provider, modelId) || (bare ? findInProvider(provider, bare) : null)) : null;
  if (scoped) return { provider, ...scoped };

  for (const [providerKey, models] of Object.entries(dict)) {
    if (providerKey === '_comment' || !models || typeof models !== 'object') continue;
    if (models[modelId]) return { provider: providerKey, ...models[modelId] };
    if (bare && models[bare]) return { provider: providerKey, ...models[bare] };
  }

  return null;
}
