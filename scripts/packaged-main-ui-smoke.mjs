#!/usr/bin/env node

import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "js-yaml";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findPackagedApp() {
  const explicit = process.argv.includes("--app")
    ? process.argv[process.argv.indexOf("--app") + 1]
    : null;
  return path.resolve(explicit || path.join(ROOT, "dist", "mac-arm64", "Lynn.app"));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function postJson(url, body, headers = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDebugPage(port, matcher, timeoutMs = 45000) {
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
  throw new Error(`[packaged-main-ui-smoke] Electron debug page not available${suffix}; pages=${JSON.stringify(lastPages)}`);
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
    this.ws.on("close", () => this.rejectAll(new Error("CDP socket closed")));
    this.ws.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
  }

  rejectAll(error) {
    for (const [, pending] of this.pending) pending.reject(error);
    this.pending.clear();
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
      }, 12000).unref();
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
    const result = await this.call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
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

async function writeJsonl(filePath, entries) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await fs.writeFile(filePath, `${body}\n`, "utf-8");
}

async function waitForFile(filePath, child, logs, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`[packaged-main-ui-smoke] app exited early code=${child.exitCode}\n${tail(logs.value)}`);
    }
    if (await exists(filePath)) return;
    await wait(250);
  }
  throw new Error(`[packaged-main-ui-smoke] timed out waiting for ${filePath}\n${tail(logs.value)}`);
}

