import fs from "fs";
import path from "path";

export type ModelRef = { id: string; provider?: string };

export function readSessionSwitchMeta(opts: {
  sessionPath: string;
  sessionDir: string;
  onReadError?: (err: unknown) => void;
}) {
  let memoryEnabled = true;
  let savedModelRef: ModelRef | null = null;

  try {
    const metaPath = path.join(opts.sessionDir, "session-meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    const sessKey = path.basename(opts.sessionPath);
    const metaEntry = meta[sessKey];
    if (metaEntry?.memoryEnabled === false) memoryEnabled = false;
    // 读取新格式 model:{id,provider} 或旧格式 modelId
    if (metaEntry?.model && typeof metaEntry.model === "object") {
      savedModelRef = metaEntry.model;
    } else if (metaEntry?.modelId) {
      savedModelRef = { id: metaEntry.modelId, provider: "" };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      opts.onReadError?.(err);
    }
  }

  return { memoryEnabled, savedModelRef };
}
