import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { signUpdateManifest, verifyUpdateManifest } = require("../shared/update-manifest-signature.cjs");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const identity = { keyId: "ephemeral-test-identity", publicKey };
const manifest = { stable: { version: "0.87.5", assets: { default: "https://download.merkyorlynn.com/download.html" }, notes: "release" } };
describe("signed update manifests", () => {
  it("verifies the release and remains independent of JSON property order", () => {
    const signed = signUpdateManifest(manifest, privateKey, identity);
    expect(verifyUpdateManifest(signed, identity)).toBe(true);
    expect(verifyUpdateManifest({ signature: signed.signature, stable: { notes: signed.stable.notes, assets: signed.stable.assets, version: signed.stable.version } }, identity)).toBe(true);
  });
  it.each(["version", "url", "notes", "signature"])("rejects a changed %s", field => {
    const signed = signUpdateManifest(structuredClone(manifest), privateKey, identity);
    if (field === "version") signed.stable.version = "999.0.0";
    if (field === "url") signed.stable.assets.default = "file:///tmp/evil";
    if (field === "notes") signed.stable.notes = "changed";
    if (field === "signature") signed.signature.value = Buffer.alloc(64).toString("base64");
    expect(verifyUpdateManifest(signed, identity)).toBe(false);
  });
  it("rejects unsigned manifests and signatures from another identity", () => {
    expect(verifyUpdateManifest(manifest, identity)).toBe(false);
    expect(verifyUpdateManifest(signUpdateManifest(manifest, privateKey, identity))).toBe(false);
  });
});
