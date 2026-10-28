#!/usr/bin/env node

import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "js-yaml";
import WebSocket from "ws";
import localHardware from "../shared/local-model-hardware.cjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findPackagedApp() {
  const explicit = process.argv.includes("--app")
    ? process.argv[process.argv.indexOf("--app") + 1]
    : null;
  return path.resolve(explicit || path.join(ROOT, "dist", "mac-arm64", "Lynn.app"));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForFile(filePath, child, logs, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`[packaged-settings-smoke] app exited early code=${child.exitCode}\n${tail(logs.value)}`);
    }
    if (await exists(filePath)) return;
    await wait(250);
  }
  throw new Error(`[packaged-settings-smoke] timed out waiting for ${filePath}\n${tail(logs.value)}`);
}

async function waitForDebugPage(port, matcher, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastPages = [];
  while (Date.now() < deadline) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      lastPages = Array.isArray(pages)
        ? pages.map((page) => ({ title: page.title, url: page.url }))
        : [];
      const page = pages.find(matcher);
      if (page?.webSocketDebuggerUrl) return page;
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`[packaged-settings-smoke] Electron debug page not available${suffix}; pages=${JSON.stringify(lastPages)}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.on("message", (raw) => {
      let msg;
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

  async screenshot(filePath) {
    const result = await this.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    if (!result.data) return;
    await fs.writeFile(filePath, Buffer.from(String(result.data), "base64"));
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

function tail(text, max = 4000) {
  const value = String(text || "");
  return value.length > max ? value.slice(-max) : value;
}

async function terminate(child, timeoutMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const timedOut = Symbol("timedOut");
  const result = await Promise.race([exited, wait(timeoutMs).then(() => timedOut)]);
  if (result !== timedOut || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {}
}

async function rmRetry(filePath, retries = 5) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await fs.rm(filePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      return;
    } catch (error) {
      lastError = error;
      await wait(150 * (attempt + 1));
    }
  }
  throw lastError;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeYaml(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, YAML.dump(value), "utf-8");
}

async function main() {
  const appPath = findPackagedApp();
  const appBin = path.join(appPath, "Contents", "MacOS", "Lynn");
  if (!await exists(appBin)) {
    throw new Error(`[packaged-settings-smoke] missing packaged app: ${appPath}`);
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-packaged-settings-"));
  const lynnHome = path.join(tmp, ".lynn");
  const outputDir = path.join(ROOT, "output", `packaged-settings-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await fs.mkdir(outputDir, { recursive: true });
  await writeJson(path.join(lynnHome, "user", "preferences.json"), { setupComplete: true });
  await writeYaml(path.join(lynnHome, "added-models.yaml"), {
    providers: {
      DeepSeek: {
        api_key: "enc:broken-old-key",
        base_url: "https://empty.example/v1",
        api: "openai-completions",
        models: ["deepseek-v4-pro"],
      },
      deepseek: {
        api_key: "sk-real-packaged-smoke",
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        models: ["deepseek-v4-flash", "deepseek-chat"],
      },
    },
  });

  const debugPort = await getFreePort();
  const logs = { value: "" };
  const child = spawn(appBin, [`--remote-debugging-port=${debugPort}`], {
    cwd: path.dirname(appBin),
    env: {
      ...process.env,
      LYNN_HOME: lynnHome,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      LYNN_LOCAL_MODEL_AUTO_START: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs.value += String(chunk); });
  child.stderr.on("data", (chunk) => { logs.value += String(chunk); });

  let mainCdp;
  let settingsCdp;
  try {
    const serverInfoPath = path.join(lynnHome, "server-info.json");
    await waitForFile(serverInfoPath, child, logs);
    const serverInfo = JSON.parse(await fs.readFile(serverInfoPath, "utf-8"));
    const headers = { Authorization: `Bearer ${serverInfo.token}` };
    const summaryRes = await fetch(`http://127.0.0.1:${serverInfo.port}/api/providers/summary`, { headers });
    const summary = await summaryRes.json();
    const providerIds = Object.keys(summary.providers || {});
    if (providerIds.includes("DeepSeek")) {
      throw new Error(`[packaged-settings-smoke] duplicate uppercase provider survived: ${providerIds.join(",")}`);
    }
    const deepseek = summary.providers?.deepseek;
    if (!deepseek?.has_credentials) {
      throw new Error(`[packaged-settings-smoke] deepseek credentials not detected: ${JSON.stringify(deepseek)}`);
    }
    if (deepseek.base_url !== "https://api.deepseek.com/v1") {
      throw new Error(`[packaged-settings-smoke] deepseek base_url did not follow usable key config: ${deepseek.base_url}`);
    }
    const savedModelIds = (deepseek.models || []).map((model) => typeof model === "string" ? model : model?.id).filter(Boolean).sort();
    if (!savedModelIds.includes("deepseek-v4-flash") || !savedModelIds.includes("deepseek-v4-pro")) {
      throw new Error(`[packaged-settings-smoke] deepseek saved models not merged: ${JSON.stringify(deepseek.models)}`);
    }
    if (!savedModelIds.includes("deepseek-chat")) {
      throw new Error(`[packaged-settings-smoke] deepseek-chat was not present before remove smoke: ${JSON.stringify(deepseek.models)}`);
    }

    const mainPage = await waitForDebugPage(debugPort, (item) => String(item.url || "").includes("index.html"));
    mainCdp = new CdpClient(mainPage.webSocketDebuggerUrl);
    await mainCdp.open();
    await mainCdp.call("Runtime.enable");
    await waitForMainWindowPlatform(mainCdp);
    const openedSettings = await mainCdp.evaluate(`(async () => {
      if (typeof window.platform?.openSettings !== 'function') return false;
      await window.platform.openSettings({ tab: 'providers', providerId: 'DeepSeek' });
      return true;
    })()`);
    if (!openedSettings) {
      throw new Error("[packaged-settings-smoke] main window did not expose platform.openSettings");
    }

    const settingsPage = await waitForDebugPage(debugPort, (item) => String(item.url || "").includes("settings.html"));
    settingsCdp = new CdpClient(settingsPage.webSocketDebuggerUrl);
    await settingsCdp.open();
    await settingsCdp.call("Page.enable");
    await settingsCdp.call("Runtime.enable");
    const snapshot = await waitForSettingsSnapshot(settingsCdp);
    await settingsCdp.screenshot(path.join(outputDir, "settings-providers.png"));

    if (snapshot.text.includes("127.0.0.1:null") || snapshot.text.includes("Failed to parse URL")) {
      throw new Error(`[packaged-settings-smoke] settings page showed invalid server URL:\n${snapshot.text}`);
    }
    if (snapshot.providerNames.filter((name) => name === "DeepSeek").length !== 1) {
      throw new Error(`[packaged-settings-smoke] expected one DeepSeek list item, got ${JSON.stringify(snapshot.providerNames)}`);
    }
    if (!snapshot.detailTitles.includes("DeepSeek")) {
      throw new Error(`[packaged-settings-smoke] expected DeepSeek detail title, got ${JSON.stringify(snapshot.detailTitles)}`);
    }
    if (!snapshot.text.includes("deepseek-v4-flash") || !snapshot.text.includes("deepseek-v4-pro") || !snapshot.text.includes("deepseek-chat")) {
      throw new Error(`[packaged-settings-smoke] settings page did not show merged DeepSeek models:\n${snapshot.text}`);
    }

    const removedClicked = await settingsCdp.evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('[class*="pv-fav-item"]'));
      const item = items.find((el) => (el.textContent || '').includes('deepseek-chat'));
      const button = item?.querySelector('[class*="pv-fav-item-remove"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!removedClicked) {
      throw new Error(`[packaged-settings-smoke] could not click deepseek-chat remove button:\n${snapshot.text}`);
    }

    const afterRemoveSnapshot = await waitForSettingsSnapshot(settingsCdp, {
      ready: (snap) => snap.text.includes("DeepSeek") &&
        snap.text.includes("deepseek-v4-flash") &&
        snap.text.includes("deepseek-v4-pro") &&
        !snap.text.includes("deepseek-chat"),
    });
    await settingsCdp.screenshot(path.join(outputDir, "settings-providers-after-remove.png"));
    const summaryAfterRemoveRes = await fetch(`http://127.0.0.1:${serverInfo.port}/api/providers/summary`, { headers });
    const summaryAfterRemove = await summaryAfterRemoveRes.json();
    const deepseekAfterRemove = summaryAfterRemove.providers?.deepseek;
    const afterSavedIds = (deepseekAfterRemove?.models || []).map((model) => typeof model === "string" ? model : model?.id).filter(Boolean);
    if (afterSavedIds.includes("deepseek-chat")) {
      throw new Error(`[packaged-settings-smoke] removed DeepSeek model stayed saved after click: ${JSON.stringify(deepseekAfterRemove?.models)}`);
    }
    if ((deepseekAfterRemove?.custom_models || []).includes("deepseek-chat")) {
      throw new Error(`[packaged-settings-smoke] removed DeepSeek model leaked into candidates after click: ${JSON.stringify(deepseekAfterRemove?.custom_models)}`);
    }
    if (!(deepseekAfterRemove?.removed_models || []).includes("deepseek-chat")) {
      throw new Error(`[packaged-settings-smoke] removed DeepSeek model marker missing after click: ${JSON.stringify(deepseekAfterRemove?.removed_models)}`);
    }
    if (afterRemoveSnapshot.text.includes("deepseek-chat")) {
      throw new Error(`[packaged-settings-smoke] removed DeepSeek model leaked back into settings UI:\n${afterRemoveSnapshot.text}`);
    }
    await verifyLocalProviderHardware(settingsCdp, outputDir);
    console.log(`[packaged-settings-smoke] settings providers ok: ${path.relative(ROOT, appPath)} screenshot=${path.relative(ROOT, outputDir)}/settings-providers-after-remove.png`);
  } finally {
    mainCdp?.close();
    settingsCdp?.close();
    await terminate(child);
    await rmRetry(tmp);
  }
}

