export const CHAT_LIFECYCLE_EVENTS = Object.freeze([
  "prompt_start",
  "tool_start",
  "tool_end",
  "turn_end",
  "turn_close",
]);

export function createLifecycleHooks(opts = {}) {
  const handlers = new Map();
  const validEvents = new Set(opts.events || CHAT_LIFECYCLE_EVENTS);

  function assertEvent(eventName) {
    if (!validEvents.has(eventName)) {
      throw new Error(`Unknown lifecycle hook: ${eventName}`);
    }
  }

  function tap(eventName, handler) {
    assertEvent(eventName);
    if (typeof handler !== "function") {
      throw new TypeError("Lifecycle hook handler must be a function");
    }
    const list = handlers.get(eventName) || [];
    list.push(handler);
    handlers.set(eventName, list);
    return () => {
      const next = (handlers.get(eventName) || []).filter((item) => item !== handler);
      if (next.length > 0) handlers.set(eventName, next);
      else handlers.delete(eventName);
    };
  }

  function run(eventName, context = {}) {
    assertEvent(eventName);
    const list = handlers.get(eventName) || [];
    for (const handler of list) {
      try {
        handler(context);
      } catch (err) {
        opts.onError?.(err, { eventName, context });
      }
    }
    return list.length;
  }

  function count(eventName) {
    assertEvent(eventName);
    return (handlers.get(eventName) || []).length;
  }

  return { tap, run, count };
}
