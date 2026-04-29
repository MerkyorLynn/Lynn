#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { RELEASE_CASES, RELEASE_LEVELS } from "../tests/release-regression/release-regression-cases.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, "output");

function parseArgs(argv) {
  const args = {
    mode: "all",
    level: "release",
    lynnHome: process.env.LYNN_HOME || "~/.lynn",
    output: "",
    serverInfo: "",
    baseUrl: "",
    wsUrl: "",
    token: "",
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--mode") args.mode = next();
    else if (arg.startsWith("--mode=")) args.mode = arg.slice("--mode=".length);
    else if (arg === "--level") args.level = next();
    else if (arg.startsWith("--level=")) args.level = arg.slice("--level=".length);
    else if (arg === "--lynn-home") args.lynnHome = next();
    else if (arg.startsWith("--lynn-home=")) args.lynnHome = arg.slice("--lynn-home=".length);
    else if (arg === "--server-info") args.serverInfo = next();
    else if (arg.startsWith("--server-info=")) args.serverInfo = arg.slice("--server-info=".length);
    else if (arg === "--base-url") args.baseUrl = next();
    else if (arg.startsWith("--base-url=")) args.baseUrl = arg.slice("--base-url=".length);
    else if (arg === "--ws-url") args.wsUrl = next();
    else if (arg.startsWith("--ws-url=")) args.wsUrl = arg.slice("--ws-url=".length);
    else if (arg === "--token") args.token = next();
    else if (arg.startsWith("--token=")) args.token = arg.slice("--token=".length);
    else if (arg === "--output") args.output = next();
    else if (arg.startsWith("--output=")) args.output = arg.slice("--output=".length);
    else if (arg === "--list") args.list = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  npm run test:release
  node scripts/run-release-regression.mjs --mode all --level release

Options:
  --mode static|live|all       default: all
  --level smoke|release|nightly default: release
  --lynn-home PATH             default: ~/.lynn
  --server-info PATH           override server-info.json
  --base-url URL               override HTTP base URL
  --ws-url URL                 override WebSocket URL
  --token TOKEN                override auth token
  --output DIR                 output directory
  --list                       list included cases`);
}

function expandHome(input) {
  if (!input) return input;
  return input.startsWith("~") ? path.join(os.homedir(), input.slice(1)) : input;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function caseIncluded(testCase, level) {
  const severities = RELEASE_LEVELS[level];
  if (!severities) throw new Error(`Unknown level "${level}"`);
  return severities.includes(testCase.severity);
}

function severityRank(severity) {
  return { blocker: 3, critical: 2, extended: 1, warning: 0 }[severity] ?? 0;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function makeCheck(id, severity, ok, message, detail = "") {
  return { id, severity, ok, message, detail };
}

function findSemverRefs(text) {
  return [...new Set(String(text || "").match(/\b\d+\.\d+\.\d+\b/g) || [])].sort();
}

async function runStaticChecks({ level }) {
  const checks = [];
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  const version = pkg.version;

  const requiredScripts = [
    "test",
    "build:server",
    "build:main",
    "build:renderer",
    "test:release",
    "test:release:ui",
    "release:preflight",
    "release:manifest",
  ];
  for (const name of requiredScripts) {
    checks.push(makeCheck(
      `static-script-${name}`,
      "blocker",
      Boolean(pkg.scripts?.[name]),
      `package.json has script ${name}`,
    ));
  }

  checks.push(makeCheck(
    "static-dist-preflight",
    "blocker",
    Boolean(pkg.scripts?.dist && pkg.scripts.dist.includes("release:preflight")),
    "package.json dist runs release:preflight before packaging",
  ));

  const manifestPath = path.join(ROOT, ".github", "update-manifest.json");
  if (await fileExists(manifestPath)) {
    const manifestText = await fs.readFile(manifestPath, "utf8");
    let manifest = null;
    try {
      manifest = JSON.parse(manifestText);
      checks.push(makeCheck("static-manifest-json", "blocker", true, "update manifest is valid JSON"));
    } catch (error) {
      checks.push(makeCheck("static-manifest-json", "blocker", false, "update manifest is valid JSON", error.message));
    }
    if (manifest?.stable?.assets) {
      const assetUrls = Object.values(manifest.stable.assets).map(String);
      checks.push(makeCheck(
        "static-manifest-stable-version",
        "blocker",
        manifest.stable.version === version,
        `manifest stable.version equals package version ${version}`,
        manifest.stable.version ? `manifest=${manifest.stable.version}` : "missing stable.version",
      ));
      checks.push(makeCheck(
        "static-manifest-release-url-version",
        "critical",
        String(manifest.stable.releaseUrl || "").includes(`v${version}`),
        `manifest releaseUrl points to v${version}`,
        String(manifest.stable.releaseUrl || ""),
      ));
      const badGithubDownloads = assetUrls.filter((url) => /github\.com\/.*\.(dmg|exe)(?:$|\?)/i.test(url));
      checks.push(makeCheck(
        "static-manifest-mirror-assets",
        "blocker",
        badGithubDownloads.length === 0,
        "manifest binary asset URLs use Tencent mirror, not GitHub",
        badGithubDownloads.join("\n"),
      ));
      const versionMismatches = assetUrls
        .filter((url) => /\.(dmg|exe)(?:$|\?)/i.test(url))
        .filter((url) => !url.includes(version));
      checks.push(makeCheck(
        "static-manifest-version",
        "critical",
        versionMismatches.length === 0,
        `manifest binary asset URLs include package version ${version}`,
        versionMismatches.join("\n"),
      ));
    }
  } else {
    checks.push(makeCheck("static-manifest-present", "critical", false, ".github/update-manifest.json exists"));
  }

  const siteFiles = ["site/app.js", "site/download.html", "site/index.html"];
  for (const rel of siteFiles) {
    const text = await readTextIfExists(path.join(ROOT, rel));
    if (!text) {
      checks.push(makeCheck(`static-site-${rel}`, "critical", false, `${rel} exists`));
      continue;
    }
    const githubBinaryLinks = [...text.matchAll(/https:\/\/github\.com\/[^\s"'<>]+?\.(?:dmg|exe)/gi)].map((m) => m[0]);
    checks.push(makeCheck(
      `static-site-${rel}-mirror`,
      "blocker",
      githubBinaryLinks.length === 0,
      `${rel} does not send binary downloads to GitHub`,
      githubBinaryLinks.join("\n"),
    ));
    const staleVersions = findSemverRefs(text).filter((ref) => ref !== version);
    checks.push(makeCheck(
      `static-site-${rel}-current-version`,
      "blocker",
      staleVersions.length === 0,
      `${rel} only references current package version ${version}`,
      staleVersions.join(", "),
    ));
  }

  const uiCase = RELEASE_CASES.find((item) => item.type === "static-ui-contract");
  if (uiCase) {
    for (const rel of uiCase.requiredFiles || []) {
      checks.push(makeCheck(
        `static-ui-${rel}`,
        uiCase.severity,
        await fileExists(path.join(ROOT, rel)),
        `UI contract file exists: ${rel}`,
      ));
    }
  }

  const l10nFiles = ["zh.json", "en.json", "ja.json", "ko.json", "zh-TW.json"];
  for (const file of l10nFiles) {
    checks.push(makeCheck(
      `static-locale-${file}`,
      "critical",
      await fileExists(path.join(ROOT, "desktop", "src", "locales", file)),
      `locale file exists: ${file}`,
    ));
  }

  const releaseNotes = await readTextIfExists(path.join(ROOT, "README.md"));
  checks.push(makeCheck(
    "static-readme-current-version",
    "critical",
    releaseNotes.includes(version),
    `README.md mentions current package version ${version}`,
  ));
  const readmeBadgeVersion = releaseNotes.match(/img\.shields\.io\/badge\/version-([0-9]+\.[0-9]+\.[0-9]+)-/i)?.[1] || "";
  checks.push(makeCheck(
    "static-readme-version-badge",
    "critical",
    readmeBadgeVersion === version,
    `README.md version badge equals package version ${version}`,
    readmeBadgeVersion ? `badge=${readmeBadgeVersion}` : "badge not found",
  ));

  return checks.filter((check) => level === "nightly" || severityRank(check.severity) >= 2);
}

async function resolveServerConfig(args) {
  if (args.baseUrl && args.wsUrl && args.token) {
    return { baseUrl: args.baseUrl, wsUrl: args.wsUrl, token: args.token };
  }

  const serverInfoPath = args.serverInfo
    ? path.resolve(expandHome(args.serverInfo))
    : path.join(path.resolve(expandHome(args.lynnHome)), "server-info.json");
  const info = JSON.parse(await fs.readFile(serverInfoPath, "utf8"));
  const baseUrl = args.baseUrl || `http://127.0.0.1:${info.port}`;
  const wsUrl = args.wsUrl || `ws://127.0.0.1:${info.port}/ws`;
  const token = args.token || info.token;
  return { baseUrl, wsUrl, token, serverInfoPath };
}

async function httpJson(url, token, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

async function httpJsonRequest(url, token, { method = "GET", body = null, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
    return { ok: res.ok, status: res.status, body: parsed, text };
  } finally {
    clearTimeout(timer);
  }
}

function detectThinkingLeak(text) {
  const raw = String(text || "");
  const patterns = [
    /<\/think>/i,
    /\bthinking process\b/i,
    /\bthe user wants me to\b/i,
    /\banalyze user input\b/i,
    /\bself-correction\b/i,
    /思考过程/,
    /用户要求我/,
    /根据系统设定/,
    /检查约束/,
  ];
  return patterns.filter((pattern) => pattern.test(raw)).map(String);
}

function detectPseudoToolLeak(text) {
  const raw = String(text || "");
  const patterns = [
    /<\s*(web_search|bash|read|write|edit|tool_call)\b/i,
    /<\/\s*(web_search|bash|read|write|edit|tool_call)\s*>/i,
    /\|\|\d+\s*\w+\s*\|\|\s*\{/,
    /\b(web_search|execute_bash|read_file|write_file)\s*\(/i,
  ];
  return patterns.filter((pattern) => pattern.test(raw)).map(String);
}

function detectDegeneration(text) {
  const raw = String(text || "");
  const issues = [];
  if (/\uFFFD/.test(raw)) issues.push("replacement-character");
  if (/(.)\1{24,}/.test(raw)) issues.push("single-character-loop");
  if ((raw.match(/\(Done\)|\(Proceeds?\)/gi) || []).length >= 3) issues.push("done-proceeds-loop");
  if ((raw.match(/【菜单】|🍽️/g) || []).length >= 3) issues.push("unrelated-menu-repeat");
  return issues;
}

function matchAny(text, needles = []) {
  return needles.filter((needle) => {
    if (needle instanceof RegExp) return needle.test(text);
    return String(text).includes(String(needle));
  });
}

function findMissing(text, needles = []) {
  return needles.filter((needle) => {
    if (needle instanceof RegExp) return !needle.test(text);
    return !String(text).includes(String(needle));
  });
}

function summarizeTools(tools) {
  return tools.map((tool) => `${tool.name || "unknown"}:${tool.success === true ? "ok" : tool.success === false ? "fail" : "?"}`);
}

function scoreTurn(testCase, turn, turnResult, turnIndex) {
  const failures = [];
  const warnings = [];
  const text = turnResult.text || "";

  if (turnResult.errors.length) failures.push(`runtime errors: ${turnResult.errors.join("; ")}`);
  if (!turnResult.finishedNormally) failures.push("turn did not end normally");
  if (turn.minChars && text.trim().length < turn.minChars) failures.push(`visible text too short: ${text.trim().length} < ${turn.minChars}`);
  if (turn.maxVisibleChars && text.trim().length > turn.maxVisibleChars) failures.push(`visible text too long: ${text.trim().length} > ${turn.maxVisibleChars}`);
  if (turn.requireTool && turnResult.tools.length === 0) failures.push("expected at least one tool_start event");
  if (turn.forbidTools && turnResult.tools.length > 0) failures.push(`unexpected tools: ${summarizeTools(turnResult.tools).join(", ")}`);

  if (turn.allowedToolHints?.length && turnResult.tools.length) {
    const allowed = turn.allowedToolHints.map((item) => item.toLowerCase());
    const disallowed = turnResult.tools
      .map((tool) => tool.name || "")
      .filter((name) => name && !allowed.some((hint) => name.toLowerCase().includes(hint)));
    if (disallowed.length) warnings.push(`tool names outside expected hints: ${[...new Set(disallowed)].join(", ")}`);
  }

  const missing = findMissing(text, turn.mustMatch || []);
  if (missing.length) failures.push(`missing required text: ${missing.join(", ")}`);

  const forbidden = matchAny(text, turn.mustNotMatch || []);
  if (forbidden.length) failures.push(`forbidden text appeared: ${forbidden.join(", ")}`);

  const thinkingLeaks = detectThinkingLeak(text);
  if (thinkingLeaks.length) failures.push(`visible thinking leak: ${thinkingLeaks.slice(0, 3).join(", ")}`);

  const pseudoLeaks = detectPseudoToolLeak(text);
  if (pseudoLeaks.length) failures.push(`visible pseudo tool syntax: ${pseudoLeaks.slice(0, 3).join(", ")}`);

  const degeneration = detectDegeneration(text);
  if (degeneration.length) failures.push(`degeneration: ${degeneration.join(", ")}`);

  if (turnResult.ttftMs !== null && turnResult.ttftMs > 20000) warnings.push(`slow TTFT: ${turnResult.ttftMs}ms`);
  if (turnResult.elapsedMs > Math.min(testCase.timeoutMs || 120000, 120000)) warnings.push(`slow turn: ${turnResult.elapsedMs}ms`);

  for (const previous of turnResult.previousTexts || []) {
    if (previous.marker && text.includes(previous.marker)) {
      failures.push(`cross-turn contamination marker leaked: ${previous.marker}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    turnIndex,
  };
}

function openWs(wsUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, [`token.${token}`]);
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {}
      reject(new Error("WebSocket open timeout"));
    }, 12000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function runLiveCase(testCase, config) {
  const started = Date.now();
  const result = {
    id: testCase.id,
    area: testCase.area,
    severity: testCase.severity,
    title: testCase.title,
    ok: false,
    turns: [],
    failures: [],
    warnings: [],
    elapsedMs: 0,
  };

  // Each release case gets a fresh session so queued internal retries, tool
  // finalizers, or stale stream state from the previous case cannot pollute the
  // next one. Multi-turn memory is still tested inside the same case/WS.
  const sessionCreate = await httpJsonRequest(`${config.baseUrl}/api/sessions/new`, config.token, {
    method: "POST",
    body: { cwd: ROOT, memoryEnabled: false },
    timeoutMs: 12000,
  }).catch(() => null);
  const sessionPath = sessionCreate?.body?.path || null;

  const ws = await openWs(config.wsUrl, config.token);
  let active = null;
  let activeResolve = null;
  const previousTexts = [];
  const quietAfterTurnEndMs = Number(process.env.LYNN_RELEASE_TURN_QUIET_MS || 10000);

  function scheduleActiveResolve() {
    if (!active || !activeResolve) return;
    if (active.endTimer) clearTimeout(active.endTimer);
    active.endTimer = setTimeout(() => {
      active.endTimer = null;
      activeResolve?.();
    }, quietAfterTurnEndMs);
  }

  ws.on("message", (raw) => {
    if (!active) return;
    let message = null;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (active.finishedNormally && active.endTimer) {
      clearTimeout(active.endTimer);
      active.endTimer = null;
    }
    active.events += 1;
    if (message.type === "text_delta") {
      if (active.ttftMs === null) active.ttftMs = Date.now() - active.startMs;
      active.text += message.delta || "";
      active.textChars += String(message.delta || "").length;
    } else if (message.type === "status") {
      active.lastStatusStreaming = message.isStreaming;
      if (active.finishedNormally && message.isStreaming === false) {
        if (active.endTimer) clearTimeout(active.endTimer);
        const visibleLen = active.text.trim().length;
        const expectedMinChars = active.minChars || 0;
        const graceMs = expectedMinChars && visibleLen < expectedMinChars
          ? quietAfterTurnEndMs
          : 250;
        active.endTimer = setTimeout(() => {
          active.endTimer = null;
          activeResolve?.();
        }, graceMs);
      }
    } else if (message.type === "thinking_delta") {
      active.thinkingChars += String(message.delta || "").length;
    } else if (message.type === "tool_start" || message.type === "tool_execution_start") {
      active.tools.push({
        id: message.toolCallId || message.id || "",
        name: message.name || message.toolName || "",
        success: null,
      });
    } else if (message.type === "tool_end" || message.type === "tool_execution_end") {
      const id = message.toolCallId || message.id || "";
      const name = message.name || message.toolName || "";
      const found = active.tools.find((tool) => (id && tool.id === id) || (name && tool.name === name && tool.success === null));
      if (found) found.success = message.success ?? !message.isError;
      else {
        // A delayed tool_end from the previous turn can arrive after the next
        // prompt starts. It is useful telemetry, but it should not count as a
        // fresh tool invocation for the current release case unless we saw the
        // matching tool_start in this turn.
        active.orphanToolEnds.push({ id, name, success: message.success ?? !message.isError });
      }
    } else if (message.type === "tool_authorization") {
      active.authorizations.push(message);
    } else if (message.type === "file_diff") {
      active.fileDiffs.push(message);
    } else if (message.type === "error") {
      active.errors.push(message.message || JSON.stringify(message));
    } else if (message.type === "turn_end") {
      active.finishedNormally = true;
      active.elapsedMs = Date.now() - active.startMs;
      scheduleActiveResolve();
    }
    if (active.finishedNormally && message.type !== "turn_end") {
      active.elapsedMs = Date.now() - active.startMs;
      scheduleActiveResolve();
    }
  });

  ws.on("error", (error) => {
    if (active) active.errors.push(`ws:${error.message}`);
  });

  try {
    for (let i = 0; i < testCase.turns.length; i++) {
      const turn = testCase.turns[i];
      active = {
        index: i,
        startMs: Date.now(),
        elapsedMs: 0,
        ttftMs: null,
        events: 0,
        text: "",
        textChars: 0,
        thinkingChars: 0,
        tools: [],
        orphanToolEnds: [],
        authorizations: [],
        fileDiffs: [],
        errors: [],
        finishedNormally: false,
        lastStatusStreaming: null,
        previousTexts,
        minChars: turn.minChars || 0,
      };

      const timeoutMs = turn.timeoutMs || testCase.timeoutMs || 120000;
      await new Promise((resolve) => {
        activeResolve = resolve;
        const timer = setTimeout(() => {
          if (active.endTimer) clearTimeout(active.endTimer);
          active.errors.push(`timeout ${timeoutMs}ms`);
          active.elapsedMs = Date.now() - active.startMs;
          resolve();
        }, timeoutMs);
        const done = activeResolve;
        activeResolve = () => {
          clearTimeout(timer);
          done();
        };
        const payload = { type: "prompt", text: turn.prompt };
        if (sessionPath) payload.sessionPath = sessionPath;
        ws.send(JSON.stringify(payload));
      });

      const turnScore = scoreTurn(testCase, turn, active, i);
      const turnResult = {
        index: i,
        ok: turnScore.ok,
        elapsedMs: active.elapsedMs,
        ttftMs: active.ttftMs,
        textChars: active.textChars,
        thinkingChars: active.thinkingChars,
        textPreview: active.text.replace(/\s+/g, " ").trim().slice(0, 500),
        tools: active.tools,
        orphanToolEnds: active.orphanToolEnds,
        authorizations: active.authorizations.length,
        fileDiffs: active.fileDiffs.length,
        errors: active.errors,
        failures: turnScore.failures,
        warnings: turnScore.warnings,
      };
      result.turns.push(turnResult);
      result.failures.push(...turnScore.failures.map((item) => `turn ${i + 1}: ${item}`));
      result.warnings.push(...turnScore.warnings.map((item) => `turn ${i + 1}: ${item}`));
      previousTexts.push({ marker: testCase.id, text: active.text });
      if (active.endTimer) clearTimeout(active.endTimer);
      active = null;
      activeResolve = null;

      if (!turnScore.ok && testCase.severity === "blocker") break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } finally {
    try {
      ws.close();
    } catch {}
  }

  result.elapsedMs = Date.now() - started;
  result.ok = result.failures.length === 0;
  return result;
}

async function runLiveChecks(args, outputDir) {
  const config = await resolveServerConfig(args);
  const health = await httpJson(`${config.baseUrl}/api/health`, config.token).catch((error) => ({
    ok: false,
    status: 0,
    text: error.message,
  }));

  const liveResults = [{
    id: "LIVE-HEALTH",
    area: "runtime",
    severity: "blocker",
    title: "HTTP health endpoint",
    ok: health.ok,
    failures: health.ok ? [] : [`health failed: ${health.status} ${health.text || ""}`],
    warnings: [],
    elapsedMs: 0,
    turns: [],
  }];

  const cases = RELEASE_CASES
    .filter((testCase) => testCase.type !== "static-ui-contract")
    .filter((testCase) => caseIncluded(testCase, args.level));

  for (const testCase of cases) {
    process.stdout.write(`[${testCase.id}] ${testCase.title} ... `);
    try {
      const result = await runLiveCase(testCase, config);
      liveResults.push(result);
      console.log(`${result.ok ? "PASS" : "FAIL"} ${result.elapsedMs}ms`);
      if (!result.ok) {
        for (const failure of result.failures.slice(0, 3)) console.log(`  - ${failure}`);
      }
    } catch (error) {
      const failed = {
        id: testCase.id,
        area: testCase.area,
        severity: testCase.severity,
        title: testCase.title,
        ok: false,
        failures: [`runner error: ${error.message}`],
        warnings: [],
        elapsedMs: 0,
        turns: [],
      };
      liveResults.push(failed);
      console.log(`FAIL ${error.message}`);
    }
  }

  await fs.writeFile(path.join(outputDir, "live-results.json"), JSON.stringify({
    config: { baseUrl: config.baseUrl, wsUrl: config.wsUrl, serverInfoPath: config.serverInfoPath },
    level: args.level,
    results: liveResults,
  }, null, 2));
  return liveResults;
}

function markdownTable(rows) {
  if (!rows.length) return "";
  return [
    "| ID | Severity | Status | Message |",
    "|---|---|---:|---|",
    ...rows.map((row) => `| ${row.id} | ${row.severity} | ${row.ok ? "PASS" : "FAIL"} | ${String(row.message || row.title || "").replace(/\|/g, "\\|")} |`),
  ].join("\n");
}

async function writeReport(outputDir, { args, staticChecks, liveResults }) {
  const all = [
    ...staticChecks.map((item) => ({ ...item, kind: "static" })),
    ...liveResults.map((item) => ({ ...item, kind: "live", message: item.title })),
  ];
  const failed = all.filter((item) => !item.ok);
  const blockerFailed = failed.filter((item) => item.severity === "blocker");
  const criticalFailed = failed.filter((item) => item.severity === "critical");
  const warnings = all.flatMap((item) => (item.warnings || []).map((warning) => ({ ...item, warning })));

  const lines = [
    `# Lynn Release Regression Report`,
    "",
    `- Time: ${new Date().toISOString()}`,
    `- Mode: ${args.mode}`,
    `- Level: ${args.level}`,
    `- Total checks: ${all.length}`,
    `- Failed: ${failed.length}`,
    `- Blocker failed: ${blockerFailed.length}`,
    `- Critical failed: ${criticalFailed.length}`,
    "",
    "## Failed Checks",
    "",
    markdownTable(failed.map((item) => ({
      id: item.id,
      severity: item.severity,
      ok: item.ok,
      message: (item.failures && item.failures[0]) || item.detail || item.message,
    }))) || "No failed checks.",
    "",
    "## Static Checks",
    "",
    markdownTable(staticChecks) || "Static checks were not run.",
    "",
    "## Live Checks",
    "",
    markdownTable(liveResults.map((item) => ({
      id: item.id,
      severity: item.severity,
      ok: item.ok,
      message: item.ok ? item.title : ((item.failures || [])[0] || item.title),
    }))) || "Live checks were not run.",
    "",
    "## Warnings",
    "",
    warnings.length
      ? warnings.map((item) => `- ${item.id}: ${item.warning}`).join("\n")
      : "No warnings.",
    "",
    "## UI Manual Gate",
    "",
    "- Launch the packaged app, not only dev server.",
    "- Verify first viewport: session list, composer, model picker, security mode, task mode, voice button.",
    "- Send a short prompt and a tool prompt; verify text, thinking, tool cards, errors, and stop button states do not overlap.",
    "- Open Settings: Providers, Voice, Bridge, Security. Verify no clipped labels on 1280px width and macOS window controls remain clickable.",
    "- Test voice long-press once: permission prompt, recording state, ASR result insertion, TTS playback state.",
    "- Test a file diff response: diff viewer, apply/reject controls, rollback affordance.",
    "",
  ];

  const reportPath = path.join(outputDir, "report.md");
  await fs.writeFile(reportPath, lines.join("\n"), "utf8");
  return { reportPath, failed, blockerFailed, criticalFailed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!["static", "live", "all"].includes(args.mode)) throw new Error(`Invalid mode: ${args.mode}`);
  if (!RELEASE_LEVELS[args.level]) throw new Error(`Invalid level: ${args.level}`);

  const includedCases = RELEASE_CASES.filter((item) => item.type !== "static-ui-contract" && caseIncluded(item, args.level));
  if (args.list) {
    for (const item of includedCases) console.log(`${item.id}\t${item.severity}\t${item.area}\t${item.title}`);
    return;
  }

  const outputDir = args.output
    ? path.resolve(args.output)
    : path.join(DEFAULT_OUTPUT_ROOT, `release-regression-${nowStamp()}`);
  await fs.mkdir(outputDir, { recursive: true });

  const staticChecks = args.mode === "live" ? [] : await runStaticChecks(args);
  if (staticChecks.length) {
    const failed = staticChecks.filter((check) => !check.ok);
    console.log(`[static] ${staticChecks.length - failed.length}/${staticChecks.length} passed`);
    for (const check of failed) console.log(`  FAIL ${check.id}: ${check.message}${check.detail ? `\n${check.detail}` : ""}`);
    await fs.writeFile(path.join(outputDir, "static-results.json"), JSON.stringify(staticChecks, null, 2));
  }

  const liveResults = args.mode === "static" ? [] : await runLiveChecks(args, outputDir);
  const report = await writeReport(outputDir, { args, staticChecks, liveResults });

  console.log(`\nReport: ${path.relative(ROOT, report.reportPath)}`);
  console.log(`Failed: ${report.failed.length}; blocker: ${report.blockerFailed.length}; critical: ${report.criticalFailed.length}`);

  if (report.blockerFailed.length > 0 || (args.level !== "smoke" && report.criticalFailed.length > 0)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[release-regression] ${error.stack || error.message}`);
  process.exit(1);
});