async function verifyLocalProviderHardware(cdp, outputDir) {
  const cases = [
    { id: 'mac-16gb', platform: 'darwin', arch: 'arm64', totalMemoryGib: 16, gpus: [], quantization: 'Q2' },
    { id: 'mac-24gb', platform: 'darwin', arch: 'arm64', totalMemoryGib: 24, gpus: [], quantization: 'Q3' },
    { id: 'mac-8gb', platform: 'darwin', arch: 'arm64', totalMemoryGib: 8, gpus: [], quantization: null },
    { id: 'windows-unknown', platform: 'win32', arch: 'x64', totalMemoryGib: 64, gpus: [], quantization: null },
    { id: 'windows-multi-gpu', platform: 'win32', arch: 'x64', totalMemoryGib: 64,
      gpus: [{ name: 'Small GPU', memory_gib: 8 }, { name: 'Large GPU', memory_gib: 24 }], quantization: 'Q3' },
  ];
  const results = [];
  await cdp.evaluate(`(() => {
    window.__localHardwareOriginalFetch = window.fetch;
    window.__localHardwareRequests = 0;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (new URL(url, location.href).pathname === '/api/local-qwen35-9b/status') {
        window.__localHardwareRequests++;
        return Promise.resolve(new Response(JSON.stringify(window.__localHardwareFixture), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        }));
      }
      return window.__localHardwareOriginalFetch(input, init);
    };
    window.__localHardwareOriginalConfirm = window.confirm;
    window.confirm = text => { window.__localHardwareConfirmation = text; return false; };
  })()`);
  try {
    for (const test of cases) {
      const hardware = { ...test, ...localHardware.recommendLocalModel(test) };
      await cdp.evaluate(`(() => {
        const cloud = [...document.querySelectorAll('[class*="pv-list-item-name"]')].find(e => e.textContent.trim() === 'DeepSeek');
        if (!cloud) throw new Error('Cloud provider missing');
        cloud.click();
      })()`);
      await waitForSettingsSnapshot(cdp);
      await cdp.evaluate(`(() => {
        window.__localHardwareFixture = ${JSON.stringify({ ok: true, runtime: { model_ids: [] }, job: null,
          plan: { hardware, observed: {}, decision: 'inspect' } })};
        window.__localHardwareRequests = 0;
        window.__localHardwareConfirmation = null;
        const local = [...document.querySelectorAll('[class*="pv-list-item-name"]')].find(e => e.textContent.includes('本地 Qwen'));
        if (!local) throw new Error('Local Qwen provider missing');
        local.click();
      })()`);
      const deadline = Date.now() + 10000;
      let snapshot;
      while (Date.now() < deadline) {
        snapshot = await cdp.evaluate(`(() => ({
          text: document.body.innerText,
          requests: window.__localHardwareRequests,
          selected: document.querySelector('select[aria-label="本地模型安装方案"]')?.value,
          disabled: document.querySelector('[class*="pv-local-qwen-primary"]')?.disabled,
        }))()`);
        if (/区域发生了异常|Something went wrong/.test(snapshot.text)) throw new Error(`${test.id}: local provider render crashed`);
        if (snapshot.requests > 0 && snapshot.selected && snapshot.disabled === !hardware.can_enable) break;
        await wait(100);
      }
      if (!snapshot?.selected || snapshot.requests === 0 || snapshot.disabled !== !hardware.can_enable) {
        throw new Error(`${test.id}: local provider controls unavailable: ${JSON.stringify(snapshot)}`);
      }
      if (test.quantization && !snapshot.selected.includes(`-${test.quantization.toLowerCase()}-`)) {
        throw new Error(`${test.id}: incorrect recommended model ${snapshot.selected}`);
      }
      if (hardware.can_enable) {
        const confirmation = await cdp.evaluate(`(() => {
          document.querySelector('[class*="pv-local-qwen-primary"]').click();
          return window.__localHardwareConfirmation;
        })()`);
        if (!confirmation?.includes(test.quantization)) throw new Error(`${test.id}: install confirmation missing`);
      }
      await cdp.screenshot(path.join(outputDir, `settings-local-${test.id}.png`));
      results.push({ id: test.id, selected: snapshot.selected, installEnabled: !snapshot.disabled, passed: true });
      console.log(`[packaged-settings-smoke] local hardware ${test.id}: PASS`);
    }
    await writeJson(path.join(outputDir, 'local-hardware-results.json'), results);
  } finally {
    await cdp.evaluate(`(() => { window.fetch = window.__localHardwareOriginalFetch; window.confirm = window.__localHardwareOriginalConfirm; })()`);
  }
}

