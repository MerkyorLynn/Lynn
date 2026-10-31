import path from "node:path";

/** A file preview must never expose application credentials, including custom data homes. */
export function isSensitiveFilePath(value: string, dataRoot?: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  if (/\/(?:\.provider-key-seed|(?:user\/)?(?:mcp-credentials|oauth-credentials)\.json)(?:$|\.)/i.test(normalized)) return true;
  if (/\/(?:\.ssh|\.aws|\.azure)\//i.test(normalized)) return true;
  if (/\/(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials)(?:$|\.)/i.test(normalized)) return true;
  if (/\/\.kube\/config(?:$|\.)|\/\.docker\/config\.json(?:$|\.)/i.test(normalized)) return true;
  if (/\.env(?:\.[^/]*)?$/i.test(normalized)) return true;
  if (/\/\.lynn(?:-engine)?\/(?:providers\/|(?:brain\.env|auth\.json|models\.json|preferences\.json|added-models\.yaml)(?:$|\.))/i.test(normalized)) return true;
  if (dataRoot) {
    const relative = path.relative(dataRoot, value).split(path.sep).join("/");
    if (!relative.startsWith("../") && !path.isAbsolute(relative)
      && /^(?:providers\/|(?:user\/)?(?:brain\.env|auth\.json|models\.json|preferences\.json|added-models\.yaml|mcp-credentials\.json)(?:$|\.))/i.test(relative)) return true;
  }
  return false;
}
