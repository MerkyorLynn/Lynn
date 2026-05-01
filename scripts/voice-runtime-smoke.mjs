#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { createEdgeTtsProvider } from "../server/clients/tts/edge.js";

const DEFAULTS = {
  asrUrl: process.env.LYNN_QWEN3_ASR_URL || "http://localhost:18007",
  serUrl: process.env.LYNN_EMOTION2VEC_URL || "http://localhost:18008",
  ttsUrl: process.env.LYNN_COSYVOICE_URL || "http://localhost:18021",
  text: "Lynn 语音链路测试。",
  voice: "中文女",
  timeoutMs: 3000,
};

export function parseArgs(argv = []) {
  const opts = {
    ...DEFAULTS,
    audioPath: null,
    includeEdge: false,
    synthesizeTts: true,
    json: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };

    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--asr-url") opts.asrUrl = next();
    else if (arg === "--ser-url") opts.serUrl = next();
    else if (arg === "--tts-url") opts.ttsUrl = next();
    else if (arg === "--audio") opts.audioPath = next();
    else if (arg === "--text" || arg === "--tts-text") opts.text = next();
    else if (arg === "--voice") opts.voice = next();
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(next());
    else if (arg === "--include-edge") opts.includeEdge = true;
    else if (arg === "--skip-tts-synth") opts.synthesizeTts = false;
    else if (arg === "--pretty") opts.json = false;
    else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }

  return opts;
}

export function usage() {
  return [
    "Usage: npm run voice:smoke -- [options]",
    "",
    "Checks the V0.79 Jarvis runtime services and prints a JSON verdict.",
    "",
    "Options:",
    "  --asr-url <url>        Qwen3-ASR base URL (default: LYNN_QWEN3_ASR_URL or http://localhost:18007)",
    "  --ser-url <url>        emotion2vec+ base URL (default: LYNN_EMOTION2VEC_URL or http://localhost:18008)",
    "  --tts-url <url>        CosyVoice2 base URL (default: LYNN_COSYVOICE_URL or http://localhost:18021)",
    "  --audio <path>         Optional wav/webm sample for ASR + SER inference",
    "  --text <text>          TTS sample text",
    "  --voice <voice>        CosyVoice voice name",
    "  --include-edge         Also health-check Edge TTS fallback",
    "  --skip-tts-synth       Only check TTS health, do not synthesize audio",
    "  --timeout-ms <ms>      Per-request timeout (default: 3000)",
    "  --pretty              Print a compact human summary before JSON",
    "",
    "Examples:",
    "  npm run voice:smoke",
    "  npm run voice:smoke -- --audio /tmp/voice.wav --include-edge",
  ].join("\n");
}

export async function runVoiceRuntimeSmoke(options = {}) {
  const opts = {
    ...DEFAULTS,
    audioPath: null,
    includeEdge: false,
    synthesizeTts: true,
    ...options,
  };
  const checkedAt = new Date().toISOString();
  const services = {};

  services.qwen3Asr = await checkHttpService({
    name: "qwen3-asr",
    url: opts.asrUrl,
    timeoutMs: opts.timeoutMs,
    infer: opts.audioPath
      ? () => postAudio(`${trimUrl(opts.asrUrl)}/transcribe`, opts.audioPath, opts.timeoutMs)
      : null,
  });

  services.emotion2vec = await checkHttpService({
    name: "emotion2vec-plus",
    url: opts.serUrl,
    timeoutMs: opts.timeoutMs,
    infer: opts.audioPath
      ? () => postAudio(`${trimUrl(opts.serUrl)}/classify`, opts.audioPath, opts.timeoutMs)
      : null,
  });

  services.cosyvoice2 = await checkHttpService({
    name: "cosyvoice2",
    url: opts.ttsUrl,
    timeoutMs: opts.timeoutMs,
    infer: opts.synthesizeTts
      ? () => postTts(`${trimUrl(opts.ttsUrl)}/v1/audio/speech`, {
          text: opts.text,
          voice: opts.voice,
          timeoutMs: opts.timeoutMs,
        })
      : null,
  });

  services.edgeTts = opts.includeEdge
    ? await checkEdgeTts({ text: opts.text, timeoutMs: opts.timeoutMs })
    : {
        name: "edge-tts",
        skipped: true,
        reason: "pass --include-edge to check the online fallback",
      };

  const mandatoryOk = [
    services.qwen3Asr.health?.ok,
    services.emotion2vec.health?.ok,
    services.cosyvoice2.health?.ok,
  ].every(Boolean);
  const inferenceOk = [
    services.qwen3Asr.inference,
    services.emotion2vec.inference,
    services.cosyvoice2.inference,
  ].filter(Boolean).every((step) => step.ok);
  const optionalOk = !opts.includeEdge || services.edgeTts.health?.ok;

  return {
    ok: mandatoryOk && inferenceOk && optionalOk,
    checkedAt,
    config: {
      asrUrl: opts.asrUrl,
      serUrl: opts.serUrl,
      ttsUrl: opts.ttsUrl,
      audioPath: opts.audioPath ? path.resolve(opts.audioPath) : null,
      includeEdge: !!opts.includeEdge,
      synthesizeTts: !!opts.synthesizeTts,
      timeoutMs: opts.timeoutMs,
    },
    services,
  };
}