async function waitForMainWindowPlatform(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => ({
      readyState: document.readyState,
      hasPlatform: !!window.platform,
      hasOpenSettings: typeof window.platform?.openSettings === 'function',
      bodyText: (document.body?.innerText || '').slice(0, 500),
      location: String(location.href || ''),
    }))()`).catch((error) => ({ error: error?.message || String(error) }));
    last = state;
    if (state?.hasOpenSettings) return state;
    await wait(250);
  }
  throw new Error(`[packaged-settings-smoke] main window platform.openSettings not ready\n${JSON.stringify(last)}`);
}

async function waitForSettingsSnapshot(cdp, options = {}) {
  const timeoutMs = typeof options === "number" ? options : (options.timeoutMs || 30000);
  const ready = typeof options === "object" && typeof options.ready === "function"
    ? options.ready
    : (snapshot) => snapshot?.ready;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const snapshot = await cdp.evaluate(`(() => {
      const text = document.body?.innerText || '';
      const providerNames = Array.from(document.querySelectorAll('[class*="pv-list-item-name"]'))
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean);
      const detailTitles = Array.from(document.querySelectorAll('[class*="pv-detail-title"]'))
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean);
      return { text, providerNames, detailTitles, ready: text.includes('DeepSeek') && text.includes('deepseek-v4-flash') };
    })()`).catch((error) => ({ error: error?.message || String(error), text: '', providerNames: [] }));
    last = snapshot;
    if (ready(snapshot)) return snapshot;
    await wait(300);
  }
  throw new Error(`[packaged-settings-smoke] timed out waiting for settings provider UI\n${JSON.stringify(last)}`);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
