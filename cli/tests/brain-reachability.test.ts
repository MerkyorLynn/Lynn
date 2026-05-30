import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { streamBrainChat, checkBrainReachable } from "../src/brain-client.js";

// End-to-end transport test: prove the CLI can reach a brain HTTP endpoint, send a
// first prompt, and consume the streamed completion — the "首问可达" guarantee — using
// a real local server (not a mock of the client). Brain auth is disabled so the test
// needs no signing identity.
let server: http.Server;
let baseUrl = "";
const prevAuth = process.env.LYNN_CLI_DISABLE_BRAIN_AUTH;

beforeAll(async () => {
  process.env.LYNN_CLI_DISABLE_BRAIN_AUTH = "1";
  server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ", world" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (prevAuth === undefined) delete process.env.LYNN_CLI_DISABLE_BRAIN_AUTH;
  else process.env.LYNN_CLI_DISABLE_BRAIN_AUTH = prevAuth;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("CLI ↔ brain reachability (end-to-end transport)", () => {
  it("detects a healthy brain and a dead one via /health", async () => {
    await expect(checkBrainReachable(baseUrl)).resolves.toBe(true);
    await expect(checkBrainReachable("http://127.0.0.1:1")).resolves.toBe(false);
  });

  it("sends a first prompt and consumes the streamed completion", async () => {
    const texts: string[] = [];
    for await (const event of streamBrainChat({ brainUrl: baseUrl, prompt: "hi", reasoning: { effort: "auto", display: "auto" } })) {
      if (event.type === "assistant.delta") texts.push(event.text);
    }
    expect(texts.join("")).toBe("Hello, world");
  });
});
