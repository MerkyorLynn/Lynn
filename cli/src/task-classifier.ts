import { hasFlag, type ParsedArgs } from "./args.js";
import { withBestCodeFlags } from "./code-best.js";

export type TaskRouteKind = "prompt" | "code" | "goal" | "vision";

export interface ClassifiedTaskRoute {
  kind: TaskRouteKind;
  reason: string;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

const CODE_PATTERNS = [
  /\b(fix|debug|implement|refactor|review|test|lint|typecheck|compile|patch|edit|modify)\b/i,
  /\b(codebase|repo|repository|pull request|pr|diff|worktree|branch)\b/i,
  /\b(src|lib|server|client|desktop|cli|core|shared|tests?)\//i,
  /\b[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cpp|c|h|css|json|md)\b/i,
  /(修复|调试|实现|重构|审查|跑测试|类型检查|编译|补丁|修改|代码|仓库|分支|工作树|提交|提交前)/,
];

const GOAL_PATTERNS = [
  /\b(goal|overnight|long[- ]?run|endurance|keep working|continue until done|do not stop)\b/i,
  /(目标|长任务|过夜|持续|别停|一直|直到完成|做完|完整跑完|连续工作)/,
];

export function classifyTaskRoute(args: ParsedArgs): ClassifiedTaskRoute {
  if (args.command === "goal") return { kind: "goal", reason: "explicit goal command" };
  if (hasFlag(args.flags, "image", "images")) return { kind: "vision", reason: "image flag" };

  const text = [args.command, ...args.positionals].join(" ").trim();
  if (!text) return { kind: "prompt", reason: "empty text" };

  const first = args.command.trim();
  if (IMAGE_EXT_RE.test(first)) return { kind: "vision", reason: "image path positional" };
  if (GOAL_PATTERNS.some((pattern) => pattern.test(text))) return { kind: "goal", reason: "long-running goal language" };
  if (CODE_PATTERNS.some((pattern) => pattern.test(text))) return { kind: "code", reason: "coding task language" };
  return { kind: "prompt", reason: "general prompt" };
}

export function codeArgsForRoute(args: ParsedArgs, route: ClassifiedTaskRoute): ParsedArgs {
  const flags = { ...args.flags };
  if (route.kind === "goal") {
    Object.assign(flags, withBestCodeFlags(flags));
  }
  return {
    ...args,
    command: "code",
    flags,
    positionals: args.command === "goal" ? args.positionals : [args.command, ...args.positionals],
  };
}

export function visionArgsForRoute(args: ParsedArgs): ParsedArgs {
  return {
    ...args,
    command: "see",
    positionals: [args.command, ...args.positionals],
  };
}
