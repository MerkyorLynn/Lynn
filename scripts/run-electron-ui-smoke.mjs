#!/usr/bin/env node

import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, "output");

const SCENARIOS = [
  { id: "home", expect: ["Lynn"] },
  { id: "short", expect: ["UI_SMOKE_SHORT_OK"] },
  { id: "tools", expect: ["UI_SMOKE_TOOL_CARD", "reports/summary.md"] },
  { id: "long-code", expect: ["UI_SMOKE_LONG_CODE", "calculateTotal"] },
];

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcess(child, timeoutMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
  });

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  const timedOut = Symbol("timedOut");
  const result = await Promise.race([
    exited,
    wait(timeoutMs).then(() => timedOut),
  ]);

  if (result !== timedOut || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {}
}

async function fetchJson(url, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDebugPage(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = pages.find((item) => String(item.url || "").includes("index.html"))
        || pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page;
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw new Error(`Electron debug page not available${lastError ? `: ${lastError.message}` : ""}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.on("message", (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg.id) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else pending.resolve(msg.result || {});
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000).unref();
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function waitForExpression(cdp, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await cdp.evaluate(expression).catch(() => false);
    if (value) return true;
    await wait(200);
  }
  throw new Error(`Timed out waiting for expression: ${expression}`);
}

function assertScenario(id, snapshot, expectedTexts) {
  const failures = [];
  const text = String(snapshot.visibleText || "");
  if (snapshot.scenario !== id) failures.push(`scenario did not apply: expected ${id}, got ${snapshot.scenario || "(none)"}`);
  if (snapshot.overflowX > 2) failures.push(`horizontal overflow: ${snapshot.overflowX}px`);
  for (const expected of expectedTexts) {
    if (!text.includes(expected)) failures.push(`missing visible text: ${expected}`);
  }
  if (!snapshot.hasRoot) failures.push("react root missing");
  if (!snapshot.hasSidebar) failures.push("sidebar missing");
  if (!snapshot.hasTitlebar) failures.push("titlebar missing");
  return failures;
}

async function main() {
  const rendererEntry = path.join(ROOT, "desktop", "dist-renderer", "index.html");
  try {
    await fs.access(rendererEntry);
  } catch {
    throw new Error("desktop/dist-renderer/index.html missing. Run npm run build:renderer before UI smoke.");
  }

  const outputDir = path.join(DEFAULT_OUTPUT_ROOT, `ui-smoke-${nowStamp()}`);
  await fs.mkdir(outputDir, { recursive: true });

  const electronBin = require("electron");
  const debugPort = await getFreePort();
  const lynnHome = path.join(os.tmpdir(), `lynn-ui-smoke-${process.pid}-${Date.now()}`);
  await fs.mkdir(lynnHome, { recursive: true });

  const child = spawn(electronBin, [
    `--remote-debugging-port=${debugPort}`,
    ROOT,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      LYNN_HOME: lynnHome,
      LYNN_UI_SMOKE: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = [];
  child.stdout?.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk) => logs.push(`[stderr] ${chunk.toString()}`));

  const results = [];
  let cdp = null;
  try {
    const page = await waitForDebugPage(debugPort);
    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.call("Runtime.enable");
    await cdp.call("Page.enable");
    await cdp.call("Page.bringToFront");
    await cdp.call("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await waitForExpression(cdp, "window.__lynnUiSmokeReady === true");

    for (const scenario of SCENARIOS) {
      await cdp.evaluate(`window.__lynnSetUiSmokeScenario(${JSON.stringify(scenario.id)})`);
      await waitForExpression(cdp, `document.body.dataset.uiSmokeScenario === ${JSON.stringify(scenario.id)}`);
      await wait(350);
      const snapshot = await cdp.evaluate(`(() => {
        const root = document.documentElement;
        const body = document.body;
        return {
          scenario: body.dataset.uiSmokeScenario || '',
          visibleText: body.innerText || '',
          overflowX: Math.max(root.scrollWidth, body.scrollWidth) - window.innerWidth,
          hasRoot: !!document.getElementById('react-root'),
          hasSidebar: !!document.querySelector('.sidebar'),
          hasTitlebar: !!document.querySelector('.titlebar'),
        };
      })()`);
      const failures = assertScenario(scenario.id, snapshot, scenario.expect);
      const screenshot = await cdp.call("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      const screenshotPath = path.join(outputDir, `${scenario.id}.png`);
      await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
      results.push({
        id: scenario.id,
        ok: failures.length === 0,
        failures,
        screenshot: path.relative(ROOT, screenshotPath),
      });
      console.log(`[ui-smoke] ${scenario.id}: ${failures.length === 0 ? "PASS" : "FAIL"}`);
      for (const failure of failures) console.log(`  - ${failure}`);
    }
  } finally {
    cdp?.close();
    await fs.writeFile(path.join(outputDir, "electron.log"), logs.join(""));
    await terminateProcess(child);
  }

  const failed = results.filter((item) => !item.ok);
  await fs.writeFile(path.join(outputDir, "results.json"), JSON.stringify({ results }, null, 2) + "\n");
  console.log(`Report: ${path.relative(ROOT, outputDir)}`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[ui-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
