/**
 * Shared constants — 从 core/engine.js 提取
 */
import {
  codingTools,
  grepTool,
  findTool,
  lsTool,
} from "@mariozechner/pi-coding-agent";

/** 已知的外部 AI 工具技能目录（相对 $HOME） */
export const WELL_KNOWN_SKILL_PATHS = [
  { suffix: ".claude/skills",     label: "Claude Code" },
  { suffix: ".codex/skills",      label: "Codex" },
  { suffix: ".openclaw/skills",   label: "OpenClaw" },
  { suffix: ".pi/agent/skills",   label: "Pi" },
  { suffix: ".agents/skills",     label: "Agents" },
  { suffix: ".codebuddy/skills",  label: "CodeBuddy" },
  { suffix: ".workbuddy/skills-marketplace/skills", label: "WorkBuddy" },
  { suffix: ".skillhub/skills",   label: "Tencent SkillHub (~/.skillhub)" },
  { suffix: "Downloads/SkillHub", label: "Tencent SkillHub (Downloads/SkillHub)" },
  { suffix: "Downloads/skillhub", label: "Tencent SkillHub (Downloads/skillhub)" },
];

/** 内置 coding 工具集 */
export const allBuiltInTools = [...codingTools, grepTool, findTool, lsTool];
