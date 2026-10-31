"use strict";
const crypto = require("node:crypto");
const { keyId, publicKey } = require("./update-signing-public.cjs");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function manifestPayload(manifest) {
  const { signature: _signature, ...payload } = manifest;
  return Buffer.from(JSON.stringify(canonical(payload)));
}
function signUpdateManifest(manifest, privateKey, identity = { keyId, publicKey }) {
  const signature = crypto.sign(null, manifestPayload(manifest), privateKey).toString("base64");
  const signed = { ...manifest, signature: { algorithm: "Ed25519", keyId: identity.keyId, value: signature } };
  if (!verifyUpdateManifest(signed, identity)) throw new Error("Release identity does not match the bundled verifier");
  return signed;
}
function verifyUpdateManifest(manifest, identity = { keyId, publicKey }) {
  try {
    const signature = manifest?.signature;
    if (signature?.algorithm !== "Ed25519" || signature.keyId !== identity.keyId || typeof signature.value !== "string") return false;
    const bytes = Buffer.from(signature.value, "base64");
    return bytes.length === 64 && crypto.verify(null, manifestPayload(manifest), identity.publicKey, bytes);
  } catch { return false; }
}
module.exports = { manifestPayload, signUpdateManifest, verifyUpdateManifest };
