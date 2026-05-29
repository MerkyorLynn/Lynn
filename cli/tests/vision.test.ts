import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { runVisionCommand, buildVisionPrompt } from "../src/commands/vision.js";
import { buildImageContentParts, inferImageMime } from "../src/media.js";
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

describe("MiMo vision commands", () => {
  it("builds image content parts for MiMo multimodal routing", async () => {
    const parts = await buildImageContentParts(png, "describe");

    expect(parts[0]).toEqual({ type: "text", text: "describe" });
    expect(parts[1].type).toBe("image_url");
    expect(JSON.stringify(parts[1])).toContain("data:image/png;base64");
    expect(inferImageMime("a.webp")).toBe("image/webp");
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
});
