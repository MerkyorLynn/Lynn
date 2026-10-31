export interface AgentDraft {
  name: string; identity: string; ishiki: string; experience: string; yuan: string; nameTouched: boolean;
}
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const cache = new Map<string, AgentDraft>();
const key = (id: string) => `lynn-settings-agent-draft-v1:${id}`;
function browserStorage(): DraftStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}
export function loadAgentDraft(id: string, storage = browserStorage()): AgentDraft | undefined {
  if (cache.has(id)) return cache.get(id);
  try {
    const raw = storage?.getItem(key(id));
    if (!raw || raw.length > 2 * 1024 * 1024) return;
    const draft = JSON.parse(raw);
    if (!["name", "identity", "ishiki", "experience", "yuan"].every(field => typeof draft?.[field] === "string")) return;
    const categories = JSON.parse(draft.experience);
    if (!Array.isArray(categories) || !categories.every(c => c && typeof c.name === "string" && Array.isArray(c.entries) && c.entries.every((entry: unknown) => typeof entry === "string"))) return;
    const value: AgentDraft = { name: draft.name, identity: draft.identity, ishiki: draft.ishiki, experience: draft.experience, yuan: draft.yuan, nameTouched: draft.nameTouched === true };
    cache.set(id, value);
    return value;
  } catch { return; }
}
export function saveAgentDraft(id: string, draft: AgentDraft, storage = browserStorage()): boolean {
  cache.set(id, draft);
  while (cache.size > 32) cache.delete(cache.keys().next().value!);
  try {
    if (!storage) return false;
    const value = JSON.stringify(draft);
    if (value.length > 2 * 1024 * 1024) return false;
    storage.setItem(key(id), value);
    return true;
  } catch { return false; }
}
export function clearAgentDraft(id: string, storage = browserStorage()): void {
  cache.delete(id);
  try { storage?.removeItem(key(id)); } catch { /* Existing server values remain authoritative. */ }
}
