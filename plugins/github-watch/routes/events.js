import {
  appendGithubEvent,
  loadEvents,
  maybeAutoReview,
  normalizeGithubEvent,
  shouldNotify,
  verifyGithubWebhookSignature,
} from "../lib/store.js";

export default function registerGithubWatchRoutes(app, ctx) {
  app.get("/events", (c) => {
    const repo = c.req.query("repo");
    const events = loadEvents(ctx);
    const filtered = repo ? events.filter((event) => event.repository === repo) : events;
    return c.json({ events: filtered });
  });

  app.post("/webhook", async (c) => {
    const rawBody = await c.req.text();
    const eventName = c.req.header("x-github-event") || "unknown";
    const deliveryId = c.req.header("x-github-delivery") || "";
    const signature = c.req.header("x-hub-signature-256") || "";
    const secret = String(ctx.config.get("webhook_secret") || "");

    if (!verifyGithubWebhookSignature(secret, rawBody, signature)) {
      return c.json({ error: "invalid signature" }, 401);
    }

    let payload;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const event = normalizeGithubEvent({ eventName, deliveryId, payload });
    appendGithubEvent(ctx, event);

    ctx.bus?.emit({ type: "github_watch_event", event }, null);

    if (shouldNotify(ctx, event)) {
      ctx.bus?.emit(
        {
          type: "notification",
          title: `[GitHub] ${event.repository}`,
          body: event.summary,
        },
        null,
      );
    }

    let review = null;
    try {
      review = await maybeAutoReview(ctx, event);
      if (review?.content) {
        ctx.bus?.emit(
          {
            type: "notification",
            title: `[GitHub Review] ${event.repository}`,
            body: review.content.slice(0, 220),
          },
          null,
        );
      }
    } catch (err) {
      ctx.log.warn(`auto review failed: ${err?.message || err}`);
    }

    return c.json({ ok: true, event, review });
  });
}
