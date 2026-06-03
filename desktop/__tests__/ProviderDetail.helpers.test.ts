import { describe, expect, it } from "vitest";
import {
  isLocalQwenProviderId,
  isDefaultQwen35MtpFileName,
  formatLocalTps,
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
  it("isDefaultQwen35MtpFileName matches the canonical + loose mtp names", () => {
    expect(isDefaultQwen35MtpFileName("Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf")).toBe(true);
    expect(isDefaultQwen35MtpFileName("qwen35-9b-q4km-mtp.gguf")).toBe(true);
    expect(isDefaultQwen35MtpFileName("other.gguf")).toBe(false);
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
  it("shows both downgrade + upgrade when memory is unknown", () => {
    const out = normalizeLocalUpgradeOptions([], null);
    expect(out.some((o) => o.id === "qwen35-4b-q4km")).toBe(true);
    expect(out.some((o) => o.id === "qwen36-35b-a3b-apex-mtp")).toBe(true);
  });
  it("hides the 4B downgrade on >32GB machines, keeps 35B", () => {
    const out = normalizeLocalUpgradeOptions([], 64);
    expect(out.some((o) => o.id === "qwen35-4b-q4km")).toBe(false);
    expect(out.some((o) => o.id === "qwen36-35b-a3b-apex-mtp")).toBe(true);
  });
  it("hides the 35B upgrade on <22GB machines, keeps 4B", () => {
    const out = normalizeLocalUpgradeOptions([], 16);
    expect(out.some((o) => o.id === "qwen35-4b-q4km")).toBe(true);
    expect(out.some((o) => o.id === "qwen36-35b-a3b-apex-mtp")).toBe(false);
  });
  it("drops 9b/27b server options from the optional list", () => {
    const out = normalizeLocalUpgradeOptions([{ id: "x-9b" }, { id: "y-27b" }], 28);
    expect(out.some((o) => o.id === "x-9b" || o.id === "y-27b")).toBe(false);
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
