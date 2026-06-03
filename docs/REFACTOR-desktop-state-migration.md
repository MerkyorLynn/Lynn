# Desktop 状态迁移设计(server-process / browser / IPC)

> 目标:把 `desktop/main.cjs` 从 Electron 主进程 god-object 拆成几个有明确状态所有权的模块。本文只描述**状态怎么迁移**和**每一步怎么验收**,不在拆分时顺手改行为。

## 0. 当前事实

截至本轮,`desktop/main.cjs` 已从 4322 行降到约 4036 行,已有三块可复用范式:

| 模块 | 状态 |
|---|---|
| `desktop/browser-url-guard.cjs` | 已抽出浏览器 URL / SSRF 守卫,有单测 |
| `desktop/browser-snapshot.cjs` | 已抽出 DOM snapshot 脚本 |
| `desktop/main-i18n.cjs` | 已抽出主进程 i18n |
| `desktop/ipc-wrapper.cjs` | 已有 IPC handler 包装和 sender validator |

剩余难点不是“代码搬到哪个文件”,而是 `main.cjs` 里还有多份跨 concern 的状态:

| 状态 | 当前 owner | 目标 owner |
|---|---|---|
| `serverProcess`, `serverPort`, `serverToken`, `reusedServerPid` | `main.cjs` 全局 | `server-process.cjs` |
| `_serverLogs`, restart / heartbeat counters / timers | `main.cjs` 全局 | `server-process.cjs` |
| `_browserViews`, `_browserWebView`, `_currentBrowserSession` | `main.cjs` 全局 | `browser-agent.cjs` |
| `browserViewerWindow`, browser theme / bounds | `main.cjs` 窗口层 + browser 层混在一起 | 第一阶段留窗口 owner,第二阶段注入给 `browser-agent.cjs` |
| 70+ IPC handlers | `main.cjs` 直接注册并闭包全局状态 | `ipc/*.cjs` register 函数,只拿 controller 依赖 |
| confirm-action pending request | `main.cjs` IPC handler 内部 | `confirm-action.cjs` |
| file access grants / file watchers | `main.cjs` 全局 | `file-access-grants.cjs` + `file-ipc.cjs` |

核心原则:**状态只能有一个 owner。IPC 不拥有业务状态,只调用 owner 暴露的方法。**

---

## 1. `server-process.cjs` 状态迁移

### 1.1 当前状态边界

当前 server concern 主要散在:

- `serverPort`, `serverToken` 全局变量。
- `startServer()` 负责复用旧 server、kill 旧进程、spawn 新 server、注入环境、轮询 `server-info.json`。
- `monitorServer()` 负责进程 exit 后重启。
- `startServerHeartbeat()` / `checkServerHeartbeat()` 负责健康检查和心跳重启。
- `notifyRendererServerRestarted()` 直接触达 `mainWindow` / `settingsWindow`。
- `get-server-port` / `get-server-token` IPC 直接读全局变量。
- `shouldAttachLocalAuthHeader()` / `ensureLocalAuthHeaderHook()` 依赖 `serverPort/serverToken` 给本地资源加认证头。
- `will-quit` / shutdown 路径用 `serverPort/serverToken` 调 `/api/shutdown`。

### 1.2 目标模块

新模块建议:

```js
// desktop/server-process.cjs
function createServerProcessController(deps) {
  return {
    start,
    monitor,
    startHeartbeat,
    stopHeartbeat,
    shutdown,
    getState,
    getPort,
    getToken,
    getLogs,
    isLocalServerUrl,
    attachLocalAuthHeader,
  };
}

module.exports = { createServerProcessController };
```

`deps` 只注入外部资源:

| dep | 说明 |
|---|---|
| `app`, `dialog`, `fetch`, `spawn`, `fs`, `path`, `process` | Electron / Node 能力 |
| `lynnHome`, `resourcesPath`, `dirname` | 路径上下文 |
| `mt`, `writeCrashLog`, `killPid` | 现有辅助 |
| `getWorkerSpawnServerEnv`, `readBrainRuntimeConfig` | 环境配置 |
| `onServerRestarted(state)` | 回调,由 main 决定通知哪些窗口 |
| `onLocalAuthHeaderNeeded()` | 回调或直接由 controller 管 webRequest hook |

