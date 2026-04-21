import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

describe("OAuth auth route", () => {
  it("maps Lynn OAuth provider ids to the auth.json provider key on login start", async () => {
    const { createAuthRoute } = await import("../server/routes/auth.js");
    const app = new Hono();

    const login = vi.fn(async (providerId, callbacks) => {
      callbacks.onAuth({
        url: "https://chatgpt.com/oauth/start",
        instructions: "ignored-for-callback-server",
      });
    });

    const engine = {
      authStorage: {
        getOAuthProviders: () => [
          { id: "openai-codex", name: "OpenAI Codex", usesCallbackServer: true },
        ],
        login,
      },
      providerRegistry: {
        getAuthJsonKey: (providerId) => providerId === "openai-codex-oauth" ? "openai-codex" : providerId,
      },
      syncModelsAndRefresh: vi.fn(),
    };

    app.route("/api", createAuthRoute(engine));

    const res = await app.request("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-codex-oauth" }),
    });

    expect(res.status).toBe(200);
    expect(login).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({
        onAuth: expect.any(Function),
        onPrompt: expect.any(Function),
      }),
    );

    const data = await res.json();
    expect(data.url).toBe("https://chatgpt.com/oauth/start");
    expect(data.polling).toBe(true);
    expect(data.instructions).toBeUndefined();
  });
});