async function waitFor(cdp, expression, timeoutMs = 30000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expression);
      if (last) return last;
    } catch (error) {
      last = { error: error?.message || String(error) };
    }
    await wait(250);
  }
  throw new Error(`[packaged-main-ui-smoke] timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function setViewport(cdp, width, height) {
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  try {
    const current = await cdp.call("Browser.getWindowForTarget");
    if (Number.isFinite(current.windowId)) {
      await cdp.call("Browser.setWindowBounds", {
        windowId: current.windowId,
        bounds: { width, height, windowState: "normal" },
      });
    }
  } catch {
    // Electron builds can deny Browser domain calls in some modes. The emulated
    // viewport above is enough to catch renderer layout regressions.
  }
}

function assertOk(condition, message) {
  if (!condition) throw new Error(`[packaged-main-ui-smoke] ${message}`);
}

async function main() {
  const appPath = findPackagedApp();
  const appBin = path.join(appPath, "Contents", "MacOS", "Lynn");
  if (!await exists(appBin)) {
    throw new Error(`[packaged-main-ui-smoke] missing packaged app: ${appPath}`);
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-packaged-main-ui-"));
  const lynnHome = path.join(tmp, `${path.basename(tmp)}-home`);
  const outputDir = path.join(ROOT, "output", `packaged-main-ui-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await fs.mkdir(outputDir, { recursive: true });
  await writeJson(path.join(lynnHome, "user", "preferences.json"), {
    setupComplete: true,
    locale: "zh-CN",
    bridge: {
      feishu: {
        enabled: false,
        appId: "cli_ui_smoke",
        appSecret: "ui-smoke-secret",
      },
    },
  });
  await writeJson(path.join(lynnHome, "agents", "lynn", "sessions", "bridge", "bridge-sessions.json"), {
    fs_dm_ui_smoke: {
      userId: "ui_smoke",
      name: "飞书测试联系人",
    },
  });
  await writeYaml(path.join(lynnHome, "added-models.yaml"), {
    providers: {
      deepseek: {
        api_key: "sk-main-ui-smoke",
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        models: ["deepseek-v4-flash", "deepseek-v4-pro"],
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
      LYNN_UI_NO_FRONT: process.env.LYNN_UI_NO_FRONT || "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      LYNN_LOCAL_MODEL_AUTO_START: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs.value += String(chunk); });
  child.stderr.on("data", (chunk) => { logs.value += String(chunk); });

  let cdp;
  try {
    const serverInfoPath = path.join(lynnHome, "server-info.json");
    await waitForFile(serverInfoPath, child, logs);
    const serverInfo = JSON.parse(await fs.readFile(serverInfoPath, "utf-8"));
    const page = await waitForDebugPage(debugPort, (item) => String(item.url || "").includes("index.html"));
    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.call("Runtime.enable");
    await cdp.call("Page.enable");
    if (process.env.LYNN_UI_NO_FRONT !== "1") {
      await cdp.call("Page.bringToFront");
    }
    await setViewport(cdp, 1040, 760);

    await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.platform && !!document.querySelector('#inputBox'))()`, 60000, "main composer");
    await cdp.evaluate(`window.platform?.settingsChanged?.('models-changed', { source: 'packaged-main-ui-smoke' })`);
    await waitFor(cdp, `(() => {
      const button = document.querySelector('button[class*="model-pill"]');
      return !!button?.title.trim() && !button.className.includes('model-pill-disabled');
    })()`, 60000, "loaded model selector button");

    const baseLayout = await cdp.evaluate(`(() => {
      const rectOf = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const body = document.body;
      const root = document.documentElement;
      const inputArea = document.querySelector('.input-area');
      const wrapper = document.querySelector('[class*="input-wrapper"]');
      const textarea = document.querySelector('#inputBox');
      const bottomBar = document.querySelector('[class*="input-bottom-bar"]');
      const modelButton = document.querySelector('[class*="model-pill"]');
      const moreButton = document.querySelector('button[aria-label="更多输入选项"]');
      const sendButton = document.querySelector('button[class*="send-btn"]');
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        overflowX: Math.max(root.scrollWidth, body.scrollWidth) - window.innerWidth,
        text: (body.innerText || '').slice(0, 2000),
        inputArea: rectOf(inputArea),
        wrapper: rectOf(wrapper),
        textarea: rectOf(textarea),
        bottomBar: rectOf(bottomBar),
        modelButton: rectOf(modelButton),
        moreButton: rectOf(moreButton),
        sendButton: rectOf(sendButton),
        hasAttach: !!document.querySelector('button[class*="attach-btn"]'),
        hasVoice: !!document.querySelector('button[aria-label*="语音"]'),
      };
    })()`);

    const failures = [];
    const within = (name, rect, { minWidth = 1, minHeight = 1 } = {}) => {
      if (!rect) {
        failures.push(`${name} missing`);
        return;
      }
      if (rect.width < minWidth || rect.height < minHeight) failures.push(`${name} too small ${JSON.stringify(rect)}`);
      if (rect.left < -2 || rect.right > baseLayout.viewport.width + 2) failures.push(`${name} horizontally clipped ${JSON.stringify(rect)}`);
      if (rect.top < -2 || rect.bottom > baseLayout.viewport.height + 2) failures.push(`${name} vertically clipped ${JSON.stringify(rect)}`);
    };
    if (baseLayout.overflowX > 3) failures.push(`horizontal document overflow ${baseLayout.overflowX}px`);
    within("inputArea", baseLayout.inputArea, { minWidth: 300, minHeight: 80 });
    within("inputWrapper", baseLayout.wrapper, { minWidth: 300, minHeight: 80 });
    within("textarea", baseLayout.textarea, { minWidth: 220, minHeight: 30 });
    within("bottomBar", baseLayout.bottomBar, { minWidth: 300, minHeight: 38 });
    within("modelButton", baseLayout.modelButton, { minWidth: 80, minHeight: 28 });
    within("moreButton", baseLayout.moreButton, { minWidth: 28, minHeight: 28 });
    within("sendButton", baseLayout.sendButton, { minWidth: 34, minHeight: 34 });
    if (!baseLayout.hasAttach) failures.push("attach button missing");
    if (!baseLayout.hasVoice) failures.push("voice button missing");
    if (failures.length) {
      throw new Error(`main layout assertions failed:\n- ${failures.join("\n- ")}\ntext=${baseLayout.text}`);
    }
    await cdp.screenshot(path.join(outputDir, "main-layout.png"));

    const openedBridge = await cdp.evaluate(`(() => {
      const button = document.querySelector('#bridgeBar');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assertOk(openedBridge, "bridge panel button was not clickable");
    const bridgeSnapshot = await waitFor(cdp, `(() => {
      const panel = document.querySelector('#bridgePanel');
      const text = panel?.textContent || '';
      if (!panel || !text.includes('飞书测试联系人')) return null;
      const contact = Array.from(panel.querySelectorAll('div')).find((el) => (el.textContent || '').trim() === '飞书测试联系人');
      if (!contact) return null;
      return { text, contactFound: true };
    })()`, 15000, "cleared Feishu contact remains visible");
    assertOk(bridgeSnapshot?.contactFound, `cleared Feishu contact was hidden: ${JSON.stringify(bridgeSnapshot)}`);
    const openedBridgeContact = await cdp.evaluate(`(() => {
      const panel = document.querySelector('#bridgePanel');
      const contact = Array.from(panel?.querySelectorAll('div') || []).find((el) => (el.textContent || '').trim() === '飞书测试联系人');
      if (!contact) return false;
      contact.click();
      return true;
    })()`);
    assertOk(openedBridgeContact, "cleared Feishu contact was not clickable");
    const clearedBridgeSnapshot = await waitFor(cdp, `(() => {
      const panel = document.querySelector('#bridgePanel');
      const text = panel?.textContent || '';
      return text.includes('上下文已清除') && text.includes('下一条消息会开启新对话')
        ? { text }
        : null;
    })()`, 15000, "cleared Feishu context guidance");
    assertOk(clearedBridgeSnapshot, "cleared Feishu context guidance was missing");
    await cdp.screenshot(path.join(outputDir, "bridge-cleared-context.png"));
    await cdp.evaluate(`document.querySelector('#bridgePanel button[class*="floatingPanelClose"]')?.click()`);

    const openedMore = await cdp.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="更多输入选项"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assertOk(openedMore, "more input options button was not clickable");
    const moreSnapshot = await waitFor(cdp, `(() => {
      const menu = document.querySelector('[role="menu"][aria-label="更多输入选项"]');
      if (!menu) return null;
      const rectOf = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const deepResearch = Array.from(menu.querySelectorAll('button')).find((el) => (el.textContent || '').includes('深度调研'));
      const execMode = Array.from(menu.querySelectorAll('button')).find((el) => {
        const text = el.textContent || '';
        return text.includes('执行模式') || text.includes('security.mode.');
      });
      if (!deepResearch || !execMode) return null;
      return {
        menu: rectOf(menu),
        deepResearch: rectOf(deepResearch),
        execMode: rectOf(execMode),
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    })()`, 15000, "composer more menu controls");
    for (const [name, rect] of [["moreMenu", moreSnapshot.menu], ["deepResearch", moreSnapshot.deepResearch], ["execMode", moreSnapshot.execMode]]) {
      assertOk(rect && rect.width >= 28 && rect.height >= 20, `${name} missing or too small: ${JSON.stringify(rect)}`);
      assertOk(rect.left >= -2 && rect.right <= moreSnapshot.viewport.width + 2, `${name} clipped horizontally: ${JSON.stringify(rect)}`);
      assertOk(rect.top >= -2 && rect.bottom <= moreSnapshot.viewport.height + 2, `${name} clipped vertically: ${JSON.stringify(rect)}`);
    }
    await cdp.screenshot(path.join(outputDir, "composer-more-menu.png"));
    await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

    const typed = await cdp.evaluate(`(() => {
      const el = document.querySelector('#inputBox');
      if (!el) throw new Error('inputBox not found');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, 'GUI installed gate 输入栏测试');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
      return { value: el.value, active: document.activeElement === el };
    })()`);
    assertOk(typed?.value === "GUI installed gate 输入栏测试", `composer did not retain typed text: ${JSON.stringify(typed)}`);
    assertOk(typed?.active === true, "composer did not receive focus");

    const openedModelDropdown = await cdp.evaluate(`(() => {
      const button = document.querySelector('[class*="model-pill"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assertOk(openedModelDropdown, "model dropdown button was not clickable");
    const modelSnapshot = await waitFor(cdp, `(() => {
      const dropdown = document.querySelector('[class*="model-dropdown"]');
      const text = document.body.innerText || '';
      if (!dropdown || !text.includes('DeepSeek V4 Flash') || !text.includes('DeepSeek V4 Pro')) return null;
      const r = dropdown.getBoundingClientRect();
      return {
        opened: true,
        text,
        dropdown: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    })()`, 60000, "DeepSeek models in opened selector");
    assertOk(modelSnapshot.opened, `model dropdown did not open: ${JSON.stringify(modelSnapshot)}`);
    assertOk(String(modelSnapshot.text || "").includes("DeepSeek V4 Flash"), "model dropdown missing DeepSeek V4 Flash");
    assertOk(String(modelSnapshot.text || "").includes("DeepSeek V4 Pro"), "model dropdown missing DeepSeek V4 Pro");
    assertOk(!String(modelSnapshot.text || "").includes("127.0.0.1:null"), "model dropdown exposed invalid server URL");
    if (modelSnapshot.dropdown) {
      assertOk(modelSnapshot.dropdown.left >= -2 && modelSnapshot.dropdown.right <= modelSnapshot.viewport.width + 2,
        `model dropdown clipped horizontally: ${JSON.stringify(modelSnapshot.dropdown)}`);
    }
    await cdp.screenshot(path.join(outputDir, "model-dropdown.png"));

    const popoverSnapshot = await cdp.evaluate(`(async () => {
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(escape);
      const clickText = (...needles) => {
        const btn = Array.from(document.querySelectorAll('button')).find((el) => {
          const text = el.textContent || '';
          return needles.some((needle) => text.includes(needle));
        });
        if (!btn) return false;
        btn.click();
        return true;
      };
      const moreButton = document.querySelector('button[aria-label="更多输入选项"]');
      if (moreButton) moreButton.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const clickedResearch = clickText('深度调研');
      await new Promise((resolve) => setTimeout(resolve, 150));
      const researchVisible = !!document.querySelector('[class*="deep-research-card"]');
      document.querySelector('button[aria-label="关闭深度调研引导"]')?.click();
      if (moreButton?.getAttribute('aria-expanded') !== 'true') moreButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const clickedExec = clickText('执行模式', 'security.mode.');
      await new Promise((resolve) => setTimeout(resolve, 300));
      const text = document.body.innerText || '';
      return { clickedResearch, researchVisible, clickedExec, text };
    })()`);
    assertOk(popoverSnapshot.clickedResearch && popoverSnapshot.researchVisible, "deep research launcher did not open its guide");
    assertOk(popoverSnapshot.clickedExec, "execution mode button was not clickable");
    assertOk(/自动|快速|深研|执行模式/.test(String(popoverSnapshot.text || "")), "mode popovers did not leave expected UI text");
    await cdp.screenshot(path.join(outputDir, "mode-popovers.png"));

    await cdp.evaluate(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const more = document.querySelector('button[aria-label="更多输入选项"]');
      if (more?.getAttribute('aria-expanded') === 'true') more.click();
      const input = document.querySelector('#inputBox');
      window.__lynnTemplateMessagesBefore = document.querySelectorAll('[class*="userMessage"]').length;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '/novel');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    })()`);
    await waitFor(cdp, `!!document.querySelector('[class*="slash-menu-item"]')`, 15000, "explicit novel template");
    await cdp.evaluate(`document.querySelector('[class*="slash-menu-item"]').click()`);
    const templateSnapshot = await waitFor(cdp, `(() => {
      const value = document.querySelector('#inputBox')?.value || '';
      if (value.length < 20 || value.startsWith('/novel')) return null;
      return { value, menuClosed: !document.querySelector('[class*="slash-menu-item"]'),
        notSent: document.querySelectorAll('[class*="userMessage"]').length === window.__lynnTemplateMessagesBefore };
    })()`, 15000, "editable template without sending");
    assertOk(templateSnapshot.menuClosed && templateSnapshot.notSent, "template did not remain an editable unsent draft");
    await cdp.screenshot(path.join(outputDir, "slash-template.png"));

    const smokeUrl = new URL(page.url);
    smokeUrl.searchParams.set("uiSmoke", "1");
    await cdp.call("Page.navigate", { url: smokeUrl.href });
    await waitFor(cdp, `(() => document.readyState === 'complete' && window.__lynnUiSmokeReady === true && !!document.querySelector('#inputBox'))()`, 60000, "ui smoke mode");
    await cdp.evaluate(`window.__lynnSetUiSmokeScenario('image-tool-empty')`);
    await waitFor(cdp, `document.body.dataset.uiSmokeScenario === 'image-tool-empty'`, 15000, "image tool empty smoke scenario");
    const seededEditText = "UI_SMOKE_IMAGE_TOOL：请看这张图并总结要点。";
    const editResendSnapshot = await waitFor(cdp, `(() => {
      const bodyText = document.body.innerText || '';
      if (!bodyText.includes(${JSON.stringify(seededEditText)})) return null;
      if (!bodyText.includes('image_analyze')) return null;
      const editButton = Array.from(document.querySelectorAll('button')).find((el) => (el.textContent || '').includes('编辑重发'));
      if (!editButton) return null;
      return { ready: true, text: bodyText.slice(0, 2000) };
    })()`, 60000, "seeded image-tool history with edit-resend button");
    assertOk(editResendSnapshot?.ready, "seeded image-tool history was not visible");
    const editClicked = await cdp.evaluate(`(() => {
      const editButton = Array.from(document.querySelectorAll('button')).find((el) => (el.textContent || '').includes('编辑重发'));
      if (!editButton) return false;
      editButton.click();
      return true;
    })()`);
    assertOk(editClicked, "edit-resend button for seeded image-tool turn was not clickable");
    const editLoaded = await waitFor(cdp, `(() => {
      const el = document.querySelector('#inputBox');
      const text = document.body.innerText || '';
      const value = el?.value || '';
      return value.includes(${JSON.stringify(seededEditText)})
        ? { value, text: text.slice(0, 2000) }
        : null;
    })()`, 15000, "edit-resend restored seeded prompt into composer");
    assertOk(String(editLoaded?.value || "").includes(seededEditText), `edit-resend did not restore original prompt: ${JSON.stringify(editLoaded)}`);
    const editErrorText = String(editLoaded?.text || "");
    assertOk(!/Agent is already processing|error|无法定位要编辑的历史消息/.test(editErrorText),
      `edit-resend surfaced an error for image-tool history: ${editErrorText}`);
    await cdp.screenshot(path.join(outputDir, "edit-resend-image-tool.png"));

    console.log(`[packaged-main-ui-smoke] main UI ok: ${path.relative(ROOT, appPath)} screenshots=${path.relative(ROOT, outputDir)}`);
  } finally {
    cdp?.close();
    await terminate(child);
    await rmRetry(tmp);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