模块内部状态:

```js
const state = {
  process: null,
  port: null,
  token: null,
  reusedPid: null,
  logs: [],
  startedAt: 0,
  restartAttempts: 0,
  heartbeatTimer: null,
  heartbeatFailures: 0,
  heartbeatChecking: false,
  heartbeatRestarting: false,
  startPromise: null,
};
```

### 1.3 迁移步骤

**Step S1:抽纯逻辑,不接线**

先把以下函数搬成可测纯函数:

- `isReusableServerHealth(health, expectedVersion)`
- `resolveBundledServerLaunch({ platform, resourcesPath, dirname })`
- `injectWindowsGitPath(env, resourcesPath, existsSync)`
- `resolveAecNativeDir({ dirname, existsSync })`
- `readServerInfo(path, fs)` / `isPidAlive(pid, process)`

验收:

- 对 version / feature mismatch 写单测。
- 对 Windows PATH key 大小写写单测。
- `node --check desktop/main.cjs` 仍过。

**Step S2:搬 `startServer()` 到 controller,main 保留代理变量**

第一刀不删 `serverPort/serverToken`,避免全仓一次性大 diff:

```js
const server = createServerProcessController(...);
async function startServer() {
  await server.start();
  const state = server.getState();
  serverPort = state.port;
  serverToken = state.token;
}
```

这样旧 IPC / shutdown / browser WS 仍可读旧变量,但状态真实 owner 已是 controller。

验收:

- reuse old server 行为不变。
- new server spawn 行为不变。
- `server-restarted` payload 仍 `{ port, token }`。

**Step S3:heartbeat / monitor 迁入 controller**

`monitorServer`, `startServerHeartbeat`, `stopServerHeartbeat`, `checkServerHeartbeat` 全部进入 controller。main 只调用:

```js
await server.start();
server.monitor();
server.startHeartbeat();
```

`notifyRendererServerRestarted` 改成 deps callback:

```js
onServerRestarted({ port, token }) {
  for (const win of [mainWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send("server-restarted", { port, token });
  }
}
```

验收:

- heartbeat 重启后 renderer 仍收到 `server-restarted`。
- heartbeat timer 在 quit 时关闭。
- server exit 正常退出不弹错误。

**Step S4:删除旧全局读法**

替换所有 `serverPort/serverToken` 直接读:

- `get-server-port` → `server.getPort()`
- `get-server-token` → `server.getToken()`
- browser WS → `server.getState()`
- local auth header → `server.attachLocalAuthHeader(session.defaultSession)`
- shutdown → `server.shutdown()`

完成后 main 不再声明 `serverPort/serverToken`。

### 1.4 不变量

- 不能改变 `server-info.json` 格式。
- 不能改变 `/api/health` 判定规则。
- 不能改变复用旧 server 的优先级。
- 不能改变 server env 注入(`LYNN_HOME`, Brain env, AEC native dir, Windows MinGit PATH)。
- 不能改变 renderer 看到的 IPC channel 和 payload。

### 1.5 门禁

每个 server-process commit 至少跑:

```bash
node --check desktop/main.cjs
node --check desktop/server-process.cjs
npm run test -- --runInBand desktop/__tests__/server-process*.test.*
```

若该仓没有 desktop test script,至少补纯函数单测并跑现有 desktop vitest 入口。合并前再跑一次 GUI smoke。

---

## 2. `browser-agent.cjs` 状态迁移

### 2.1 当前状态边界

当前 browser concern 主要散在:

- `_browserViews = new Map()` 按 `sessionPath` 保存挂起 `WebContentsView`。
- `_browserWebView` 当前活跃 view。
- `_currentBrowserSession` 当前 session key。
- `browserViewerWindow` 和 `_browserViewerTheme` 属窗口层,但 browser action 会直接引用。
- `handleBrowserCommand(cmd, params)` 处理 `launch / close / suspend / resume / navigate / snapshot / screenshot / click / type / scroll / select / pressKey / wait / evaluate / show / destroyView`。
- `setupBrowserCommands()` 连接 `ws://127.0.0.1:${serverPort}/internal/browser`,收到 `browser-cmd` 后调用 `handleBrowserCommand`。
- IPC `open-browser-viewer`, `browser-go-back`, `browser-go-forward`, `browser-reload`, `browser-emergency-stop`, `close-browser-viewer` 直接读 `_browserWebView` 和窗口全局。

