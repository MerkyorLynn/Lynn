#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import YAML from "js-yaml";
import WebSocket from "ws";
import { isExpectedVisionColorAnswer, selectInstalledVisionModel } from "./installed-vision-selection.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_APP = "/Applications/Lynn.app";
const appArgIndex = process.argv.indexOf("--app");
const APP_PATH = path.resolve(appArgIndex >= 0 ? process.argv[appArgIndex + 1] : DEFAULT_APP);
let serverInfoPath = path.join(os.homedir(), ".lynn", "server-info.json");
const REVIEW_TIMEOUT_MS = Number(process.env.LYNN_INSTALLED_GATE_REVIEW_TIMEOUT_MS || "240000");
const ONLY_LIVE_VISION = process.argv.includes("--only-live-vision");
const ONLY_REVIEW_CONCURRENCY = process.argv.includes("--only-review-concurrency");
const CONNECT_EXISTING = process.argv.includes("--connect-existing");
const VISION_MODEL_ID = String(process.env.LYNN_INSTALLED_GATE_VISION_MODEL || "").trim();
const VISION_PROVIDER = String(process.env.LYNN_INSTALLED_GATE_VISION_PROVIDER || "").trim().toLowerCase();
const VISION_API_KEY = String(process.env.LYNN_INSTALLED_GATE_VISION_KEY || "").trim();
const VISION_BASE_URL = String(process.env.LYNN_INSTALLED_GATE_VISION_BASE_URL || "").trim();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with code=${code} signal=${signal || ""}`));
    });
  });
}

function capture(command, args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr || error.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

async function listInstalledAppPids() {
  const pattern = path.join(APP_PATH, "Contents");
  const result = await capture("pgrep", ["-f", pattern], { timeoutMs: 3000 });
  return result.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

async function waitForInstalledAppExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let pids = [];
  while (Date.now() < deadline) {
    pids = await listInstalledAppPids();
    if (pids.length === 0) return [];
    await wait(250);
  }
  return pids;
}

async function signalInstalledAppPids(signal) {
  const pids = await listInstalledAppPids();
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
  return pids;
}

async function stopInstalledAppProcesses(reason, { initialWaitMs = 0, throwOnFailure = true } = {}) {
  let pids = initialWaitMs > 0
    ? await waitForInstalledAppExit(initialWaitMs)
    : await listInstalledAppPids();
  if (pids.length === 0) return;

  console.warn(`[installed-gate] Lynn still running during ${reason}; terminating pids=${pids.join(",")}`);
  await signalInstalledAppPids("SIGTERM");
  pids = await waitForInstalledAppExit(5000);
  if (pids.length === 0) return;

  console.warn(`[installed-gate] Lynn still running after SIGTERM during ${reason}; killing pids=${pids.join(",")}`);
  await signalInstalledAppPids("SIGKILL");
  pids = await waitForInstalledAppExit(3000);
  if (!pids.length) return;

  const message = `[installed-gate] failed to stop installed Lynn pids=${pids.join(",")}`;
  if (throwOnFailure) throw new Error(message);
  console.warn(message);
}

async function quitExistingLynn() {
  // A candidate app gate must never quit the user's separate installed app.
  if (APP_PATH !== DEFAULT_APP) {
    await stopInstalledAppProcesses("candidate cleanup", { throwOnFailure: true });
    return;
  }
  await new Promise((resolve) => {
    const child = spawn("osascript", ["-e", 'tell application "Lynn" to quit'], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("exit", resolve);
    child.on("error", resolve);
  });
  await stopInstalledAppProcesses("quit request", { initialWaitMs: 4000, throwOnFailure: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readServerInfo(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(serverInfoPath, "utf8");
      const info = JSON.parse(raw);
      if (Number.isFinite(Number(info.port)) && info.token) return info;
      last = raw;
    } catch (error) {
      last = error?.message || String(error);
    }
    await wait(500);
  }
  throw new Error(`[installed-gate] timed out waiting for ${serverInfoPath}; last=${String(last || "")}`);
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function writeYaml(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, YAML.dump(data, { lineWidth: -1, noRefs: true }), "utf8");
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve();
    }, 8000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill("SIGTERM"); } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function tail(text, lines = 60) {
  return String(text || "").split(/\n/).filter(Boolean).slice(-lines).join("\n");
}

async function prepareGateHome() {
  if (VISION_API_KEY && (!VISION_MODEL_ID || !VISION_PROVIDER || !VISION_BASE_URL)) {
    throw new Error("[installed-gate] an explicit vision key requires explicit model, provider and base URL");
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-installed-gate-"));
  const lynnHome = path.join(tmp, ".lynn");
  await writeJson(path.join(lynnHome, "user", "preferences.json"), {
    setupComplete: true,
    locale: "zh-CN",
  });
  if (VISION_API_KEY) {
    await writeYaml(path.join(lynnHome, "added-models.yaml"), {
      _migrated: true,
      providers: {
        [VISION_PROVIDER]: {
          api_key: VISION_API_KEY,
          base_url: VISION_BASE_URL,
          api: "openai-completions",
          models: [{ id: VISION_MODEL_ID, name: VISION_MODEL_ID, vision: true }],
        },
      },
    });
  }
  return { tmp, lynnHome };
}

async function launchAppDirect(appBin, env) {
  const logs = { value: "" };
  const child = spawn(appBin, [], {
    cwd: path.dirname(appBin),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs.value += String(chunk); });
  child.stderr.on("data", (chunk) => { logs.value += String(chunk); });
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      console.warn(`[installed-gate] app exited code=${code} signal=${signal || ""}\n${tail(logs.value)}`);
    }
  });
  return { child, logs };
}

async function httpJson(baseUrl, token, pathname, { method = "GET", body, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      throw new Error(`[installed-gate] ${method} ${pathname} -> ${res.status}: ${text}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHttpJson(baseUrl, token, pathname, {
  method = "GET",
  body,
  timeoutMs = 45000,
  requestTimeoutMs = 8000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await httpJson(baseUrl, token, pathname, {
        method,
        body,
        timeoutMs: requestTimeoutMs,
      });
    } catch (error) {
      lastError = error;
      await wait(500);
    }
  }
  throw new Error(`[installed-gate] timed out waiting for ${method} ${pathname}: ${lastError?.message || lastError || "unknown error"}`);
}

