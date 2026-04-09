export const USER_FACING_MODEL_LABELS: Readonly<Record<string, string>>;
export const ASSISTANT_ROLE_MODEL_FALLBACKS: Readonly<Record<string, ReadonlyArray<{ provider: string; id: string }>>>;

export function normalizeAssistantRole(role?: string | null): "lynn" | "hanako" | "butter" | null;
export function getAssistantRoleFromConfig(agentConfig: any): "lynn" | "hanako" | "butter" | null;
export function getRoleDefaultModelRefs(
  roleOrPurpose?: string | null,
  purpose?: "chat" | "review" | "utility" | "utility_large" | null,
): Array<{ provider: string; id: string }>;
export function resolveRoleDefaultModel(
  availableModels: Array<{ id: string; provider?: string | null }>,
  roleOrPurpose?: string | null,
  purpose?: "chat" | "review" | "utility" | "utility_large" | null,
): { id: string; provider?: string | null } | null;
export function getUserFacingRoleModelLabel(
  roleOrPurpose?: string | null,
  purpose?: "chat" | "review" | "utility" | "utility_large" | null,
): string | null;
export function getUserFacingModelAlias(opts?: {
  modelId?: string | null;
  provider?: string | null;
  role?: string | null;
  purpose?: "chat" | "review" | "utility" | "utility_large" | null;
}): string | null;
