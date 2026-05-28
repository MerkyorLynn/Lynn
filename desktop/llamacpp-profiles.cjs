/**
 * llama.cpp local model profiles.
 *
 * Main process IPC should own lifecycle and permissions; this module owns the
 * static model catalog, historical aliases, and launch-argument adaptation.
 */

const path = require("path");
const { DEFAULT_CONFIG: LLAMACPP_DEFAULT_CONFIG } = require("./llamacpp-manager.cjs");
const { DEFAULT_SOURCES: MODEL_DOWNLOADER_SOURCES } = require("./model-downloader.cjs");

const DEFAULT_MODEL_ID = "qwen35-9b-q4km-imatrix";

// Canonical key is always the GGUF model id. Historical local-* aliases map
// back to these entries for older client builds and stored configs.
const LLAMACPP_BASE_PROFILES = Object.freeze({
  // Low-config downgrade. 4B thinking-on can return empty visible answers after
  // long reasoning, so it remains explicit opt-in.
  "qwen35-4b-q4km": {
    modelId: "qwen35-4b-q4km",
    label: "Qwen3.5-4B Q4_K_M imatrix (Lynn downgrade)",
    fileName: "Qwen3.5-4B-Q4_K_M-imatrix.gguf",
    expectedSize: 2_783_446_976,
    expectedSha256: "7abaf02bbe25c608deb308db526766f761ad4fb85c512a69ff36520c4b304b23",
    parallelSegments: 2,
    autoStart: false,
    sources: [
      { id: "modelscope", label: "ModelScope (国内主源)", url: "https://modelscope.cn/models/Merkyor/Qwen3.5-4B-GGUF-imatrix/resolve/master/Qwen3.5-4B-Q4_K_M-imatrix.gguf" },
      { id: "hf-mirror", label: "hf-mirror.com (国内 HF 镜像)", url: "https://hf-mirror.com/nerkyor/Qwen3.5-4B-GGUF-imatrix/resolve/main/Qwen3.5-4B-Q4_K_M-imatrix.gguf" },
    ],
  },
  // Product default. 9B MTP is the stable thinking-on local path; the 2026-05-28
  // release uses the dedicated MTP repos and measured DGX Spark 36.61 → 60.95 single TPS.
  [DEFAULT_MODEL_ID]: {
    modelId: DEFAULT_MODEL_ID,
    label: "Qwen3.5-9B Q4_K_M imatrix MTP",
    fileName: "Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf",
    expectedSize: 5_780_090_944,
    expectedSha256: "0f292ba0d1058065a6624883a76a2adf00b266d07b9396ed67b155ff522e18d4",
    parallelSegments: 2,
    autoStart: true,
    sources: MODEL_DOWNLOADER_SOURCES,
  },
  // 35B APEX-MTP high-end tier. Old Q4_K_M ids remain aliases so existing UI
  // and saved configs keep working while new downloads use the faster MTP file.
  "qwen36-35b-a3b-apex-mtp": {
    modelId: "qwen36-35b-a3b-apex-mtp",
    label: "Qwen3.6-35B-A3B APEX-MTP I-Balanced",
    fileName: "Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf",
    expectedSize: 26_059_443_808,
    expectedSha256: "9bf7d96bb3a9d363e645dd998aee9e9bff8e016a82aec7ff081e0e6cdb53419e",
    parallelSegments: 4,
    autoStart: false,
    sources: [
      { id: "modelscope", label: "ModelScope (国内主源)", url: "https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-APEX-MTP-GGUF/resolve/master/Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf" },
      { id: "hf-mirror", label: "hf-mirror.com (国内 HF 镜像)", url: "https://hf-mirror.com/nerkyor/Qwen3.6-35B-A3B-APEX-MTP-GGUF/resolve/main/Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf" },
    ],
  },
});

const LLAMACPP_ALIAS_MAP = Object.freeze({
  "local-qwen35-4b-q4km": "qwen35-4b-q4km",
  "local-qwen35-9b-q4km-imatrix": DEFAULT_MODEL_ID,
  "qwen36-35b-a3b-q4km-imatrix": "qwen36-35b-a3b-apex-mtp",
});

const LLAMACPP_DOWNLOAD_PROFILES = Object.freeze({
  ...LLAMACPP_BASE_PROFILES,
  ...Object.fromEntries(
    Object.entries(LLAMACPP_ALIAS_MAP).map(([alias, canonical]) => [alias, LLAMACPP_BASE_PROFILES[canonical]]),
  ),
});

function canonicalizeLlamacppModelId(modelId) {
  const requested = typeof modelId === "string" && modelId.trim() ? modelId.trim() : DEFAULT_MODEL_ID;
  return LLAMACPP_ALIAS_MAP[requested] || requested;
}

