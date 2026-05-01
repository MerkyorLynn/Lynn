/**
 * active-task.js — active_task 工具
 *
 * 让 agent 显式维护当前正在推进的任务状态，供后续 system prompt 注入。
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

function pickTaskParams(params = {}) {
  const picked = {
    title: params.title,
    status: params.status,
    goal: params.goal,
    next_step: params.next_step,
    project_path: params.project_path,
    notes: params.notes,
    evidence: params.evidence,
    source: "active_task_tool",
  };
  for (const key of Object.keys(picked)) {
    if (picked[key] === undefined) delete picked[key];
  }
  return picked;
}

export function createActiveTaskTool(activeTaskMemory, { onUpdated } = {}) {
  return {
    name: "active_task",
    label: "Active Task",
    description: "Read or update the current long-running task state when the user asks to continue ongoing work, mentions blockers, or changes the active goal.",
    parameters: Type.Object({
      action: StringEnum(["get", "set", "patch", "clear"], {
        description: "get reads current state, set replaces it, patch updates selected fields, clear removes it",
      }),
      title: Type.Optional(Type.String({ description: "Short task title" })),
      status: Type.Optional(StringEnum(["idle", "active", "blocked", "done"], {
        description: "Current task status",
      })),
      goal: Type.Optional(Type.String({ description: "Current user-facing goal" })),
      next_step: Type.Optional(Type.String({ description: "The concrete next step to do" })),
      project_path: Type.Optional(Type.String({ description: "Related project path" })),
      notes: Type.Optional(Type.Array(Type.String(), { description: "Important constraints or pitfalls" })),
      evidence: Type.Optional(Type.Array(Type.String(), { description: "Short evidence items such as test names or benchmark outputs" })),
    }),
    execute: async (_toolCallId, params) => {
      if (!activeTaskMemory) {
        return {
          content: [{ type: "text", text: "Active task storage is unavailable." }],
          details: { error: "active task storage unavailable" },
        };
      }

      switch (params.action) {
        case "get": {
          const task = activeTaskMemory.get();
          return {
            content: [{ type: "text", text: task ? activeTaskMemory.formatForPrompt(true) : "No active task." }],
            details: { task },
          };
        }

        case "set": {
          const task = activeTaskMemory.set(pickTaskParams(params));
          onUpdated?.();
          return {
            content: [{ type: "text", text: "Active task updated." }],
            details: { task },
          };
        }

        case "patch": {
          const task = activeTaskMemory.patch(pickTaskParams(params));
          onUpdated?.();
          return {
            content: [{ type: "text", text: "Active task updated." }],
            details: { task },
          };
        }

        case "clear": {
          activeTaskMemory.clear();
          onUpdated?.();
          return {
            content: [{ type: "text", text: "Active task cleared." }],
            details: { task: null },
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown active_task action: ${params.action}` }],
            details: { error: "unknown action" },
          };
      }
    },
  };
}
