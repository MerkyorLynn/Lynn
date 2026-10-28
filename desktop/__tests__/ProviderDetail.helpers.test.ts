import { describe, expect, it } from "vitest";
import {
  isLocalQwenProviderId,
  isDefaultQwen35MtpFileName,
  formatLocalTps,
  largestLocalGpu,
  normalizeLocalUpgradeOptions,
  localEndpointRoot,
  formatBytes,
  localModelActionErrorText,
} from "../src/react/settings/tabs/providers/ProviderDetail.helpers";

describe("local-qwen id / filename", () => {
  it("isLocalQwenProviderId recognizes the compat set + local-qwen prefix", () => {
    expect(isLocalQwenProviderId("local-qwen35-9b-q4km-imatrix")).toBe(true);
    expect(isLocalQwenProviderId("local-qwen-anything")).toBe(true);
    expect(isLocalQwenProviderId("openai")).toBe(false);
    expect(isLocalQwenProviderId(null)).toBe(false);
  });
  it("isDefaultQwen35MtpFileName matches the canonical 27B Coding Q4 shards only", () => {
    expect(isDefaultQwen35MtpFileName("Q4-imatrix-MTP-00001-of-00004.gguf")).toBe(true);
    expect(isDefaultQwen35MtpFileName("Q4-imatrix-MTP-00004-of-00004.gguf")).toBe(true);
    expect(isDefaultQwen35MtpFileName("Qwen3.6-27B-DSV4Pro-GLM52-SFT-GPT55-RL-Coding-Q4-MTP.gguf")).toBe(true);
    expect(isDefaultQwen35MtpFileName("Qwen3.6-27B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf")).toBe(false);
    expect(isDefaultQwen35MtpFileName("Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf")).toBe(false);
    expect(isDefaultQwen35MtpFileName("other.gguf")).toBe(false);
  });
});

describe("local hardware without a dedicated GPU", () => {
  it("accepts the empty GPU list returned for Apple Silicon and missing hardware", () => {
    expect(largestLocalGpu([])).toBeUndefined();
    expect(largestLocalGpu(undefined)).toBeUndefined();
    expect(largestLocalGpu(null)).toBeUndefined();
  });
  it("still selects the largest dedicated GPU without modifying the list", () => {
    const small = { name: "GPU 0", memory_gib: 16 };
    const large = { name: "GPU 1", memory_gib: 24 };
    const devices = [small, large];
    expect(largestLocalGpu(devices)).toBe(large);
    expect(largestLocalGpu([large, small])).toBe(large);
    expect(devices).toEqual([small, large]);
    expect(largestLocalGpu([small])).toBe(small);
  });
});

describe("formatters", () => {
  it("formatLocalTps rounds by magnitude, nulls invalid", () => {
    expect(formatLocalTps(42)).toBe("42 tok/s");
    expect(formatLocalTps(7.34)).toBe("7.3 tok/s");
    expect(formatLocalTps(null)).toBeNull();
    expect(formatLocalTps(NaN)).toBeNull();
  });
  it("formatBytes scales to the right unit", () => {
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(5_780_090_944)).toBe("5.4 GB");
  });
  it("localEndpointRoot strips trailing /v1", () => {
    expect(localEndpointRoot("http://127.0.0.1:18099/v1")).toBe("http://127.0.0.1:18099");
    expect(localEndpointRoot(null)).toBe("http://127.0.0.1:18099");
  });
});

describe("normalizeLocalUpgradeOptions (memory-adaptive)", () => {
  it("shows 35B when memory is unknown and hides 9B and 4B", () => {
    const out = normalizeLocalUpgradeOptions([], null);
    expect(out.some((o) => o.id === "qwen35-4b-q4km")).toBe(false);
    expect(out.some((o) => o.id === "qwen35-9b-q4km-imatrix")).toBe(false);
    expect(out.some((o) => o.id === "qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix")).toBe(true);
  });
  it("keeps 35B on large machines", () => {
    const out = normalizeLocalUpgradeOptions([], 64);
    expect(out.some((o) => o.id === "qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix")).toBe(true);
  });
  it("hides the 35B upgrade below 32GB", () => {
    const out = normalizeLocalUpgradeOptions([], 16);
    expect(out.some((o) => o.id === "qwen35-4b-q4km")).toBe(false);
    expect(out.some((o) => o.id === "qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix")).toBe(false);
  });
  it("drops 27B, 9B, and 4B from the optional list", () => {
    const out = normalizeLocalUpgradeOptions([{ id: "x-9b" }, { id: "z-4b" }, { id: "y-27b" }], 28);
    expect(out.some((o) => o.id === "x-9b")).toBe(false);
    expect(out.some((o) => o.id === "z-4b")).toBe(false);
    expect(out.some((o) => o.id === "y-27b")).toBe(false);
  });
});

describe("localModelActionErrorText", () => {
  it("maps known reasons to friendly text, passes through detail", () => {
    expect(localModelActionErrorText("another-download-running")).toContain("已有其他本地模型");
    expect(localModelActionErrorText("not-gguf")).toContain(".gguf");
    expect(localModelActionErrorText("insufficient-disk-space", "disk full")).toBe("disk full");
    expect(localModelActionErrorText("weird", "raw detail")).toBe("raw detail");
  });
});