function resolveLlamacppDownloadProfile(modelId) {
  const hasExplicitModelId = typeof modelId === "string" && modelId.trim().length > 0;
  const requestedModelId = hasExplicitModelId ? modelId.trim() : DEFAULT_MODEL_ID;
  const canonicalModelId = canonicalizeLlamacppModelId(requestedModelId);
  const profile = LLAMACPP_BASE_PROFILES[canonicalModelId] || null;
  return {
    requestedModelId,
    canonicalModelId: profile ? canonicalModelId : DEFAULT_MODEL_ID,
    known: !hasExplicitModelId || Boolean(profile),
    profile: profile || LLAMACPP_BASE_PROFILES[DEFAULT_MODEL_ID],
  };
}

function getLlamacppDownloadProfile(modelId) {
  return resolveLlamacppDownloadProfile(modelId).profile;
}

function safeIpcText(value, max = 500) {
  if (value == null) return null;
  return String(value).replace(/\0/g, "").slice(0, max);
}

function safeNonNegativeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function safeDownloadStateName(value) {
  const state = String(value || "idle");
  return ["idle", "downloading", "verifying", "done", "error", "paused"].includes(state) ? state : "idle";
}

function decorateDownloadState(profile, state = {}) {
  const percent = Math.max(0, Math.min(100, safeNonNegativeNumber(state.percent)));
  const parallelSegments = Number(state.parallelSegments || 0);
  const payload = {
    state: safeDownloadStateName(state.state),
    bytesTransferred: safeNonNegativeNumber(state.bytesTransferred),
    totalBytes: safeNonNegativeNumber(state.totalBytes),
    percent,
    activeSource: safeIpcText(state.activeSource, 120),
    target: safeIpcText(state.target, 1024),
    partPath: safeIpcText(state.partPath, 1024),
    parallelSegments: Number.isFinite(parallelSegments) && parallelSegments > 0
      ? Math.max(1, Math.min(8, Math.floor(parallelSegments)))
      : null,
    paused: Boolean(state.paused),
    lastError: safeIpcText(state.lastError, 500),
    modelId: safeIpcText(profile.modelId, 120),
    modelLabel: safeIpcText(profile.label, 160),
    fileName: safeIpcText(profile.fileName, 200),
  };
  if (state.reason != null) payload.reason = safeIpcText(state.reason, 200);
  if (state.sourceAttempt != null) payload.sourceAttempt = safeNonNegativeNumber(state.sourceAttempt);
  if (state.finalCheck != null) payload.finalCheck = Boolean(state.finalCheck);
  return payload;
}

function listLlamacppDownloadProfiles() {
  return Object.values(LLAMACPP_DOWNLOAD_PROFILES)
    .filter((profile, index, list) => list.findIndex((item) => item.modelId === profile.modelId) === index);
}

function replaceArgValue(args, flag, value) {
  const index = args.indexOf(flag);
  if (index >= 0 && index + 1 < args.length) {
    args[index + 1] = value;
  } else {
    args.push(flag, value);
  }
}

function removeArgsWithValues(args, flags) {
  const flagSet = new Set(flags);
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (flagSet.has(args[i])) {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function buildLlamacppArgsForAlias(modelAlias, modelPath = "") {
  let args = [...(LLAMACPP_DEFAULT_CONFIG.serverArgs || [])];
  const fileName = path.basename(String(modelPath || ""));
  const haystack = `${modelAlias} ${fileName}`;
  const is35bImatrix = /qwen36-35b-a3b-q4km-imatrix|35B-A3B-Q4_K_M-imatrix/i.test(haystack);
  const is35bApexMtp = /35B-A3B-APEX-MTP|qwen36-35b-a3b-apex-mtp/i.test(haystack);
  const is35b = is35bImatrix || is35bApexMtp;
  const is9bMtp = /9B.*(?:imatrix.*mtp|mtp)|qwen35-9b-q4km-imatrix/i.test(haystack);
  const launchAlias = is35bImatrix
    ? "qwen36-35b-a3b-q4km-imatrix"
    : is35bApexMtp
      ? "qwen36-35b-a3b-apex-mtp"
      : is9bMtp
        ? DEFAULT_MODEL_ID
        : modelAlias;
  replaceArgValue(args, "-a", launchAlias);
  if (is35bApexMtp || is9bMtp) {
    replaceArgValue(args, "--spec-type", "draft-mtp");
    replaceArgValue(args, "--spec-draft-n-max", "4");
  } else {
    args = removeArgsWithValues(args, ["--spec-type", "--spec-draft-n-max"]);
  }
  if (is35b || is9bMtp) {
    replaceArgValue(args, "--cache-type-k", "q8_0");
    replaceArgValue(args, "--cache-type-v", "q8_0");
  }
  return { alias: launchAlias, args };
}

module.exports = {
  DEFAULT_MODEL_ID,
  MODEL_DOWNLOADER_SOURCES,
  LLAMACPP_DOWNLOAD_PROFILES,
  canonicalizeLlamacppModelId,
  resolveLlamacppDownloadProfile,
  getLlamacppDownloadProfile,
  decorateDownloadState,
  listLlamacppDownloadProfiles,
  buildLlamacppArgsForAlias,
};
