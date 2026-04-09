export const ROUTE_INTENTS: Readonly<{
  CHAT: "chat";
  REASONING: "reasoning";
  UTILITY: "utility";
  CODING: "coding";
  VISION: "vision";
}>;

export function normalizeRouteIntent(
  value?: string | null,
): "chat" | "reasoning" | "utility" | "coding" | "vision";

export function classifyRouteIntent(
  text?: string | null,
  opts?: { imagesCount?: number; attachmentsCount?: number },
): "chat" | "reasoning" | "utility" | "coding" | "vision";

export function buildRouteIntentSystemHint(
  routeIntent?: string | null,
  locale?: string | null,
): string;

export function getRouteIntentNoticeKey(routeIntent?: string | null): string;

export function getDefaultRouteSlowNoticeKey(
  routeIntent?: string | null,
  elapsedMs?: number,
): string;

export function getDefaultRouteRecoveryNoticeKey(routeIntent?: string | null): string;
