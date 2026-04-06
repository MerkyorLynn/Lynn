import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { TaskRuntime } from "../../hub/task-runtime.js";

function parseQueryBoolean(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return undefined;
}

export function createTasksRoute(taskRuntime, engine) {
  const route = new Hono();

  route.get("/tasks", (c) => {
    const sessionPath = c.req.query("sessionPath") || null;
    const includeAll = parseQueryBoolean(c.req.query("all")) === true;
    const tasks = taskRuntime
      .listTasks()
      .filter((task) => includeAll || !sessionPath || task.sessionPath === sessionPath);
    return c.json({ tasks });
  });

  route.get("/tasks/:id", (c) => {
    const task = taskRuntime.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ task });
  });

  route.post("/tasks", async (c) => {
    const body = await safeJson(c);
    const kind = body.kind === "review"
      ? "review"
      : body.kind === "plan"
        ? "plan"
        : "delegate";

    if (kind === "review") {
      if (!body.context || typeof body.context !== "string") {
        return c.json({ error: "context is required" }, 400);
      }
      const task = taskRuntime.createReviewTask({
        title: body.title,
        context: body.context,
        reviewerKind: body.reviewerKind === "butter" ? "butter" : "hanako",
        sessionPath: body.sessionPath || engine.currentSessionPath || null,
        source: body.source || "chat",
        metadata: body.metadata || {},
      });
      return c.json({ ok: true, task: taskRuntime.buildTaskChatBlock(task.id) });
    }

    if (!body.prompt || typeof body.prompt !== "string") {
      return c.json({ error: "prompt is required" }, 400);
    }

    if (kind === "plan") {
      const task = taskRuntime.createPlanTask({
        title: body.title,
        prompt: body.prompt,
        agentId: body.agentId || engine.currentAgentId,
        sessionPath: body.sessionPath || engine.currentSessionPath || null,
        source: body.source || "chat",
        model: body.model || null,
        systemAppend: body.systemAppend || null,
        noMemory: !!body.noMemory,
        cwdOverride: body.cwdOverride || null,
        metadata: body.metadata || {},
      });
      return c.json({ ok: true, task: taskRuntime.buildTaskChatBlock(task.id) });
    }

    const task = taskRuntime.createDelegateTask({
      title: body.title,
      prompt: body.prompt,
      agentId: body.agentId || engine.currentAgentId,
      sessionPath: body.sessionPath || engine.currentSessionPath || null,
      source: body.source || "chat",
      readOnly: body.readOnly !== false,
      model: body.model || null,
      systemAppend: body.systemAppend || null,
      noMemory: !!body.noMemory,
      noTools: !!body.noTools,
      cwdOverride: body.cwdOverride || null,
      metadata: body.metadata || {},
    });

    return c.json({ ok: true, task: taskRuntime.buildTaskChatBlock(task.id) });
  });

  route.post("/tasks/:id/cancel", (c) => {
    const task = taskRuntime.cancelTask(c.req.param("id"));
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ ok: true, task: taskRuntime.buildTaskChatBlock(task.id) });
  });

  route.post("/tasks/:id/retry", (c) => {
    const task = taskRuntime.retryTask(c.req.param("id"));
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ ok: true, task: taskRuntime.buildTaskChatBlock(task.id) });
  });

  return route;
}

export { TaskRuntime };
