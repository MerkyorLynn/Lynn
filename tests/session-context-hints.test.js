import { describe, expect, it } from "vitest";
import { stripUnsupportedPromptImagesForModel, toSessionPromptOptions } from "../core/session-context-hints.js";

describe("session context hint prompt option helpers", () => {
  it("keeps images for vision-capable models and builds pi prompt options", () => {
    const opts = { images: [{ data: "abc", mimeType: "image/jpeg" }] };
    const images = stripUnsupportedPromptImagesForModel(
      opts,
      { model: { id: "vision" }, config: { models: { overrides: {} } } },
      () => ({ vision: true }),
    );

    expect(images).toEqual(opts.images);
    expect(toSessionPromptOptions(images)).toEqual({
      images: [{
        type: "image",
        data: "abc",
        mimeType: "image/jpeg",
        source: { type: "base64", mediaType: "image/jpeg", data: "abc" },
      }],
    });
  });

  it("strips images in-place for non-vision models", () => {
    const opts = { images: [{ data: "abc" }] };
    const images = stripUnsupportedPromptImagesForModel(
      opts,
      { model: { id: "text" }, config: { models: { overrides: {} } } },
      () => ({ vision: false }),
    );

    expect(images).toBeUndefined();
    expect(opts.images).toBeUndefined();
  });
});
