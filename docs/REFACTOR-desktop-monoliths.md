# Desktop 巨石拆解规划

> 目标:把不可测的巨石拆成**框架无关的纯逻辑模块(可单测)+ 薄的 Electron/React 胶水**。
> 不可测的根因:纯逻辑和框架绑定(Electron `app`/IPC、React render)揉在一起。**抽出纯逻辑 = 立刻可测。**
> 已验证的范式:`desktop/browser-url-guard.cjs` —— 把 main.cjs 里 1 个不可测内联函数抽成 **6 单测**的模块(commit `a8270d1`)。
> 状态迁移细案见 [`docs/REFACTOR-desktop-state-migration.md`](./REFACTOR-desktop-state-migration.md):server-process / browser-agent / IPC 各自的状态 owner、迁移顺序和门禁。

## 0. 实测巨石排行(源码,排 bundle/dist)

| 文件 | 行数 | 类型 |
|---|---|---|
| **`desktop/main.cjs`** | **4322** | Electron 主进程 god-object(头号) |
| `src/react/components/InputArea.tsx` | 1379 | React 输入区 god-component |
| `src/react/settings/tabs/McpTab.tsx` | 1109 | 设置 MCP 页 |
| `src/.../providers/ProviderDetail.tsx` | 1039 | 设置 provider 详情 |
| `desktop/model-downloader.cjs` | 914 | 主进程模型下载 |
| `src/react/components/chat/ReviewCard.tsx` | 843 | 评审卡片 |
| `src/.../chat/AssistantMessage.tsx` | 816 | 助手消息渲染 |
| `src/react/components/AutomationPanel.tsx` | 714 | 自动化面板 |
| `src/react/components/SessionList.tsx` | 710 | 会话列表 |
| `src/react/hooks/use-stream-buffer.ts` | 685 | 流式缓冲 hook |
| `src/react/services/ws-message-handler.ts` | 575 | WS 消息分发 |
| `src/react/stores/channel-actions.ts` | 568 | 频道动作 |

---

## 1. main.cjs(4322 行)拆解 —— 头号工程

### 诊断(按实测区段)
70 个 IPC handler + ~12 个 concern 揉在一个文件:

| 行范围 | concern | 抽成 |
|---|---|---|
| 248-866 | 主进程 i18n | `main-i18n.cjs` |
| 867-1359 | **Server 进程生命周期**(检测复用 / 启动 brain server / port·token) | `server-process.cjs` |
| 1361-1869 | 窗口工厂(startup/main/settings/skill-overlay/browser-viewer) | `windows/*.cjs` |
| **1870-2451** | **浏览器 agent**(`SNAPSHOT_SCRIPT` + `handleBrowserCommand` + `WebContentsView` 管理 + `/internal/browser` WS,~580 行) | `browser-agent.cjs`(+ 已抽的 `browser-url-guard.cjs`) |
| 2452-2522 | Onboarding 窗口 | `windows/onboarding.cjs` |
| 2523-2856 / 2857-3401 / 3402-3471 | IPC handlers(通用 / skill 预览 / 窗口控制) | `ipc/*.cjs`(按域分组,register 函数) |
| 3472-3512 | Voice tunnel | `voice-tunnel-ipc.cjs`(已有 `voice-tunnel-manager.cjs`,补 IPC 层) |
| 3513-3966 | 文件访问授权 / confirm-action 审批 / 其它 | `file-access-grants.cjs` + `confirm-action.cjs` |
| 3967-4308 | App 生命周期 / 全局快捷键 / 优雅关闭 | `lifecycle.cjs` |
| 4309+ | 全局错误兜底 | `crash-guard.cjs` |

### 目标形态
`main.cjs` → **~200 行 bootstrap**:`require` 各模块 + 注入依赖 + 注册 IPC。每个 concern 独立模块,纯逻辑部分(URL 守卫 / DOM 简化 / port 解析 / locale 解析)做成**框架无关、可单测**。

### 抽取顺序(按 安全×ROI,叶子优先)
1. ✅ `browser-url-guard.cjs`(已做,范式)
2. **纯逻辑叶子**(零 Electron 依赖,直接可测):`SNAPSHOT_SCRIPT` 的 DOM 简化逻辑 → `browser-snapshot.cjs`;`_resolveLocaleKey`/i18n 解析 → `main-i18n.cjs`;port/token 解析。
3. **自包含子系统**:`browser-agent.cjs`(handleBrowserCommand 整块,注入 `getActiveView()`)、`server-process.cjs`。
4. **IPC 分组**:`ipc/browser.cjs` `ipc/skill.cjs` `ipc/window.cjs` `ipc/editor.cjs` —— 每个导出 `register(ipcMain, deps)`,main 里依次调。
5. **窗口工厂**:`windows/` 一窗一文件。
6. **生命周期 / 错误兜底**:最后(最贴 Electron)。

### 风险控制(铁律)
- **搬运不改写**:抽取时只移动,不动逻辑;一个 concern 一个 commit。
- 每 commit:`node --check desktop/main.cjs` + `cli-pty-smoke` + `cli-terminal-ime-smoke` 不回归。
- 抽出的纯逻辑**当场补单测**(像 url-guard 那样)。
- bundle(`main.bundle.cjs`)由构建再生,不手改。

---

## 2. React/逻辑巨石(GUI 渲染层)

拆法和 main.cjs 不同:**god-component → 容器 + 展示子组件 + 自定义 hook(逻辑)+ 纯 util(可测)**。

| 巨石 | 拆解 |
|---|---|
| `InputArea.tsx` (1379) | 抽 `useInputDraft`/`useSlashPalette`/`useAttachments` hooks + `<SlashPalette>`/`<AttachmentBar>`/`<SendControls>` 子组件 + 纯 util(草稿/快捷键解析,可测) |
| `McpTab.tsx` (1109) / `ProviderDetail.tsx` (1039) | 表单逻辑抽 hook + 校验/序列化纯函数(可测)+ 拆分区块子组件 |
| `ReviewCard` (843) / `AssistantMessage` (816) | 渲染拆子组件;解析/格式化逻辑(markdown/工具结果)抽纯 util 测 |
| `AutomationPanel` (714) / `SessionList` (710) | 列表/筛选/排序逻辑抽 hook + 纯函数;行渲染拆子组件 |
| `use-stream-buffer.ts` (685) | 按事件类型拆成小 reducer/handler;**缓冲合并逻辑是纯函数 → 重点补测** |
| `ws-message-handler.ts` (575) | 巨型 switch 按 `msg.type` 拆成 `handlers/<type>.ts` 表驱动;每个 handler 纯函数可测 |
| `channel-actions.ts` (568) | 按动作域拆;状态变更纯 reducer 可测 |
| `model-downloader.cjs` (914) | 主进程:把"下载进度/校验/断点续传"纯逻辑从 Electron 胶水抽出,单测 |

---

## 3. 排序建议(整体)
1. **main.cjs 的纯逻辑叶子 + browser-agent + server-process**(后端胶水,影响面清晰、最该先稳)。
2. **`ws-message-handler` + `use-stream-buffer`**(逻辑巨石,表驱动 + 纯 reducer,ROI 高且测得动)。
3. **React god-components**(InputArea 等,UI 拆分,验证靠 GUI 冒烟,慢但安全)。

## 4. 一句话原则
**巨石不可测,是因为纯逻辑被 Electron/React 绑死。每抽一块纯逻辑出来配单测,main.cjs/god-component 就薄一分、可测一分。** `browser-url-guard.cjs`(1 函数 → 6 测)就是模板,照它滚。
