import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const P = require("../model-source-policy.cjs");

afterEach(() => { delete process.env[P.INSECURE_MODEL_SOURCE_ENV]; });

describe("isPrivateIpv4 / isLocalOrPrivateHost (SSRF guard)", () => {
  it("flags loopback, RFC1918, link-local, CGNAT, multicast", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.5", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
      expect(P.isLocalOrPrivateHost(ip)).toBe(true);
    }
  });
  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(P.isLocalOrPrivateHost(ip)).toBe(false);
    }
  });
  it("flags hostnames: localhost, *.local, IPv6 loopback/ULA, mapped IPv4", () => {
    expect(P.isLocalOrPrivateHost("localhost")).toBe(true);
    expect(P.isLocalOrPrivateHost("foo.local")).toBe(true);
    expect(P.isLocalOrPrivateHost("[::1]")).toBe(true);
    expect(P.isLocalOrPrivateHost("fd00::1")).toBe(true);
    expect(P.isLocalOrPrivateHost("::ffff:127.0.0.1")).toBe(true);
    expect(P.isLocalOrPrivateHost("")).toBe(true); // empty → treat as unsafe
    expect(P.isLocalOrPrivateHost("example.com")).toBe(false);
  });
});

describe("validateModelSourceUrl", () => {
  const ok = "https://huggingface.co/x/model.gguf";
  it("accepts a public https .gguf URL", () => {
    expect(P.validateModelSourceUrl(ok)).toBe(ok);
  });
  it("rejects bad scheme / credentials / private host / non-gguf", () => {
    expect(() => P.validateModelSourceUrl("ftp://h/x.gguf")).toThrow("unsupported-url-scheme");
    expect(() => P.validateModelSourceUrl("https://u:p@h.com/x.gguf")).toThrow("credentials-not-allowed");
    expect(() => P.validateModelSourceUrl("https://127.0.0.1/x.gguf")).toThrow("local-or-private-host-not-allowed");
    expect(() => P.validateModelSourceUrl("https://h.com/x.bin")).toThrow("source-must-end-with-gguf");
    expect(() => P.validateModelSourceUrl("not a url")).toThrow("invalid-url");
  });
  it("honors enforceGgufPath:false and the insecure-host opt-out env", () => {
    expect(P.validateModelSourceUrl("https://h.com/x.bin", { enforceGgufPath: false })).toBe("https://h.com/x.bin");
    process.env[P.INSECURE_MODEL_SOURCE_ENV] = "1";
    expect(P.validateModelSourceUrl("http://127.0.0.1:8080/x.gguf")).toBe("http://127.0.0.1:8080/x.gguf");
  });
});

describe("normalizeDownloadSources", () => {
  it("validates, assigns ids, and de-duplicates ids", () => {
    const out = P.normalizeDownloadSources([
      "https://huggingface.co/a/m.gguf",
      { url: "https://huggingface.co/b/m.gguf", label: "Mirror" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("huggingface.co");
    expect(out[1].id).toBe("huggingface.co-2"); // dedup
    expect(out[1].label).toBe("Mirror");
  });
  it("throws when empty", () => {
    expect(() => P.normalizeDownloadSources([])).toThrow("at-least-one-source-required");
  });
});

describe("file name / target path / defaults", () => {
  it("normalizeModelFileName rejects separators, null, non-gguf", () => {
    expect(P.normalizeModelFileName("model.gguf")).toBe("model.gguf");
    expect(() => P.normalizeModelFileName("a/b.gguf")).toThrow("path-separators-not-allowed");
    expect(() => P.normalizeModelFileName("model.bin")).toThrow("must-end-with-gguf");
    expect(() => P.normalizeModelFileName("bad\0.gguf")).toThrow("invalid");
  });
  it("validateModelTargetPath resolves + enforces .gguf", () => {
    expect(P.validateModelTargetPath("/tmp/x.gguf")).toBe(path.resolve("/tmp/x.gguf"));
    expect(() => P.validateModelTargetPath("/tmp/x.txt")).toThrow("must-end-with-gguf");
  });
  it("defaultModelPath nests under ~/.lynn/models", () => {
    expect(P.defaultModelPath("/home/u", "m.gguf")).toBe(path.join("/home/u", ".lynn", "models", "m.gguf"));
  });
  it("truthyEnv parses common truthy strings", () => {
    expect(P.truthyEnv("1")).toBe(true);
    expect(P.truthyEnv("TRUE")).toBe(true);
    expect(P.truthyEnv("no")).toBe(false);
    expect(P.truthyEnv("")).toBe(false);
  });
});
