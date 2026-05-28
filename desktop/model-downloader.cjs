/**
 * model-downloader.cjs · Lynn V0.79 onboarding 2026-05-21 / 2026-05-28 9B MTP release
 *
 * 跨平台大文件下载守护 — Qwen3.5-9B Q4_K_M imatrix MTP 5.78 GB / 5.38 GiB GGUF。
 *
 * 设计要点：
 *   1. HTTP/HTTPS Range 续传(用 .part 临时文件 + 已下载 byte offset);
 *      大模型可启用并发 Range 分片,服务器不支持时自动退回单路续传。
 *   2. 多源 fallback：ModelScope(国内默认) → hf-mirror.com(国内 HF 镜像备选)。
 *      任一源 4xx/5xx/timeout 自动 rotate 到下一个,**保留已下载字节**继续 range。
 *      不放腾讯镜像作为模型源 — 模型权重统一从公开发布镜像拉,腾讯只做客户端 dmg/exe。
 *   3. SHA-256 校验：streamed 增量算 hash,文件落地后比对 expected;
 *      不匹配 → 删 .part + 整源 fallback;全 fail → emit "checksum-failed"。
 *   4. EventEmitter:'progress'(每 250ms / 256 KiB) | 'state'(needs-source/downloading/verifying/done/error)
 *      | 'log'(level, msg)。Main 桥到 renderer。
 *   5. 暂停/继续:pause() 关 socket + 保留 .part;resume() 续传(用 If-Range / Range)。
 *   6. 不引入第三方下载库(axios/got/aria2),用 native http/https 满足 build size。
 *
 * 默认目标(可被 opts.target 覆盖):
 *   ~/.lynn/models/Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf
 *
 * 默认源(可被 opts.sources 覆盖,顺序 = 国内优先):
 *   - https://modelscope.cn/models/Merkyor/Qwen3.5-9B-GGUF-imatrix-MTP/resolve/master/Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf  (国内主源)
 *   - https://hf-mirror.com/nerkyor/Qwen3.5-9B-GGUF-imatrix-MTP/resolve/main/Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf          (国内 HF 镜像备)
 *
 * sha256: 0f292ba0d1058065a6624883a76a2adf00b266d07b9396ed67b155ff522e18d4
 * size:   5_780_090_944 bytes (期望,允许 ±0.5% 偏差,实际以 sha256 为准)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const { EventEmitter } = require("events");

// ─────────────────────────────────────────────────────────────
// 默认配置
// ─────────────────────────────────────────────────────────────

const DEFAULT_FILE_NAME = "Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf";
const DEFAULT_EXPECTED_SIZE = 5_780_090_944;
const DEFAULT_EXPECTED_SHA256 = "0f292ba0d1058065a6624883a76a2adf00b266d07b9396ed67b155ff522e18d4";

const DEFAULT_SOURCES = Object.freeze([
  {
    id: "modelscope",
    label: "ModelScope (国内主源)",
    url: "https://modelscope.cn/models/Merkyor/Qwen3.5-9B-GGUF-imatrix-MTP/resolve/master/Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf",
  },
  {
    id: "hf-mirror",
    label: "hf-mirror.com (国内 HF 镜像)",
    url: "https://hf-mirror.com/nerkyor/Qwen3.5-9B-GGUF-imatrix-MTP/resolve/main/Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf",
  },
]);

const PROGRESS_THROTTLE_MS = 250;
const PROGRESS_THROTTLE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const DEFAULT_PARALLEL_SEGMENTS = 1;
const INSECURE_MODEL_SOURCE_ENV = "LYNN_ALLOW_INSECURE_MODEL_SOURCE";

// ─────────────────────────────────────────────────────────────
// 下载安全边界
// ─────────────────────────────────────────────────────────────

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function allowInsecureModelSources() {
  return truthyEnv(process.env[INSECURE_MODEL_SOURCE_ENV]);
}

function stripIpv6Brackets(hostname) {
  const value = String(hostname || "").trim().toLowerCase();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function parseIpv4Literal(hostname) {
  const parts = String(hostname || "").trim().split(".");
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPrivateIpv4(octets) {
  if (!Array.isArray(octets) || octets.length !== 4) return false;
  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isLocalOrPrivateHost(hostname) {
  const host = stripIpv6Brackets(hostname).replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host === "ip6-localhost" || host === "ip6-loopback") {
    return true;
  }
  if (host.endsWith(".local")) return true;
  const ipv4 = parseIpv4Literal(host);
  if (ipv4) return isPrivateIpv4(ipv4);
  if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("fe80:")) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  const mappedIpv4 = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedIpv4) {
    const octets = parseIpv4Literal(mappedIpv4[1]);
    return isPrivateIpv4(octets);
  }
  return false;
}

// 2026-05-25 P0-2 (security): DNS rebinding defense for http(s).get.
// validateModelSourceUrl checks hostname string,但实际 TCP connect 的 DNS
// 在 https.get 内部解析。Attacker-controlled short-TTL DNS 可在第二次解析返
// 127.0.0.1,劫持下载流到本机 admin endpoint。给 http(s).get.lookup 选项
// 注入这个 lookup wrapper,resolve 后任何私网/loopback IP 立即 reject。
function _dnsLookupBlockingPrivate(hostname, optionsOrCallback, maybeCallback) {
  const dns = require("node:dns");
  let opts, callback;
  if (typeof optionsOrCallback === "function") {
    callback = optionsOrCallback;
    opts = {};
  } else {
    opts = optionsOrCallback || {};
    callback = maybeCallback;
  }
  // Opt-out for dev/testing against localhost — same env as validateModelSourceUrl
  if (allowInsecureModelSources()) {
    return dns.lookup(hostname, opts, callback);
  }
  dns.lookup(hostname, { all: true, family: opts.family || 0, hints: opts.hints }, (err, addresses) => {
    if (err) return callback(err);
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return callback(new Error(`model-source: DNS empty for ${hostname}`));
    }
    for (const addr of addresses) {
      if (isLocalOrPrivateHost(addr.address)) {
        const e = new Error(`model-source: DNS rebinding blocked — ${hostname} → ${addr.address} (private/loopback)`);
        e.code = "DNS_REBINDING_BLOCKED";
        return callback(e);
      }
    }
    if (opts.all) {
      return callback(null, addresses);
    }
    const first = addresses[0];
    callback(null, first.address, first.family);
  });
}

function validateModelSourceUrl(urlStr, opts = {}) {
  const context = opts.context || "model-source";
  const enforceGgufPath = opts.enforceGgufPath !== false;
  let url;
  try {
    url = new URL(String(urlStr || ""));
  } catch {
    throw new Error(`${context}: invalid-url`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${context}: unsupported-url-scheme`);
  }
  if (url.username || url.password) {
    throw new Error(`${context}: credentials-not-allowed`);
  }
  if (!allowInsecureModelSources() && isLocalOrPrivateHost(url.hostname)) {
    throw new Error(`${context}: local-or-private-host-not-allowed`);
  }
  if (enforceGgufPath) {
    let decodedPath = "";
    try {
      decodedPath = decodeURIComponent(url.pathname || "");
    } catch {
      throw new Error(`${context}: invalid-url-path`);
    }
    if (!decodedPath.toLowerCase().endsWith(".gguf")) {
      throw new Error(`${context}: source-must-end-with-gguf`);
    }
  }
  return url.toString();
}

function normalizeSourceId(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

function normalizeDownloadSources(sources, opts = {}) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("model-source: at-least-one-source-required");
  }
  const seen = new Map();
  return sources.map((entry, index) => {
    const raw = typeof entry === "string" ? { url: entry } : (entry || {});
    const url = validateModelSourceUrl(raw.url, {
      context: `model-source[${index}]`,
      enforceGgufPath: opts.enforceGgufPath !== false,
    });
    const parsed = new URL(url);
    const fallbackId = `source-${index + 1}`;
    const baseId = normalizeSourceId(raw.id || parsed.hostname, fallbackId);
    const duplicateCount = seen.get(baseId) || 0;
    seen.set(baseId, duplicateCount + 1);
    const id = duplicateCount > 0 ? `${baseId}-${duplicateCount + 1}` : baseId;
    const label = String(raw.label || id).trim().slice(0, 120) || id;
    return { id, label, url };
  });
}

function normalizeModelFileName(fileName) {
  const value = String(fileName || "").trim();
  if (!value || value.includes("\0")) throw new Error("model-file-name: invalid");
  if (path.basename(value) !== value) throw new Error("model-file-name: path-separators-not-allowed");
  if (path.extname(value).toLowerCase() !== ".gguf") throw new Error("model-file-name: must-end-with-gguf");
  return value;
}

function validateModelTargetPath(targetPath) {
  const raw = String(targetPath || "");
  if (!raw || raw.includes("\0")) throw new Error("model-target: invalid-path");
  const resolved = path.resolve(raw);
  if (path.extname(resolved).toLowerCase() !== ".gguf") {
    throw new Error("model-target: must-end-with-gguf");
  }
  return resolved;
}

// ─────────────────────────────────────────────────────────────
// 路径工具
// ─────────────────────────────────────────────────────────────

function defaultLynnRoot(homeDir) {
  return path.join(homeDir, ".lynn");
}

function defaultModelPath(homeDir, fileName) {
  return path.join(defaultLynnRoot(homeDir), "models", fileName);
}

function ensureDirSync(dirPath) {
  try { fs.mkdirSync(dirPath, { recursive: true }); } catch (err) {
    if (err && err.code !== "EEXIST") throw err;
  }
}

function safeStatSize(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : 0;
  } catch { return 0; }
}

// ─────────────────────────────────────────────────────────────
// ModelDownloader
// ─────────────────────────────────────────────────────────────

class ModelDownloader extends EventEmitter {
  constructor(opts = {}) {
    super();
    const homeDir = opts.homeDir || os.homedir();
    const fileName = normalizeModelFileName(opts.fileName || DEFAULT_FILE_NAME);
    this.target = validateModelTargetPath(opts.target || defaultModelPath(homeDir, fileName));
    this.partPath = `${this.target}.part`;
    this.expectedSize = opts.expectedSize || DEFAULT_EXPECTED_SIZE;
    this.expectedSha256 = (opts.expectedSha256 || DEFAULT_EXPECTED_SHA256 || "").toLowerCase();
    const requestedSegments = Number(opts.parallelSegments || DEFAULT_PARALLEL_SEGMENTS);
    this.parallelSegments = Number.isFinite(requestedSegments)
      ? Math.max(1, Math.min(8, Math.floor(requestedSegments)))
      : DEFAULT_PARALLEL_SEGMENTS;
    this.sources = normalizeDownloadSources(
      Array.isArray(opts.sources) && opts.sources.length > 0 ? opts.sources : DEFAULT_SOURCES,
    );

    // runtime state
    this.activeRequest = null;
    this.activeStream = null;
    this.parallelRequests = [];
    this.parallelStreams = [];
    this.parallelSegmentPaths = [];
    this.activeHash = null;
    this.activeSourceIndex = -1;
    this.bytesTransferred = 0;
    this.totalBytes = 0;
    this.state = "idle"; // idle | downloading | verifying | done | error | paused
    this.paused = false;
    this.aborted = false;
    this.lastEmitTs = 0;
    this.lastEmitBytes = 0;
    this.startedAt = 0;
    this.lastError = null;
    this.activeSourceLabel = null;
    this.attemptedSources = new Set();
  }

  // ── public API ──

  /** Start (or resume) download. Resolves when verified file is at target. */
  start() {
    if (this.state === "downloading" || this.state === "verifying") {
      return Promise.resolve({ ok: false, reason: "already-running" });
    }
    this.aborted = false;
    this.paused = false;
    this.lastError = null;
    this.attemptedSources.clear();
    return new Promise((resolve) => {
      this._finishResolve = resolve;
      try {
        // If target already exists & matches sha256, short-circuit.
        if (fs.existsSync(this.target)) {
          this._setState("verifying", { sourceLabel: null, finalCheck: true });
          this._verifyExistingTarget()
            .then((ok) => {
              if (ok) {
                this._setState("done", { sourceLabel: null });
                this._finish({ ok: true });
              } else {
                // remove stale + restart
                try { fs.rmSync(this.target, { force: true }); } catch {}
                this._beginNextSource();
              }
            })
            .catch((err) => this._fail(`existing-verify-error: ${err?.message || err}`));
          return;
        }
        this._beginNextSource();
      } catch (err) {
        this._fail(`start-error: ${err?.message || err}`);
      }
    });
  }

  /** Cancel + leave .part on disk for later resume. */
  pause() {
    if (this.state !== "downloading") return;
    this.paused = true;
    this._setState("paused");
    this._teardownActive();
  }

  /** Cancel + delete .part. */
  cancel() {
    this.aborted = true;
    this.paused = false;
    this._teardownActive();
    try { fs.rmSync(this.partPath, { force: true }); } catch {}
    this._setState("idle");
    if (this._finishResolve) {
      this._finishResolve({ ok: false, reason: "cancelled" });
      this._finishResolve = null;
    }
  }

  /** Snapshot of current progress. Safe to call any time. */
  getState() {
    return {
      state: this.state,
      bytesTransferred: this.bytesTransferred,
      totalBytes: this.totalBytes,
      percent: this.totalBytes > 0
        ? Math.min(100, Math.floor((this.bytesTransferred / this.totalBytes) * 100))
        : 0,
      activeSource: this.activeSourceLabel,
      target: this.target,
      partPath: this.partPath,
      parallelSegments: this.parallelSegments,
      paused: this.paused,
      lastError: this.lastError,
    };
  }

  // ── source rotation ──

  _beginNextSource() {
    if (this.aborted) return;
    // #4: per-source retry budget — each source can be tried up to PER_SOURCE_RETRIES times
    // before being marked exhausted. Survives a single transient mirror outage during
    // a 5+GB download instead of declaring "all-sources-failed" after one round.
    const PER_SOURCE_RETRIES = Number(process.env.LYNN_DOWNLOAD_SOURCE_RETRIES || 3);
    if (!this._sourceAttemptCounts) this._sourceAttemptCounts = new Map();
    const exhausted = (s) => (this._sourceAttemptCounts.get(s.id) || 0) >= PER_SOURCE_RETRIES;

    // Find next non-exhausted source, prefer rotation order.
    let chosen = -1;
    for (let offset = 1; offset <= this.sources.length; offset++) {
      const idx = (this.activeSourceIndex + offset) % this.sources.length;
      if (!exhausted(this.sources[idx])) { chosen = idx; break; }
    }
    if (chosen === -1) {
      // All sources exhausted across all retries.
      this._fail("all-sources-failed");
      return;
    }
    this.activeSourceIndex = chosen;
    const src = this.sources[this.activeSourceIndex];
    const attempt = (this._sourceAttemptCounts.get(src.id) || 0) + 1;
    this._sourceAttemptCounts.set(src.id, attempt);
    this.attemptedSources.add(src.id); // legacy field kept for backward compat (status reporting)
    this.activeSourceLabel = src.label;
    this._log("info", `[download] starting source=${src.label} (attempt ${attempt}/${PER_SOURCE_RETRIES}) url=${src.url}`);
    this._setState("downloading", { sourceLabel: src.label, sourceAttempt: attempt });
    const canTryParallel = this.parallelSegments > 1
      && this.expectedSize > 0
      && safeStatSize(this.partPath) === 0;
    const task = canTryParallel
      ? this._downloadFromSourceParallel(src.url, 0)
      : this._downloadFromSource(src.url, 0);
    task.catch((err) => {
      if (this.aborted || this.paused) return;
      this._log("warn", `[download] source ${src.label} attempt ${attempt} failed: ${err?.message || err}`);
      this._teardownActive();
      // Brief jitter before next attempt to avoid thundering retry
      const jitterMs = 500 + Math.floor(Math.random() * 1500);
      setTimeout(() => this._beginNextSource(), jitterMs);
    });
  }

  async _downloadFromSourceParallel(urlStr, redirectsLeft) {
    if (this.aborted || this.paused) return;
    ensureDirSync(path.dirname(this.target));
    this.bytesTransferred = 0;
    this.totalBytes = this.expectedSize;
    this.activeHash = null;
    this._emitProgress(true);

    const segments = [];
    const segmentSize = Math.ceil(this.expectedSize / this.parallelSegments);
    for (let i = 0; i < this.parallelSegments; i += 1) {
      const start = i * segmentSize;
      const end = Math.min(this.expectedSize - 1, start + segmentSize - 1);
      if (start <= end) {
      segments.push({
          index: i,
          start,
          end,
          path: `${this.partPath}.seg${i}`,
        });
      }
    }
    for (const seg of segments) {
      try { fs.rmSync(seg.path, { force: true }); } catch {}
    }
    this.parallelSegmentPaths = segments.map((seg) => seg.path);

    try {
      await Promise.all(segments.map((seg) => this._downloadRangeSegment(urlStr, seg, redirectsLeft)));
    } catch (err) {
      if (this.aborted || this.paused) return;
      this._teardownActive();
      for (const seg of segments) {
        try { fs.rmSync(seg.path, { force: true }); } catch {}
      }
      this.parallelSegmentPaths = [];
      if (/range-not-supported|http 200/.test(String(err?.message || err))) {
        this._log("warn", "[download] parallel range unavailable — falling back to single connection");
        return this._downloadFromSource(urlStr, redirectsLeft);
      }
      throw err;
    }
    if (this.aborted || this.paused) return;

    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(this.partPath, { flags: "w" });
      out.on("error", reject);
      out.on("finish", resolve);
      let chain = Promise.resolve();
      for (const seg of segments) {
        chain = chain.then(() => new Promise((segResolve, segReject) => {
          const input = fs.createReadStream(seg.path);
          input.on("error", segReject);
          input.on("end", segResolve);
          input.pipe(out, { end: false });
        }));
      }
      chain.then(() => out.end(), (err) => {
        try { out.destroy(); } catch {}
        reject(err);
      });
    });
    for (const seg of segments) {
      try { fs.rmSync(seg.path, { force: true }); } catch {}
    }
    this.parallelSegmentPaths = [];

    const ok = await this._finalizeDownload();
    if (ok === "verified") {
      this._setState("done", { sourceLabel: this.activeSourceLabel });
      this._finish({ ok: true });
      return;
    }
    if (ok === "checksum-failed") {
    try { fs.rmSync(this.partPath, { force: true }); } catch {}
    this._cleanupParallelSegments();
      this.bytesTransferred = 0;
      throw new Error("checksum-failed");
    }
    throw new Error(String(ok));
  }

  _downloadRangeSegment(urlStr, segment, redirectsLeft) {
    if (this.aborted || this.paused) return Promise.resolve();
    const url = new URL(validateModelSourceUrl(urlStr, {
      context: "model-source-redirect",
      enforceGgufPath: false,
    }));
    const lib = url.protocol === "http:" ? http : https;
    const headers = {
      "User-Agent": "Lynn-Desktop/0.79 (model-downloader)",
      "Range": `bytes=${segment.start}-${segment.end}`,
    };
    const req = lib.get({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "http:" ? 80 : 443),
      path: url.pathname + url.search,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
      lookup: _dnsLookupBlockingPrivate,  // 2026-05-25 P0-2: DNS rebinding defense
    });
    this.parallelRequests.push(req);

    return new Promise((resolve, reject) => {
      req.on("response", (res) => {
        if (this.aborted || this.paused) {
          try { res.destroy(); } catch {}
          resolve();
          return;
        }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft >= MAX_REDIRECTS) {
            try { res.destroy(); } catch {}
            reject(new Error("too-many-redirects"));
            return;
          }
          try { res.destroy(); } catch {}
          const next = validateModelSourceUrl(new URL(res.headers.location, url).toString(), {
            context: "model-source-redirect",
            enforceGgufPath: false,
          });
          this._downloadRangeSegment(next, segment, redirectsLeft + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode === 200) {
          try { res.destroy(); } catch {}
          reject(new Error("range-not-supported"));
          return;
        }
        if (res.statusCode !== 206) {
          try { res.destroy(); } catch {}
          reject(new Error(`http ${res.statusCode}`));
          return;
        }
        const totalMatch = String(res.headers["content-range"] || "").match(/\/(\d+)$/);
        const reportedTotal = totalMatch ? Number(totalMatch[1]) : 0;
        if (Number.isFinite(reportedTotal) && reportedTotal > 0) {
          this.totalBytes = reportedTotal;
        }
        const fileStream = fs.createWriteStream(segment.path, { flags: "w" });
        this.parallelStreams.push(fileStream);
        let segmentBytes = 0;
        res.on("data", (chunk) => {
          if (this.aborted || this.paused) {
            try { res.destroy(); } catch {}
            return;
          }
          segmentBytes += chunk.length;
          this.bytesTransferred += chunk.length;
          this._emitProgress(false);
        });
        res.on("error", (err) => {
          try { fileStream.destroy(); } catch {}
          reject(err);
        });
        fileStream.on("error", reject);
        fileStream.on("finish", () => {
          const expected = segment.end - segment.start + 1;
          if (!this.aborted && !this.paused && segmentBytes !== expected) {
            reject(new Error(`segment-incomplete-${segment.index}`));
            return;
          }
          resolve();
        });
        res.pipe(fileStream);
      });
      req.on("error", reject);
      req.on("timeout", () => {
        try { req.destroy(); } catch {}
        reject(new Error("request-timeout"));
      });
    });
  }

  async _downloadFromSource(urlStr, redirectsLeft) {
    if (this.aborted || this.paused) return;
    ensureDirSync(path.dirname(this.target));
    const existingPartSize = safeStatSize(this.partPath);
    this.bytesTransferred = existingPartSize;
    // Hash must include the bytes already on disk if any.
    this.activeHash = crypto.createHash("sha256");
    if (existingPartSize > 0) {
      try {
        await this._rehashExisting();
      } catch (err) {
        // hash setup failed — restart .part
        this._log("warn", `[download] rehash failed, restarting: ${err?.message || err}`);
        try { fs.rmSync(this.partPath, { force: true }); } catch {}
        this.bytesTransferred = 0;
        this.activeHash = crypto.createHash("sha256");
      }
    }

    const url = new URL(validateModelSourceUrl(urlStr, {
      context: "model-source-redirect",
      enforceGgufPath: false,
    }));
    const lib = url.protocol === "http:" ? http : https;
    const headers = { "User-Agent": "Lynn-Desktop/0.79 (model-downloader)" };
    if (this.bytesTransferred > 0) {
      headers["Range"] = `bytes=${this.bytesTransferred}-`;
    }

    const req = lib.get({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "http:" ? 80 : 443),
      path: url.pathname + url.search,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
      lookup: _dnsLookupBlockingPrivate,  // 2026-05-25 P0-2: DNS rebinding defense
    });
    this.activeRequest = req;

    return new Promise((resolve, reject) => {
      req.on("response", (res) => {
        if (this.aborted) {
          try { res.destroy(); } catch {}
          return resolve();
        }
        // Redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft >= MAX_REDIRECTS) {
            try { res.destroy(); } catch {}
            return reject(new Error("too-many-redirects"));
          }
          try { res.destroy(); } catch {}
          const next = validateModelSourceUrl(new URL(res.headers.location, url).toString(), {
            context: "model-source-redirect",
            enforceGgufPath: false,
          });
          this._log("info", `[download] redirect → ${next}`);
          this._downloadFromSource(next, redirectsLeft + 1).then(resolve, reject);
          return;
        }
        // Range mismatch -> server doesn't support resume, restart .part
        if (this.bytesTransferred > 0 && res.statusCode === 200) {
          // server ignored range, restart from scratch
          this._log("warn", "[download] server returned 200 (no range support) — restarting .part");
          try { fs.rmSync(this.partPath, { force: true }); } catch {}
          this.bytesTransferred = 0;
          this.activeHash = crypto.createHash("sha256");
        } else if (res.statusCode !== 200 && res.statusCode !== 206) {
          try { res.destroy(); } catch {}
          return reject(new Error(`http ${res.statusCode}`));
        }

        const contentLength = parseInt(res.headers["content-length"] || "0", 10) || 0;
        if (res.statusCode === 206) {
          // partial: total = transferred + content-length
          this.totalBytes = this.bytesTransferred + contentLength;
        } else if (contentLength > 0) {
          this.totalBytes = contentLength;
        } else if (this.expectedSize > 0 && this.totalBytes === 0) {
          this.totalBytes = this.expectedSize;
        }
        this._emitProgress(true);

        const fileStream = fs.createWriteStream(this.partPath, {
          flags: this.bytesTransferred > 0 ? "a" : "w",
        });
        this.activeStream = fileStream;

        res.on("data", (chunk) => {
          if (this.aborted || this.paused) {
            try { res.destroy(); } catch {}
            return;
          }
          this.activeHash.update(chunk);
          this.bytesTransferred += chunk.length;
          this._emitProgress(false);
        });

        res.on("error", (err) => {
          try { fileStream.destroy(); } catch {}
          reject(err);
        });
        res.on("end", () => {
          try { fileStream.end(); } catch {}
        });
        res.pipe(fileStream);

        fileStream.on("finish", () => {
          if (this.aborted) return resolve();
          if (this.paused) return resolve();
          // All bytes received from this response. Check if more pending (Range continuation handled by server in single response).
          this._finalizeDownload().then((ok) => {
            if (ok === "verified") {
              this._setState("done", { sourceLabel: this.activeSourceLabel });
              this._finish({ ok: true });
              resolve();
            } else if (ok === "incomplete") {
              // size mismatch but no error — treat as failed source.
              reject(new Error("incomplete-response"));
            } else if (ok === "checksum-failed") {
              // sha mismatch -> source fail; nuke .part for next try.
              try { fs.rmSync(this.partPath, { force: true }); } catch {}
              this.bytesTransferred = 0;
              reject(new Error("checksum-failed"));
            } else {
              reject(new Error(String(ok)));
            }
          }, reject);
        });
        fileStream.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => {
        try { req.destroy(); } catch {}
        reject(new Error("request-timeout"));
      });
    });
  }

  async _rehashExisting() {
    return new Promise((resolve, reject) => {
      const rs = fs.createReadStream(this.partPath);
      rs.on("data", (chunk) => this.activeHash.update(chunk));
      rs.on("error", reject);
      rs.on("end", resolve);
    });
  }

  async _finalizeDownload() {
    const size = safeStatSize(this.partPath);
    if (this.expectedSize > 0) {
      const tolerance = Math.max(1024 * 1024, Math.floor(this.expectedSize * 0.005));
      if (Math.abs(size - this.expectedSize) > tolerance) {
        if (size < this.expectedSize - tolerance) {
          // Likely connection dropped early — return incomplete so we can rotate sources / resume.
          this._log("warn", `[download] size short: got=${size} expected≈${this.expectedSize}`);
          return "incomplete";
        }
      }
    }
    this._setState("verifying", { sourceLabel: this.activeSourceLabel });
    if (this.expectedSha256) {
      const digest = this.activeHash
        ? this.activeHash.digest("hex")
        : await this._hashFile(this.partPath);
      if (digest.toLowerCase() !== this.expectedSha256) {
        this._log("error", `[download] sha256 mismatch got=${digest} expected=${this.expectedSha256}`);
        return "checksum-failed";
      }
    } else if (this.activeHash) {
      this.activeHash.digest("hex");
    }
    // atomic rename .part → target
    try {
      fs.renameSync(this.partPath, this.target);
    } catch (err) {
      // cross-device fallback
      try {
        fs.copyFileSync(this.partPath, this.target);
        fs.rmSync(this.partPath, { force: true });
      } catch (err2) {
        this._log("error", `[download] rename failed: ${err?.message || err} / ${err2?.message || err2}`);
        return "rename-failed";
      }
    }
    this._log("info", `[download] verified + finalized → ${this.target}`);
    return "verified";
  }

  async _verifyExistingTarget() {
    const size = safeStatSize(this.target);
    if (this.expectedSize > 0) {
      const tolerance = Math.max(1024 * 1024, Math.floor(this.expectedSize * 0.005));
      if (Math.abs(size - this.expectedSize) > tolerance) return false;
    }
    if (!this.expectedSha256) return true;
    const digest = await new Promise((resolve, reject) => {
      this._hashFile(this.target).then(resolve, reject);
    });
    return digest.toLowerCase() === this.expectedSha256;
  }

  _hashFile(filePath) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash("sha256");
      const rs = fs.createReadStream(filePath);
      rs.on("data", (chunk) => h.update(chunk));
      rs.on("error", reject);
      rs.on("end", () => resolve(h.digest("hex")));
    });
  }

  // ── internal helpers ──

  _setState(state, patch = {}) {
    this.state = state;
    if (state === "downloading" && !this.startedAt) this.startedAt = Date.now();
    const payload = { state, ...this.getState(), ...patch };
    try { this.emit("state", payload); } catch {}
  }

  _emitProgress(force) {
    const now = Date.now();
    if (!force) {
      if (now - this.lastEmitTs < PROGRESS_THROTTLE_MS
          && this.bytesTransferred - this.lastEmitBytes < PROGRESS_THROTTLE_BYTES) {
        return;
      }
    }
    this.lastEmitTs = now;
    this.lastEmitBytes = this.bytesTransferred;
    try { this.emit("progress", this.getState()); } catch {}
  }

  _log(level, msg) {
    try { this.emit("log", level, msg); } catch {}
  }

  _teardownActive() {
    if (this.activeRequest) {
      try { this.activeRequest.destroy(); } catch {}
      this.activeRequest = null;
    }
    if (this.activeStream) {
      try { this.activeStream.destroy(); } catch {}
      this.activeStream = null;
    }
    for (const req of this.parallelRequests) {
      try { req.destroy(); } catch {}
    }
    for (const stream of this.parallelStreams) {
      try { stream.destroy(); } catch {}
    }
    this.parallelRequests = [];
    this.parallelStreams = [];
    if (this.aborted) this._cleanupParallelSegments();
  }

  _cleanupParallelSegments() {
    for (const segPath of this.parallelSegmentPaths || []) {
      try { fs.rmSync(segPath, { force: true }); } catch {}
    }
    this.parallelSegmentPaths = [];
  }

  _fail(reason) {
    this.lastError = String(reason || "unknown-error");
    this._setState("error", { reason: this.lastError });
    this._teardownActive();
    this._finish({ ok: false, reason: this.lastError });
  }

  _finish(result) {
    if (this._finishResolve) {
      this._finishResolve(result);
      this._finishResolve = null;
    }
  }
}

module.exports = {
  ModelDownloader,
  defaultModelPath,
  defaultLynnRoot,
  DEFAULT_FILE_NAME,
  DEFAULT_EXPECTED_SIZE,
  DEFAULT_EXPECTED_SHA256,
  DEFAULT_SOURCES,
  INSECURE_MODEL_SOURCE_ENV,
  allowInsecureModelSources,
  validateModelSourceUrl,
  normalizeDownloadSources,
  normalizeModelFileName,
  validateModelTargetPath,
};