async function checkHttpService({ name, url, timeoutMs, infer }) {
  const service = {
    name,
    url: trimUrl(url),
    health: await timedStep(async () => {
      const res = await fetchWithTimeout(`${trimUrl(url)}/health`, {}, timeoutMs);
      const body = await responsePreview(res);
      return { ok: res.ok, status: res.status, body };
    }),
  };

  if (infer) {
    service.inference = await timedStep(infer);
  }

  return service;
}

async function checkEdgeTts({ text, timeoutMs }) {
  const provider = createEdgeTtsProvider({ timeout_ms: timeoutMs });
  const health = await timedStep(async () => ({ ok: await provider.health() }));
  return {
    name: "edge-tts",
    health,
    note: text ? "health only; runtime fallback synthesis is covered by provider tests" : undefined,
  };
}

async function postAudio(url, audioPath, timeoutMs) {
  const abs = path.resolve(audioPath);
  const bytes = fs.readFileSync(abs);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: guessAudioMime(abs) }), path.basename(abs));

  const res = await fetchWithTimeout(url, { method: "POST", body: form }, timeoutMs);
  const body = await readJsonOrPreview(res);
  return {
    ok: res.ok,
    status: res.status,
    result: body,
  };
}

async function postTts(url, { text, voice, timeoutMs }) {
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "cosyvoice2",
      input: String(text || DEFAULTS.text),
      voice: String(voice || DEFAULTS.voice),
      response_format: "wav",
      speed: 1.0,
    }),
  }, timeoutMs);
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    ok: res.ok,
    status: res.status,
    mimeType: res.headers.get("content-type") || null,
    bytes: bytes.length,
    preview: res.ok ? undefined : bytes.toString("utf8", 0, Math.min(bytes.length, 240)),
  };
}

async function fetchWithTimeout(url, init = {}, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal: init.signal || timeout });
}

async function timedStep(fn) {
  const start = performance.now();
  try {
    const result = await fn();
    return {
      ...result,
      ms: Math.round(performance.now() - start),
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      ms: Math.round(performance.now() - start),
    };
  }
}

async function readJsonOrPreview(res) {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return await res.json();
  }
  return responsePreview(res);
}

async function responsePreview(res) {
  const text = await res.text().catch(() => "");
  return text.slice(0, 240);
}

function guessAudioMime(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".pcm" || ext === ".raw") return "audio/pcm";
  return "audio/webm";
}

function trimUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function printPretty(result) {
  const rows = [
    ["Qwen3-ASR", result.services.qwen3Asr],
    ["emotion2vec+", result.services.emotion2vec],
    ["CosyVoice2", result.services.cosyvoice2],
    ["Edge TTS", result.services.edgeTts],
  ];
  for (const [label, service] of rows) {
    if (service.skipped) {
      console.log(`${label}: skipped (${service.reason})`);
      continue;
    }
    const health = service.health;
    const infer = service.inference;
    const inferText = infer ? `, inference=${infer.ok ? "ok" : "fail"} ${infer.ms}ms` : "";
    console.log(`${label}: health=${health?.ok ? "ok" : "fail"} ${health?.ms ?? "-"}ms${inferText}`);
  }
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(usage());
      return;
    }
    const result = await runVoiceRuntimeSmoke(opts);
    if (!opts.json) printPretty(result);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    console.error(err?.message || String(err));
    console.error("");
    console.error(usage());
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}
