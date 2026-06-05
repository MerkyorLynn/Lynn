import { displayCwd } from "./startup.js";
import { dim } from "./terminal-style.js";

export interface StatusBarInput {
  model?: string;
  cwd?: string;
  mode?: string;
  reasoning?: string;
  usage?: string | null;
  metrics?: string | null;
  decodeTps?: string | null;
  color?: boolean;
}

export function renderStatusBar(input: StatusBarInput): string {
  const parts = [
    input.model || "StepFun/Brain",
    displayCwd(input.cwd || process.cwd()),
    input.mode,
    input.reasoning ? `think ${input.reasoning}` : null,
    input.decodeTps ? `decode ${input.decodeTps}` : null,
    input.metrics,
    input.usage,
  ].filter((part): part is string => !!part);
  return dim(parts.join(" · "), !!input.color);
}
