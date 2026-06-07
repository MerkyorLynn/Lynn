import { hasFlag, type ParsedArgs } from "./args.js";
import type { ChatMode } from "./commands/chat.js";
import type { ReasoningOptions } from "./reasoning.js";

export const BEST_MAX_STEPS = "300";
export const BEST_ULTRA_MAX_SUBTASKS = "8";
export const BEST_ULTRA_CONCURRENCY = "3";

export function bestEnabled(args: ParsedArgs): boolean {
  return hasFlag(args.flags, "best", "exhaustive");
}

export function withBestCodeFlags(flags: Record<string, string | boolean> = {}): Record<string, string | boolean> {
  return {
    ...flags,
    best: flags.best ?? true,
    long: flags.long ?? true,
    "save-session": flags["save-session"] ?? true,
    "max-steps": flags["max-steps"] ?? BEST_MAX_STEPS,
    ultra: flags.ultra ?? true,
    "ultra-verify": flags["ultra-verify"] ?? true,
    "ultra-max-subtasks": flags["ultra-max-subtasks"] ?? BEST_ULTRA_MAX_SUBTASKS,
    "ultra-concurrency": flags["ultra-concurrency"] ?? BEST_ULTRA_CONCURRENCY,
    reasoning: flags.reasoning ?? "high",
  };
}

export function parseBestSlashTask(text: string): string | null {
  return text.startsWith("/best ") || text.startsWith("/exhaustive ")
    ? text.replace(/^\/(?:best|exhaustive)\s+/i, "").trim()
    : null;
}

export function bestCodeArgs(base: ParsedArgs, task: string, mode: ChatMode, reasoning: ReasoningOptions): ParsedArgs {
  return {
    ...base,
    positionals: [task],
    flags: withBestCodeFlags({
      ...base.flags,
      approval: mode.approval,
      sandbox: mode.sandbox,
      reasoning: reasoning.effort,
      "show-reasoning": reasoning.display,
    }),
  };
}
