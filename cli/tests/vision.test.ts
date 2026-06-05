import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { runVisionCommand, buildVisionPrompt } from "../src/commands/vision.js";
import { buildImageContentParts, buildImagesContentParts, inferImageMime, parseImageList } from "../src/media.js";
import { setLang } from "../src/i18n.js";

let tmp = "";
let png = "";

beforeEach(() => setLang("en"));
afterEach(() => setLang(null));

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-vision-"));
  png = path.join(tmp, "shot.png");
  await fs.writeFile(png, Buffer.from("89504e470d0a1a0a", "hex"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("vision commands", () => {
  it("builds image content parts for multimodal routing", async () => {
    const parts = await buildImageContentParts(png, "describe");

    expect(parts[0]).toEqual({ type: "text", text: "describe" });
    expect(parts[1].type).toBe("image_url");
    expect(JSON.stringify(parts[1])).toContain("data:image/png;base64");
    expect(inferImageMime("a.webp")).toBe("image/webp");
  });

  it("builds multiple image content parts for comparison tasks", async () => {
    const second = path.join(tmp, "second.png");
    await fs.writeFile(second, Buffer.from("89504e470d0a1a0a", "hex"));

    const parts = await buildImagesContentParts([png, second], "compare");

    expect(parts[0]).toEqual({ type: "text", text: "compare" });
    expect(parts.filter((part) => part.type === "image_url")).toHaveLength(2);
    expect(parseImageList(`${png}, ${second}`)).toEqual([png, second]);
  });

  it("renders grounding prompt as normalized JSON-first instruction", () => {
    const prompt = buildVisionPrompt("ground", "Submit button");

    expect(prompt).toContain("Target: Submit button");
    expect(prompt).toContain("\"x\"");
    expect(prompt).toContain("normalized");
  });

  it("runs see command in mock mode", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runVisionCommand(parseArgs(["see", png, "what is this", "--mock-brain"]), "see")).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(output).toContain("Mock see");
    expect(output).toContain("what is this");
  });

  it("runs vision through CLI BYOK when Brain is offline", async () => {
    let body = "";
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-vision-test");
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "vision byok ok" } }] })}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runVisionCommand(parseArgs([
        "see",
        png,
        "what is this UI?",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-vision-test",
        "--model",
        "vision-model",
      ]), "see")).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }

    const parsed = JSON.parse(body) as {
      model?: string;
      messages?: Array<{ content?: unknown }>;
    };
    expect(parsed.model).toBe("vision-model");
    expect(JSON.stringify(parsed.messages?.[0]?.content)).toContain("what is this UI?");
    expect(JSON.stringify(parsed.messages?.[0]?.content)).toContain("data:image/png;base64");
    expect(output).toContain("\"activeProvider\":\"cli-byok:openai-compatible\"");
    expect(output).toContain("\"text\":\"vision byok ok\"");
  });

  it("passes --images as multiple multimodal parts", async () => {
    const second = path.join(tmp, "second.png");
    await fs.writeFile(second, Buffer.from("89504e470d0a1a0a", "hex"));
    let body = "";
    const provider = http.createServer((request, response) => {
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "multi image ok" } }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await expect(runVisionCommand(parseArgs([
        "see",
        "compare these",
        "--images",
        `${png},${second}`,
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-vision-test",
        "--model",
        "vision-model",
      ]), "see")).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }

    const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
    const content = parsed.messages?.[0]?.content;
    expect(Array.isArray(content) ? content.filter((part) => (part as { type?: string }).type === "image_url") : []).toHaveLength(2);
  });

  it("emits structured grounding boxes in json mode", async () => {
    const provider = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          `data: ${JSON.stringify({ choices: [{ delta: { content: '{"x":0.25,"y":0.5,"w":0.2,"h":0.1,"confidence":0.88,"label":"submit"}' } }] })}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runVisionCommand(parseArgs([
        "ground",
        png,
        "Submit",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-vision-test",
        "--model",
        "vision-model",
      ]), "ground")).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }

    const events = output.trim().split(/\n+/).map((line) => JSON.parse(line) as { type?: string; boxes?: unknown[] });
    const result = events.find((event) => event.type === "vision.result");
    expect(result?.boxes).toEqual([{
      label: "submit",
      x: 0.25,
      y: 0.5,
      width: 0.2,
      height: 0.1,
      confidence: 0.88,
    }]);
  });

  it("renders grounding boxes in human mode", async () => {
    const provider = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          `data: ${JSON.stringify({ choices: [{ delta: { content: '{"x":0.25,"y":0.5,"w":0.2,"h":0.1,"confidence":0.88,"label":"submit"}' } }] })}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const originalStdout = process.stdout.write;
    const originalStderr = process.stderr.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await expect(runVisionCommand(parseArgs([
        "ground",
        png,
        "Submit",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-vision-test",
        "--model",
        "vision-model",
      ]), "ground", false)).resolves.toBe(0);
    } finally {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }

    expect(output).toContain('"x":0.25');
    expect(output).toContain("Grounding result:");
    expect(output).toContain("submit @ x=25%, y=50% · w=20% · h=10% · conf=88%");
  });
});