function openWs(wsUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, [`token.${token}`]);
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {}
      reject(new Error("[installed-gate] WebSocket open timeout"));
    }, 12000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makeSolidColorPngBase64({ width = 64, height = 64, rgba = [231, 41, 41, 255] } = {}) {
  const rowSize = 1 + width * 4;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const offset = rowStart + 1 + x * 4;
      raw[offset] = rgba[0];
      raw[offset + 1] = rgba[1];
      raw[offset + 2] = rgba[2];
      raw[offset + 3] = rgba[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND"),
  ]).toString("base64");
}

async function waitForPromptTurn(ws, payload, timeoutMs = 120000) {
  return await new Promise((resolve, reject) => {
    let text = "";
    const errors = [];
    const providerRoutes = [];
    const started = Date.now();
    let sawTurnEnd = false;
    let endTimer = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`[installed-gate] live vision prompt timed out after ${timeoutMs}ms; text=${text.slice(0, 200)} errors=${errors.join("; ")}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (endTimer) clearTimeout(endTimer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const finishSoon = () => {
      if (endTimer) clearTimeout(endTimer);
      endTimer = setTimeout(() => {
        cleanup();
        resolve({ text, errors, providerRoutes, elapsedMs: Date.now() - started });
      }, 500);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("[installed-gate] WebSocket closed during live vision prompt"));
    };
    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "text_delta") {
        text += msg.delta || "";
      } else if (msg.type === "provider_meta") {
        providerRoutes.push({ activeProvider: msg.activeProvider, fallbackFrom: msg.fallbackFrom || [] });
      } else if (msg.type === "error") {
        errors.push(msg.message || JSON.stringify(msg));
      } else if (msg.type === "turn_end") {
        sawTurnEnd = true;
        finishSoon();
      } else if (sawTurnEnd && msg.type === "status" && msg.isStreaming === false) {
        finishSoon();
      }
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
    ws.send(JSON.stringify(payload));
  });
}

async function runLiveVisionGate(baseUrl, wsUrl, token) {
  const modelsPayload = await httpJson(baseUrl, token, "/api/models", { timeoutMs: 20000 });
  const selected = selectInstalledVisionModel(modelsPayload, { modelId: VISION_MODEL_ID, provider: VISION_PROVIDER });

  const previous = Array.isArray(modelsPayload?.models)
    ? modelsPayload.models.find((model) => model?.isCurrent)
    : null;
  const sameModel = previous?.id === selected.id && previous?.provider === selected.provider;
  console.log(`[installed-gate] live vision model=${selected.provider}/${selected.id}`);

  try {
    if (!sameModel) {
      await httpJson(baseUrl, token, "/api/models/set", {
        method: "POST",
        body: { modelId: selected.id, provider: selected.provider },
        timeoutMs: 20000,
      });
      await wait(1000);
    }
    const cases = [
      { id: "red-64", rgba: [231, 41, 41, 255], size: 64, expected: ["红", "红色", "red"] },
      { id: "blue-512", rgba: [20, 40, 230, 255], size: 512, expected: ["蓝", "蓝色", "blue"] },
      { id: "green-64", rgba: [25, 210, 45, 255], size: 64, expected: ["绿", "绿色", "green"] },
      { id: "no-image", size: 0, expected: null },
    ];
    for (const test of cases) {
      const session = await httpJson(baseUrl, token, "/api/sessions/new", {
        method: "POST",
        body: { cwd: ROOT, memoryEnabled: false },
        timeoutMs: 15000,
      });
      if (typeof session?.path !== "string" || !session.path) {
        throw new Error("[installed-gate] fresh vision test session was not created");
      }
      const sessionPath = session.path;
      const ws = await openWs(wsUrl, token);
      try {
        const result = await waitForPromptTurn(ws, {
          type: "prompt",
          text: "请看这张图片，直接回答图片主体颜色。只回答颜色名，不要解释。",
          sessionPath,
          clientMessageId: `installed-live-vision-${test.id}-${Date.now()}`,
          ...(test.size ? { images: [{
            mimeType: "image/png",
            data: makeSolidColorPngBase64({ width: test.size, height: test.size, rgba: test.rgba }),
          }] } : {}),
        }, Number(process.env.LYNN_INSTALLED_GATE_VISION_TIMEOUT_MS || "120000"));

        if (result.errors.length) {
          throw new Error(`[installed-gate] live vision returned errors: ${result.errors.join("; ")}`);
        }
        if (selected.provider === "brain" && result.providerRoutes.length === 0) {
          throw new Error("[installed-gate] live vision did not identify its actual Brain route");
        }
        if (result.providerRoutes.some(route => route.fallbackFrom.length > 0)) {
          throw new Error(`[installed-gate] selected model vision was not proven: provider fallback ${JSON.stringify(result.providerRoutes)}`);
        }
        console.log(`[installed-gate] live vision actual routes=${JSON.stringify(result.providerRoutes)}`);
        const matches = test.expected
          ? isExpectedVisionColorAnswer(result.text, test.expected)
          : result.text.trim().length > 0 && !isExpectedVisionColorAnswer(result.text, cases.flatMap(item => item.expected || []));
        if (!matches) {
          throw new Error(`[installed-gate] live vision ${test.id} failed: ${JSON.stringify(result.text.slice(0, 500))}`);
        }
        console.log(`[installed-gate] live vision ${test.id} ok in ${result.elapsedMs}ms: ${result.text.replace(/\s+/g, " ").trim().slice(0, 120)}`);
      } finally {
        try {
          ws.close();
        } catch {}
      }
    }
  } finally {
    if (!sameModel && previous?.id && previous?.provider) {
      await httpJson(baseUrl, token, "/api/models/set", {
        method: "POST",
        body: { modelId: previous.id, provider: previous.provider },
        timeoutMs: 20000,
      }).catch((error) => {
        console.warn(`[installed-gate] failed to restore previous model ${previous.provider}/${previous.id}: ${error.message}`);
      });
    }
  }
}

async function waitForReviewResults(ws, expectedIds, timeoutMs) {
  const pending = new Set(expectedIds);
  const results = new Map();
  const failures = [];
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`[installed-gate] timed out waiting for review_result; pending=${[...pending].join(",")}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("[installed-gate] WebSocket closed before all review results"));
    };
    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== "review_result" || !pending.has(msg.reviewId)) return;
      const text = `${msg.content || ""} ${msg.structured?.summary || ""}`.trim();
      if (!text) {
        failures.push(`${msg.reviewId}: empty review_result`);
      }
      if (msg.errorCode && !/recovered/i.test(String(msg.errorCode))) {
        const detail = String(msg.fallbackNote || msg.error || msg.structured?.summary || "").replace(/\s+/g, " ").slice(0, 320);
        failures.push(`${msg.reviewId}: errorCode=${msg.errorCode}${detail ? ` detail=${detail}` : ""}`);
      }
      results.set(msg.reviewId, msg);
      pending.delete(msg.reviewId);
      if (pending.size === 0) {
        cleanup();
        if (failures.length) reject(new Error(`[installed-gate] bad review results: ${failures.join("; ")}`));
        else resolve(results);
      }
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