已经抽出的边界:

- `browser-url-guard.cjs`:URL / SSRF 守卫。
- `browser-snapshot.cjs`:DOM snapshot script。

### 2.2 目标模块

```js
// desktop/browser-agent.cjs
function createBrowserAgentController(deps) {
  return {
    handleCommand,
    setupCommandSocket,
    dispose,
    openViewer,
    closeViewer,
    emergencyStop,
    goBack,
    goForward,
    reload,
    getState,
  };
}

module.exports = { createBrowserAgentController };
```

`deps`:

| dep | 说明 |
|---|---|
| `WebContentsView`, `session` | Electron browser primitives |
| `createBrowserViewerWindow`, `getBrowserViewerWindow`, `attachView`, `detachView`, `updateViewerBounds` | 窗口胶水,第一阶段从 main 注入 |
| `isAllowedBrowserUrl`, `SNAPSHOT_SCRIPT` | 已抽纯逻辑 |
| `getServerState` | 返回 `{ port, token }`,不直接读 main 全局 |
| `isQuitting` | 判断 WS 是否重连 |
| `logBrowserCommand` | browser-cmd audit log |

模块内部状态:

```js
const state = {
  views: new Map(),
  activeView: null,
  currentSession: null,
  commandSocket: null,
  reconnectTimer: null,
};
```

### 2.3 迁移步骤

**Step B1:抽 browser controller,保留窗口函数在 main**

先把 `_browserViews`, `_browserWebView`, `_currentBrowserSession`, `_ensureBrowser`, `_delay`, `handleBrowserCommand` 搬入 `browser-agent.cjs`。

`createBrowserViewerWindow`, `_updateBrowserViewBounds`, `_notifyViewerUrl` 暂时留 main,以 deps 形式注入。这样 browser action 逻辑归 controller,窗口生命周期还不动。

main 变成:

```js
const browserAgent = createBrowserAgentController({
  WebContentsView,
  session,
  createBrowserViewerWindow,
  getBrowserViewerWindow: () => browserViewerWindow,
  attachViewToViewer,
  detachViewFromViewer,
  updateBrowserViewBounds,
  notifyViewerUrl,
  getServerState: () => server.getState(),
  isQuitting: () => isQuitting,
});
```

验收:

- `navigate` 后 snapshot 结构不变。
- `click/type/scroll/select/pressKey` 行为不变。
- `suspend/resume` 保留 per-session view。

**Step B2:WS command bridge 迁入 controller**

`setupBrowserCommands()` 进入 controller,依赖 `getServerState()`。main 只在 server ready 后:

```js
browserAgent.setupCommandSocket();
```

验收:

- server restart 后能重连 browser WS。
- `browser-result` 成功 / error payload 不变。
- `_bLog` 行为不变或迁成注入的 logger。

**Step B3:浏览器 IPC 迁入 `ipc/browser-ipc.cjs`**

把这些 IPC 移出 main:

- `open-browser-viewer`
- `browser-go-back`
- `browser-go-forward`
- `browser-reload`
- `close-browser-viewer`
- `browser-emergency-stop`

模块只注册 handler:

```js
function registerBrowserIpc({ wrapIpcHandler, browserAgent }) {
  wrapIpcHandler("open-browser-viewer", (_event, theme) => browserAgent.openViewer(theme));
  wrapIpcHandler("browser-go-back", () => browserAgent.goBack());
  ...
}
```

验收:

- channel 名不变。
- renderer 不改 preload。
- emergency stop 仍销毁 active view 并发 `browser-update { running:false }`。

**Step B4:可选迁窗口胶水**

最后再考虑把 `browserViewerWindow` 工厂迁到 `windows/browser-viewer.cjs`。这一步不要和 B1/B2 同 commit,因为窗口生命周期最容易引入 GUI 回归。

