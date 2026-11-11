import type { BaseEntry } from "./session-manager.js";

export interface LiveCompactionReplacement {
  entryId: string;
  toolCallId: string;
  originalContentSha256: string;
  bytes: number;
  rawRef: string;
  sha256: string;
  pointer: string;
  replacement: string;
}

export interface LiveCompactionPatchInput {
  version: 1;
  patchId: string;
  baseLeafId: string;
  baseBranchDigest: string;
  previousPatchId: string | null;
  checkpointId: string | null;
  turnId: string;
  sourceRange: { firstEntryId: string; lastEntryId: string };
  replacements: LiveCompactionReplacement[];
}

export interface LiveCompactionEntry extends BaseEntry, LiveCompactionPatchInput {
  type: "live_compaction";
}
