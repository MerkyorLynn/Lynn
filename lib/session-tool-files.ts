import path from "node:path";
import { registerSessionFile } from "./session-files.js";

const FILE_CREATORS = new Set([
  "createreport", "createdocx", "createpdf", "createpptx", "createxlsx",
  "generateimage", "generatevideo", "ttsspeak",
]);

/** Register outputs at execution time, including sessions without a GUI subscriber.
 * Never discover attachments by parsing model text or arbitrary tool stdout. */
export function registerCreatedToolFiles(
  sessionPath: string | undefined,
  toolName: string,
  args: unknown,
  result: any,
  cwd: string,
): void {
  if (!sessionPath || result?.isError) return;
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const name = toolName.toLowerCase().replace(/[-_]/g, "");
  let files: Array<{ filePath?: unknown; label?: string }> = [];
  if ((name === "write" || name === "edit") && typeof input.path === "string") {
    files = [{ filePath: input.path }];
  } else if (FILE_CREATORS.has(name)) {
    const details = result?.details;
    files = Array.isArray(details?.files) ? details.files : details?.filePath ? [details] : [];
  }
  for (const file of files.slice(0, 100)) {
    if (typeof file?.filePath !== "string" || !file.filePath) continue;
    try {
      registerSessionFile(sessionPath, path.resolve(cwd, file.filePath), { name: file.label });
    } catch { /* Missing, oversized, or unavailable outputs remain undeliverable. */ }
  }
}
