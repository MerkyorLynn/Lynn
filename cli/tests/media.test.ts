import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mediaKindFor, buildImagesContentParts } from "../src/media.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-media-"));

describe("mediaKindFor", () => {
  it("classifies image / audio / video by extension", () => {
    expect(mediaKindFor("a.png")).toBe("image");
    expect(mediaKindFor("a.JPG")).toBe("image");
    expect(mediaKindFor("a.mp3")).toBe("audio");
    expect(mediaKindFor("a.wav")).toBe("audio");
    expect(mediaKindFor("a.mp4")).toBe("video");
    expect(mediaKindFor("a.mov")).toBe("video");
    expect(mediaKindFor("a.txt")).toBe(null);
  });
});

describe("buildImagesContentParts (multimodal)", () => {
  it("builds input_audio for audio and video_url for video", async () => {
    const audio = path.join(dir, "clip.wav");
    const video = path.join(dir, "clip.mp4");
    fs.writeFileSync(audio, Buffer.from("RIFFfakeaudio", "utf8"));
    fs.writeFileSync(video, Buffer.from("fakevideobytes", "utf8"));

    const parts = await buildImagesContentParts([audio, video], "analyze these");
    expect(parts[0]).toEqual({ type: "text", text: "analyze these" });
    expect(parts[1]).toMatchObject({ type: "input_audio", input_audio: { format: "wav" } });
    expect((parts[1] as { input_audio: { data: string } }).input_audio.data.length).toBeGreaterThan(0);
    expect(parts[2]).toMatchObject({ type: "video_url" });
    expect((parts[2] as { video_url: { url: string } }).video_url.url.startsWith("data:video/mp4;base64,")).toBe(true);
  });
});
