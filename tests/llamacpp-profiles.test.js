import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const {
  DEFAULT_MODEL_ID,
  canonicalizeLlamacppModelId,
  decorateDownloadState,
  listLlamacppDownloadProfiles,
  resolveLlamacppDownloadProfile,
} = require("../desktop/llamacpp-profiles.cjs");

describe("llama.cpp model profile boundary", () => {
  it("keeps historical aliases but resolves them to canonical model ids", () => {
    expect(canonicalizeLlamacppModelId("local-qwen35-9b-q4km-imatrix")).toBe(DEFAULT_MODEL_ID);
    expect(resolveLlamacppDownloadProfile("local-qwen35-4b-q4km")).toMatchObject({
      known: true,
      canonicalModelId: "qwen35-4b-q4km",
      profile: { modelId: "qwen35-4b-q4km" },
    });
  });

  it("defaults empty requests to the stable 9B profile", () => {
    expect(resolveLlamacppDownloadProfile()).toMatchObject({
      known: true,
      canonicalModelId: DEFAULT_MODEL_ID,
      profile: { modelId: DEFAULT_MODEL_ID },
    });
  });

  it("does not silently accept unknown IPC model ids", () => {
    const resolved = resolveLlamacppDownloadProfile("../../../not-a-model");
    expect(resolved).toMatchObject({
      known: false,
      requestedModelId: "../../../not-a-model",
      canonicalModelId: DEFAULT_MODEL_ID,
      profile: { modelId: DEFAULT_MODEL_ID },
    });
  });

  it("exposes one option per canonical downloadable model", () => {
    const ids = listLlamacppDownloadProfiles().map((profile) => profile.modelId);
    expect(ids).toEqual([
      "qwen35-4b-q4km",
      "qwen35-9b-q4km-imatrix",
      "qwen36-35b-a3b-apex-mtp",
    ]);
  });

  it("decorates download IPC state with an explicit safe shape", () => {
    const profile = resolveLlamacppDownloadProfile(DEFAULT_MODEL_ID).profile;
    const decorated = decorateDownloadState(profile, {
      state: "downloading",
      bytesTransferred: "10",
      totalBytes: "20",
      percent: 150,
      activeSource: "ModelScope\0hidden",
      target: "/tmp/model.gguf",
      partPath: "/tmp/model.gguf.part",
      parallelSegments: 99,
      paused: 1,
      lastError: "network-error",
      reason: "retrying",
      injected: "do-not-forward",
    });

    expect(decorated).toMatchObject({
      state: "downloading",
      bytesTransferred: 10,
      totalBytes: 20,
      percent: 100,
      activeSource: "ModelScopehidden",
      target: "/tmp/model.gguf",
      partPath: "/tmp/model.gguf.part",
      parallelSegments: 8,
      paused: true,
      lastError: "network-error",
      reason: "retrying",
      modelId: DEFAULT_MODEL_ID,
      fileName: "Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf",
    });
    expect(decorated).not.toHaveProperty("injected");
    expect(decorateDownloadState(profile, { state: "surprise" })).toMatchObject({ state: "idle" });
  });
});
