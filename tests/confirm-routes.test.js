import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createConfirmRoute } from "../server/routes/confirm.js";

function makeConfirmStore() {
  return {
    resolve: vi.fn(() => true),
  };
}

describe("confirm route", () => {
  it("accepts cron confirmation using path param and normalized actions", async () => {
    const confirmStore = makeConfirmStore();
    const engine = { emitEvent: vi.fn() };
    const app = new Hono();
    app.route("/api", createConfirmRoute(confirmStore, engine));

    const res = await app.request("/api/confirm/test-confirm-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirmed" }),
    });

    expect(res.status).toBe(200);
    expect(confirmStore.resolve).toHaveBeenCalledWith("test-confirm-id", "confirmed", undefined);
    expect(engine.emitEvent).toHaveBeenCalledWith({
      type: "confirmation_resolved",
      confirmId: "test-confirm-id",
      action: "confirmed",
      value: undefined,
    }, null);
  });

  it("rejects invalid action payloads", async () => {
    const confirmStore = makeConfirmStore();
    const engine = { emitEvent: vi.fn() };
    const app = new Hono();
    app.route("/api", createConfirmRoute(confirmStore, engine));

    const res = await app.request("/api/confirm/test-confirm-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });

    expect(res.status).toBe(400);
    expect(confirmStore.resolve).not.toHaveBeenCalled();
  });
});