### 2.4 不变量

- `SNAPSHOT_SCRIPT` `MAX_TREE = 30000` 不变。
- URL 守卫默认继续挡 localhost / private IP / metadata IP,逃生口仍是 `LYNN_BROWSER_ALLOW_PRIVATE=1`。
- `evaluate` 4000 字符上限和 audit log 不变。
- `LYNN_BROWSER_EVAL_DENY_SENSITIVE=1` 的敏感存储拒绝不变。
- Browser session partition 仍为 `persist:hana-browser`,不破坏登录态。
- 不在这次拆分里新增 per-action approval 或改变 approval 策略。

### 2.5 门禁

```bash
node --check desktop/main.cjs
node --check desktop/browser-agent.cjs
node --check desktop/ipc/browser-ipc.cjs
npm run test -- desktop/__tests__/browser-url-guard.test.*
npm run test -- desktop/__tests__/browser-snapshot*.test.* # 如果已加
```

若补 controller fake tests,模拟 `webContents.executeJavaScript`,验证 `navigate/click/type/snapshot` 调用顺序和返回 shape。

---

## 3. IPC 状态迁移

### 3.1 当前问题

`main.cjs` 的 IPC handler 不是简单“路由表”,它们直接闭包读取全局状态,例如:

- server IPC 读 `serverPort/serverToken`。
- browser IPC 读 `_browserWebView/_browserViews/_currentBrowserSession`。
- file IPC 调 `canReadPath/canWritePath/grantWebContentsAccess`。
- window IPC 操作 `mainWindow/settingsWindow/editorWindow/browserViewerWindow`。
- model downloader IPC 操作下载器实例。
- confirm-action handler 自己管理 pending response。

如果直接按文件名搬 handler,只会把全局依赖藏进 require,不会真正解耦。

### 3.2 目标结构

建议目录:

```text
desktop/ipc/
  server-ipc.cjs
  browser-ipc.cjs
  window-ipc.cjs
  editor-ipc.cjs
  file-ipc.cjs
  skill-viewer-ipc.cjs
  settings-ipc.cjs
  notification-ipc.cjs
  local-model-ipc.cjs
  confirm-action.cjs
```

每个文件只导出一个注册函数:

```js
function registerServerIpc({ wrapIpcHandler, server, app, getCliEnvStatus }) {
  wrapIpcHandler("get-server-port", () => server.getPort());
  wrapIpcHandler("get-server-token", () => server.getToken());
  wrapIpcHandler("get-app-version", () => app.getVersion());
  wrapIpcHandler("cli:status", () => getCliEnvStatus());
}
```

### 3.3 迁移步骤

**Step I1:建立 channel inventory**

先产出一张 channel 表,不要改逻辑:

| channel | domain | owner controller | payload 是否变 |
|---|---|---|---|
| `get-server-port` | server | `server-process` | 不变 |
| `open-browser-viewer` | browser | `browser-agent` / `windows` | 不变 |
| `read-file` | file | `file-access-grants` | 不变 |
| `confirm-action` | approval | `confirm-action` | 不变 |

验收:文档或测试里记录 channel 数量,防漏。

**Step I2:先搬只读 / 状态类 IPC**

低风险 first cut:

- `get-server-port`
- `get-server-token`
- `get-app-version`
- `cli:status`
- `wake-lock-state`
- `check-update`
- `get-platform`
- `window-is-maximized`

这些 handler 基本不写状态,适合作为 IPC 模块范式。

**Step I3:搬 browser IPC**

依赖 B3,使用 `browserAgent` 方法,不直接碰 `_browserWebView`。

**Step I4:搬 file / skill IPC**

先抽 file access owner:

```js
const fileAccess = createFileAccessController({ fs, path, shell, dialog, lynnHome });
```

然后 `file-ipc.cjs` 只调用:

- `fileAccess.canRead(event.sender, filePath)`
- `fileAccess.canWrite(event.sender, filePath)`
- `fileAccess.grant(event.sender, filePath, mode)`

**Step I5:confirm-action 单独抽**

