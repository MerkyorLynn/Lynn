/**
 * todo.js — session 内的待办工具
 *
 * 给 agent 一个"工作草稿纸"，在执行多步骤任务时追踪进度。
 * 状态通过 tool result 的 details 持久化到 session 历史中，
 * 切换 session 时从历史中重建。
 *
 * 灵感来源：Pi SDK examples/extensions/todo.ts
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { t } from "../../server/i18n.js";

/**
 * 创建 todo 工具定义
 * @returns {import('@mariozechner/pi-coding-agent').ToolDefinition}
 */
export function createTodoTool() {
  // session 内状态
  let todos = [];
  let nextId = 1;
  let _reconstructedSessionId = null;

  /**
   * 从当前 session 分支中重建 todo 状态
   * 扫描所有 toolResult(todo) entries，按顺序重放
   */
  function reconstructFromSession(ctx) {
    todos = [];
    nextId = 1;

    try {
      const branch = ctx?.sessionManager?.getBranch?.();
      if (!branch) return;

      for (const entry of branch) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

        const details = msg.details;
        if (details?.todos) {
          todos = details.todos;
          nextId = details.nextId ?? (todos.length + 1);
        }
      }
    } catch (err) {
      console.error("[todo] state reconstruction failed:", err.message);
    }
  }

  /**
   * 确保状态与当前 session 同步
   * 如果 session 变了（session ID 不同），重新扫描历史
   */
  function ensureState(ctx) {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (sessionId && sessionId !== _reconstructedSessionId) {
      reconstructFromSession(ctx);
      _reconstructedSessionId = sessionId;
    }
  }

  /** 构建当前快照（写入 details 供未来重建） */
  function snapshot(action) {
    return { action, todos: [...todos], nextId };
  }

  return {
    name: "todo",
    label: t("toolDef.todo.label"),
    description: t("toolDef.todo.description"),
    parameters: Type.Object({
      action: StringEnum(
        ["list", "add", "toggle", "clear"],
        { description: t("toolDef.todo.actionDesc") },
      ),
      text: Type.Optional(Type.String({ description: t("toolDef.todo.textDesc") })),
      id: Type.Optional(Type.Number({ description: t("toolDef.todo.idDesc") })),
    }),

    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      // 确保状态与当前 session 同步
      ensureState(ctx);

      switch (params.action) {
        case "list": {
          const text = todos.length
            ? todos.map(td => `[${td.done ? "x" : " "}] #${td.id}: ${td.text}`).join("\n")
            : t("error.todoNone");
          return {
            content: [{ type: "text", text }],
            details: snapshot("list"),
          };
        }

        case "add": {
          if (!params.text) {
            return {
              content: [{ type: "text", text: t("error.todoAddNeedText") }],
              details: { ...snapshot("add"), error: "text required" },
            };
          }
          const newTodo = { id: nextId++, text: params.text, done: false };
          todos.push(newTodo);
          return {
            content: [{ type: "text", text: t("error.todoAdded", { id: newTodo.id, text: newTodo.text }) }],
            details: snapshot("add"),
          };
        }

        case "toggle": {
          if (params.id === undefined) {
            return {
              content: [{ type: "text", text: t("error.todoToggleNeedId") }],
              details: { ...snapshot("toggle"), error: "id required" },
            };
          }
          const todo = todos.find(t => t.id === params.id);
          if (!todo) {
            return {
              content: [{ type: "text", text: t("error.todoNotFound", { id: params.id }) }],
              details: { ...snapshot("toggle"), error: `#${params.id} not found` },
            };
          }
          todo.done = !todo.done;
          return {
            content: [{ type: "text", text: t("error.todoToggled", { id: todo.id, state: todo.done ? t("error.todoDone") : t("error.todoUndone") }) }],
            details: snapshot("toggle"),
          };
        }

        case "clear": {
          const count = todos.length;
          todos = [];
          nextId = 1;
          return {
            content: [{ type: "text", text: t("error.todoCleared", { count }) }],
            details: snapshot("clear"),
          };
        }

        default:
          return {
            content: [{ type: "text", text: t("error.unknownAction", { action: params.action }) }],
            details: snapshot("list"),
          };
      }
    },
  };
}