async function runConcurrentReviewGate(baseUrl, wsUrl, token, sessionPath = null) {
  const ws = await openWs(wsUrl, token);
  try {
    const ids = ["installed-review-1", "installed-review-2", "installed-review-3"].map((prefix) => `${prefix}-${Date.now()}`);
    const payloads = ids.map((reviewId, index) => ({
      reviewId,
      autoReview: true,
      reviewMode: "background",
      triggerReasons: ["installed_gate_concurrency"],
      context: [
        `安装包并发复查门禁 ${index + 1}/3。`,
        "请核对这段回答是否有事实错误、空答、工具成功但无总结的问题。",
        "原回答: 尼克斯 4:1 击败马刺夺冠；请检查结论是否自洽。",
      ].join("\n"),
      sourceResponse: "尼克斯 4:1 击败马刺夺冠。",
      ...(sessionPath ? { sessionPath } : {}),
    }));
    await Promise.all(payloads.map((body) => httpJson(baseUrl, token, "/api/review", {
      method: "POST",
      body,
      timeoutMs: 20000,
    })));
    const results = await waitForReviewResults(ws, ids, REVIEW_TIMEOUT_MS);
    const labels = [...results.values()].map((msg) => `${msg.reviewId}:${msg.reviewerModelLabel || "unknown"}`);
    console.log(`[installed-gate] concurrent review ok: ${labels.join(", ")}`);
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

async function runManualReviewGate(baseUrl, wsUrl, token) {
  const ws = await openWs(wsUrl, token);
  try {
    const reviewId = `installed-manual-review-${Date.now()}`;
    const resultsPromise = waitForReviewResults(ws, [reviewId], REVIEW_TIMEOUT_MS);
    const [, results] = await Promise.all([
      httpJson(baseUrl, token, "/api/review", {
        method: "POST",
        body: {
          reviewId,
          autoReview: false,
          context: "请复查原回答中的算术结论：2+2=5。指出是否正确并简短说明。",
          sourceResponse: "2+2=5。",
        },
        timeoutMs: 20000,
      }),
      resultsPromise,
    ]);
    const result = results.get(reviewId);
    const text = `${result.content || ""} ${result.structured?.summary || ""}`;
    if (!/4|四/.test(text) || /最低限度复查|没有生成新的模型判断|deterministic review status/i.test(text)) {
      throw new Error("[installed-gate] manual review did not provide a real correction");
    }
    console.log(`[installed-gate] manual review ok: ${result.reviewerModelLabel || "unknown"}`);
  } finally {
    ws.close();
  }
}

async function main() {
  const appBin = path.join(APP_PATH, "Contents", "MacOS", "Lynn");
  if (!await exists(appBin)) {
    throw new Error(`[installed-gate] missing installed app at ${APP_PATH}`);
  }

  console.log(`[installed-gate] app=${APP_PATH}`);
  if (!CONNECT_EXISTING) await quitExistingLynn();
  if (!CONNECT_EXISTING && !ONLY_LIVE_VISION && !ONLY_REVIEW_CONCURRENCY) {
    await run(process.execPath, ["scripts/packaged-server-smoke.mjs", "--app", APP_PATH]);
    await run(process.execPath, ["scripts/packaged-cli-runtime-smoke.mjs", "--app", APP_PATH]);
    await quitExistingLynn();
    await run(process.execPath, ["scripts/packaged-settings-provider-smoke.mjs", "--app", APP_PATH]);
    await quitExistingLynn();
    await run(process.execPath, ["scripts/packaged-main-ui-smoke.mjs", "--app", APP_PATH]);
    await quitExistingLynn();
  }

  const liveFixture = CONNECT_EXISTING ? null : await prepareGateHome();
  const isolatedSessionDir = CONNECT_EXISTING
    ? await fs.mkdtemp(path.join(os.tmpdir(), "lynn-installed-review-session-"))
    : null;
  const isolatedSessionPath = isolatedSessionDir ? path.join(isolatedSessionDir, "session.jsonl") : null;
  let directLaunch = null;
  try {
    if (isolatedSessionPath) await fs.writeFile(isolatedSessionPath, "", "utf8");
    if (liveFixture) {
      serverInfoPath = path.join(liveFixture.lynnHome, "server-info.json");
      await fs.rm(serverInfoPath, { force: true }).catch(() => {});
      directLaunch = await launchAppDirect(appBin, {
        ...process.env,
        LYNN_HOME: liveFixture.lynnHome,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        LYNN_LOCAL_MODEL_AUTO_START: "0",
      });
      console.log(`[installed-gate] fixture home=${liveFixture.lynnHome}`);
    } else if (!CONNECT_EXISTING) {
      await fs.rm(serverInfoPath, { force: true }).catch(() => {});
      await run("open", ["-a", APP_PATH]);
    }

    const info = await readServerInfo();
    const baseUrl = `http://127.0.0.1:${info.port}`;
    const wsUrl = `ws://127.0.0.1:${info.port}/ws`;
    const health = await waitForHttpJson(baseUrl, info.token, "/api/health", { timeoutMs: 45000 });
    if (health?.ok !== true && health?.status !== "ok") {
      throw new Error(`[installed-gate] health was not ok: ${JSON.stringify(health)}`);
    }
    await waitForHttpJson(baseUrl, info.token, "/api/review/config", { timeoutMs: 45000 });
    if (!ONLY_REVIEW_CONCURRENCY) {
      await runLiveVisionGate(baseUrl, wsUrl, info.token);
    }
    if (ONLY_LIVE_VISION) {
      console.log("[installed-gate] PASS: installed live vision gate completed.");
      return;
    }
    await runConcurrentReviewGate(baseUrl, wsUrl, info.token, isolatedSessionPath);
    await runManualReviewGate(baseUrl, wsUrl, info.token);
    console.log(ONLY_REVIEW_CONCURRENCY
      ? "[installed-gate] PASS: installed review concurrency gate completed."
      : "[installed-gate] PASS: installed GUI/server/CLI/settings/main-ui/live-vision/review concurrency gate completed.");
  } finally {
    if (directLaunch?.child) {
      await terminate(directLaunch.child);
    }
    if (!CONNECT_EXISTING) {
      await stopInstalledAppProcesses("final cleanup", { initialWaitMs: 1000, throwOnFailure: false });
    }
    if (liveFixture?.tmp && process.env.LYNN_INSTALLED_GATE_KEEP_TMP === "1") {
      console.log(`[installed-gate] keeping fixture home=${liveFixture.lynnHome}`);
    } else if (liveFixture?.tmp) {
      await fs.rm(liveFixture.tmp, { recursive: true, force: true }).catch(() => {});
    }
    if (isolatedSessionDir) {
      await fs.rm(isolatedSessionDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