`confirm-action` 有自己的 pending response / timeout / sender validation。应抽成:

```js
function createConfirmActionController({ ipcMain, mt }) {
  return { request(webContents, opts) };
}
```

`registerConfirmActionIpc` 只把 IPC 请求转给 controller。

**Step I6:窗口 / 生命周期最后搬**

窗口控制涉及 `BrowserWindow.fromWebContents`, preferred primary window, tray, global shortcut, quit flow,最贴 Electron。放最后,避免早期拆分时行为难测。

### 3.4 IPC 不变量

- IPC channel 名不变。
- renderer payload shape 不变。
- `preload.cjs` 第一阶段不改。
- `setIpcSenderValidator` 继续集中生效。
- 所有新 register 函数都通过 `wrapIpcHandler` / `wrapIpcOn`,不直接裸 `ipcMain.handle`。
- IPC 文件本身不保存跨请求业务状态,除非该状态天然属于该域(`confirm-action` pending map)。

### 3.5 IPC 测试设计

不要等 Electron app 起起来才发现 channel 漏了。给每个 IPC 模块加轻量注册测试:

```js
function createRecorder() {
  const handlers = new Map();
  return {
    wrapIpcHandler(name, fn) { handlers.set(name, fn); },
    wrapIpcOn(name, fn) { handlers.set(`on:${name}`, fn); },
    handlers,
  };
}
```

断言:

- 期望 channel 都注册。
- handler 调到对应 fake controller。
- 对非法 sender / path 返回值不变。

---

## 4. 推荐提交顺序

每一刀都要能独立回滚:

1. `refactor(desktop): document state migration plan`
2. `refactor(desktop): extract server process pure helpers`
3. `refactor(desktop): move server start into controller with main proxies`
4. `refactor(desktop): move server heartbeat and monitor into controller`
5. `refactor(desktop): replace server globals with controller getters`
6. `refactor(desktop): move browser command handling into controller`
7. `refactor(desktop): move browser command websocket into controller`
8. `refactor(desktop): register browser ipc through browser controller`
9. `refactor(desktop): move readonly ipc handlers into ipc modules`
10. `refactor(desktop): move file access and confirm-action ipc`

任何一步如果需要同时改 server、browser、IPC 三域,说明切得太大,应该退回重切。

---

## 5. 每步通用门禁

最低门禁:

```bash
node --check desktop/main.cjs
for f in desktop/*.cjs desktop/ipc/*.cjs; do [ -f "$f" ] && node --check "$f"; done
```

有测试入口时补:

```bash
npm run test -- desktop/__tests__/browser-url-guard.test.*
npm run test -- desktop/__tests__/browser-snapshot*.test.*
npm run test -- desktop/__tests__/*server-process*.test.*
npm run test -- desktop/__tests__/*ipc*.test.*
```

拆到 browser / window / IPC 后,至少做一次 GUI 冒烟:

- App 能启动。
- Brain server 能复用 / 启动。
- `get-server-port` / `get-server-token` 仍返回值。
- Browser viewer 能 open / navigate / snapshot / emergency stop。
- 设置窗口和主窗口能收到 `server-restarted`。

---

## 6. 禁止项

- 禁止手改 `desktop/main.bundle.cjs`;bundle 只由构建生成。
- 禁止在搬运 commit 里顺手改安全策略、approval 策略、URL 规则或 snapshot 大小。
- 禁止让 IPC 模块通过 `require("../main.cjs")` 反向拿状态。
- 禁止把 controller 设计成全局 singleton;应从 main 作为 composition root 创建并注入依赖。
- 禁止一次性删除 proxy globals;先代理、跑通、再删。

---

## 7. 判断拆分是否成功

成功不是“文件变多”,而是:

1. `main.cjs` 只负责创建 controller、创建窗口、注册 IPC、处理 app lifecycle。
2. server 状态只存在 `server-process.cjs`。
3. browser view 状态只存在 `browser-agent.cjs`。
4. IPC 文件没有业务全局状态。
5. 抽出的纯逻辑都有单测。
6. 任一模块能被 fake deps 单独测试。

做到这些,`main.cjs` 才是真的从 god-object 变成 composition root。
