/**
 * model-tool-capabilities.js — runtime guardrails for model/tool compatibility.
 *
 * Some OpenAI-compatible local models advertise tool-call support but fail hard
 * when a tools array is present. Keep those models usable for plain reasoning,
 * while routing tool-heavy turns to a safer execution model.
 */
import { lookupKnown } from "./known-models.js";
import { ROUTE_INTENTS, normalizeRouteIntent } from "./task-route-intent.js";

const BROKEN_TOOLCALL_MODEL_RE = /\b(?:prism[-_\s]*)?nvfp4\b|\bnvfp4[-_\s]*prism\b/i;

export function isNativeToolCallingDisabled(model) {
  if (!model) return false;
  const known = lookupKnown(model.provider, model.id);
  if (known?.supportsToolCalls === false || known?.toolTier === "none") return true;

  const haystack = [
    model.provider,
    model.id,
    model.name,
    model.model,
    model.baseUrl,
    model.baseURL,
  ].filter(Boolean).join(" ");
  return BROKEN_TOOLCALL_MODEL_RE.test(haystack);
}

export function routeIntentRequiresNativeTools(routeIntent) {
  const intent = normalizeRouteIntent(routeIntent);
  return intent === ROUTE_INTENTS.UTILITY || intent === ROUTE_INTENTS.CODING;
}
