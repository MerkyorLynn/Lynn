import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createPluginProxyRoute } from "../server/routes/plugins.js";

describe("plugin route proxy", () => {
  it("dispatches to registered plugin route", async () => {
    const routeRegistry = new Map();
    const pluginApp = new Hono();
    pluginApp.get("/hello", (c) => c.json({ msg: "world" }));
    routeRegistry.set("my-plugin", pluginApp);
    const app = new Hono();
    app.route("/api", createPluginProxyRoute(routeRegistry));
    const res = await app.request("/api/plugins/my-plugin/hello");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ msg: "world" });
  });

  it("dispatches to plugin root routes without a trailing segment", async () => {
    const routeRegistry = new Map();
    const pluginApp = new Hono();
    pluginApp.get("/", (c) => c.json({ ok: true }));
    routeRegistry.set("rooty", pluginApp);
    const app = new Hono();
    app.route("/api", createPluginProxyRoute(routeRegistry));
    const res = await app.request("/api/plugins/rooty");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 404 for unknown plugin", async () => {
    const routeRegistry = new Map();
    const app = new Hono();
    app.route("/api", createPluginProxyRoute(routeRegistry));
    const res = await app.request("/api/plugins/nope/hello");
    expect(res.status).toBe(404);
  });

  it("returns 404 after plugin is removed from registry", async () => {
    const routeRegistry = new Map();
    const pluginApp = new Hono();
    pluginApp.get("/test", (c) => c.text("ok"));
    routeRegistry.set("temp", pluginApp);
    const app = new Hono();
    app.route("/api", createPluginProxyRoute(routeRegistry));
    let res = await app.request("/api/plugins/temp/test");
    expect(res.status).toBe(200);
    routeRegistry.delete("temp");
    res = await app.request("/api/plugins/temp/test");
    expect(res.status).toBe(404);
  });
});
