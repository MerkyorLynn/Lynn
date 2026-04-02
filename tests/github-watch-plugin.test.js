import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import crypto from "crypto";
import { EventBus } from "../hub/event-bus.js";
import { PluginManager } from "../core/plugin-manager.js";

const tmpRoots = [];

function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-github-watch-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

async function createLoadedPlugin({ secret = "", autoReview = true, notifyOnPr = true } = {}) {
  const root = makeTempRoot();
  const dataDir = path.join(root, "plugin-data");
  const bus = new EventBus();
  const notifications = [];
  const emittedEvents = [];
  bus.subscribe((event) => {
    emittedEvents.push(event);
    if (event.type === "notification") notifications.push(event);
  });

  const engine = {
    currentAgentId: "lynn-main",
    getAgent(id) {
      return id === "lynn-main" ? { id, agentName: "Lynn" } : null;
    },
    listAgents() {
      return [{ id: "lynn-main", name: "Lynn", yuan: "lynn" }];
    },
    async executeIsolated() {
      return { replyText: "High-level review: inspect migrations and CI coverage.", error: null };
    },
  };

  const pm = new PluginManager({
    pluginsDirs: [path.join(process.cwd(), "plugins")],
    dataDir,
    bus,
    engine,
  });
  pm.scan();
  await pm.loadAll();

  const plugin = pm.getPlugin("github-watch");
  plugin.instance?.ctx.config.set("webhook_secret", secret);
  plugin.instance?.ctx.config.set("auto_review", autoReview);
  plugin.instance?.ctx.config.set("notify_on_pr", notifyOnPr);
  plugin.instance?.ctx.config.set("max_events", 5);

  const app = new Hono();
  app.route("/api", pm.routeRegistry.get("github-watch"));

  return { app, pm, plugin, notifications, emittedEvents, dataDir };
}

function samplePullRequestPayload() {
  return {
    action: "opened",
    repository: {
      full_name: "MerkyorLynn/Lynn",
    },
    sender: {
      login: "lynn",
    },
    pull_request: {
      number: 42,
      title: "Refine Lynn memory retrieval",
      html_url: "https://github.com/MerkyorLynn/Lynn/pull/42",
      state: "open",
      draft: false,
      changed_files: 7,
      additions: 120,
      deletions: 18,
      head: { ref: "feature/memory" },
      base: { ref: "main" },
    },
  };
}

function signPayload(secret, body) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("github-watch plugin", () => {
  it("stores webhook events and lists them back", async () => {
    const { app, notifications } = await createLoadedPlugin();
    const body = JSON.stringify(samplePullRequestPayload());

    const res = await app.request("/api/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-1",
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.event.repository).toBe("MerkyorLynn/Lynn");
    expect(json.review.content).toContain("High-level review");
    expect(notifications.length).toBe(2);

    const listRes = await app.request("/api/events");
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.events).toHaveLength(1);
    expect(listJson.events[0].pullRequest.number).toBe(42);
  });

  it("rejects invalid webhook signatures when a secret is configured", async () => {
    const secret = "top-secret";
    const { app } = await createLoadedPlugin({ secret });
    const body = JSON.stringify(samplePullRequestPayload());

    const res = await app.request("/api/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signPayload("wrong-secret", body),
      },
      body,
    });

    expect(res.status).toBe(401);
  });

  it("filters stored events by repository", async () => {
    const { app } = await createLoadedPlugin({ autoReview: false, notifyOnPr: false });

    const payloadA = samplePullRequestPayload();
    const payloadB = JSON.parse(JSON.stringify(samplePullRequestPayload()));
    payloadB.repository.full_name = "MerkyorLynn/OtherRepo";
    payloadB.pull_request.number = 43;
    payloadB.pull_request.title = "Other repo change";

    await app.request("/api/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      body: JSON.stringify(payloadA),
    });
    await app.request("/api/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      body: JSON.stringify(payloadB),
    });

    const res = await app.request("/api/events?repo=MerkyorLynn/Lynn");
    const json = await res.json();
    expect(json.events).toHaveLength(1);
    expect(json.events[0].repository).toBe("MerkyorLynn/Lynn");
  });
});
