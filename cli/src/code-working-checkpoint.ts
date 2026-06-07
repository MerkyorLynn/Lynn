// Native working checkpoint — a model-controlled scratchpad that is re-injected
// before every model call and survives history compaction.
//
// This keeps durable context small without adding another process boundary: the
// model curates one capped notepad, the loop pins the latest content into
// context each turn, and the model overwrites it via the
// update_working_checkpoint tool. Clean-room TS, zero external dependency.

const MAX_CHECKPOINT_CHARS = 4000;

export function workingCheckpointEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LYNN_CLI_WORKING_CHECKPOINT === "1";
}

/**
 * Normalize and cap the model-supplied checkpoint content. A blank or non-string
 * value clears the checkpoint (returns ""). Oversized content is truncated so the
 * notepad can never become a token hog — that bound is the whole point.
 */
export function applyWorkingCheckpoint(content: unknown): string {
  if (typeof content !== "string") return "";
  const trimmed = content.trim();
  if (!trimmed) return "";
  return trimmed.length > MAX_CHECKPOINT_CHARS
    ? `${trimmed.slice(0, MAX_CHECKPOINT_CHARS - 1)}…`
    : trimmed;
}

/** The frame pinned right before each model call (recency → the model attends to it). */
export function formatWorkingCheckpointFrame(content: string): string {
  return [
    "## Working checkpoint (your own notes — kept fresh every step, survives compaction)",
    "Update it with the update_working_checkpoint tool. Treat it as your durable memory.",
    "",
    content,
  ].join("\n");
}

/** Observation returned to the model after it overwrites the checkpoint. */
export function workingCheckpointObservation(content: string): string {
  return content
    ? `Working checkpoint saved (${content.length} chars). It is re-injected every step until you change it — rely on it instead of long history.`
    : "Working checkpoint cleared.";
}

export const MAX_WORKING_CHECKPOINT_CHARS = MAX_CHECKPOINT_CHARS;
