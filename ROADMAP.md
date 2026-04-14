# Lynn Roadmap — 下一阶段功能规划

> 基于 OpenHanako 用户反馈 + Lynn 差异化定位，优先级从高到低排列。

---

## 1. 工作区文件防丢失

**问题**：OpenHanako 有用户反馈"所有工作区文件全部丢失"（Issue: 所有工作区的所有文件全部丢失）。Lynn 目前没有防护机制，Agent 的 `rm -rf` 或 session 清理逻辑如果出 bug 可能导致数据不可恢复。

**实现方式**：

在 `lib/sandbox/tool-wrapper.js` 的危险操作拦截层加**自动快照**：

1. `tool-wrapper.js` 的 `preflightCommand()` 检测到写操作（`rm`、`mv`、`cp --remove`、`git clean`）时，对目标路径做增量快照
2. 快照存储在 `~/.lynn/snapshots/{agent-id}/{date}/` 下，用 hardlink 去重（`cp -al`），零额外磁盘开销（未修改的文件不占空间）
3. `PreferencesManager` 加 `snapshot.enabled`（默认 true）和 `snapshot.maxDays`（默认 7）配置
4. 每日凌晨 cron（已有 MemoryTicker 的 daily 钩子）清理超过 maxDays 的快照
5. 新增 `restore_snapshot` 工具，Agent 可以帮用户回滚到指定日期的快照
6. 桌面端设置页"安全"tab 加"文件快照"开关 + 快照列表预览

**涉及文件**：
- `lib/sandbox/tool-wrapper.js` — preflightCommand 加快照逻辑
- `core/preferences-manager.js` — 加 snapshot 配置
- `lib/tools/restore-snapshot-tool.js` — 新建恢复工具
- `desktop/src/react/settings/tabs/SecurityTab.tsx` — UI 开关

---

## 2. 跨渠道共享时间线

**问题**：用户在飞书/微信/Telegram 和桌面端的对话是割裂的 session。用户在飞书说的话，桌面端看不到对话气泡，体验不连贯。Lynn 的记忆系统在事实层面有延续，但用户感知缺失。

**实现方式**：

将 Bridge 消息路由到桌面端的 focus session，实现"一个 Agent、一个 session、多个入口"：

1. `core/bridge-session-manager.js` 新增 `unifiedMode` 选项（默认 false，用户可在设置中开启）
2. 开启后，`executeExternalMessage()` 不再创建独立 bridge session，而是：
   - 调用 `sessionCoordinator.promptSession(focusSessionPath, text, { source: platform, bridgeChatId })`
   - 在消息的 metadata 里标记来源平台（`{ bridge: "feishu", chatId: "oc_xxx" }`）
3. `hub/event-bus.js` 监听 session 的输出事件，如果当前 session 有 `bridgeChatId`，同时推送回复到对应的 bridge 平台
4. 桌面端 `ChatArea.tsx` 的消息气泡加来源标签（飞书图标/微信图标），用户能看到"这条是从飞书来的"
5. 离线缓存：桌面端不在线时，bridge 消息存入 `~/.lynn/bridge-queue/{agent-id}.json`，桌面端启动后自动注入
6. `PreferencesManager` 加 `bridge.unifiedSession`（默认 false）配置
7. 设置页"桥接"tab 加"统一会话模式"开关

**涉及文件**：
- `core/bridge-session-manager.js` — 路由到 focus session
- `hub/event-bus.js` — 输出事件回推 bridge
- `desktop/src/react/components/chat/ChatArea.tsx` — 来源标签 UI
- `server/routes/chat.js` — bridge 消息注入 session
- `core/preferences-manager.js` — unifiedSession 配置

---

## 3. 局域网访问

**问题**：用户想在手机/iPad/其他电脑上用 Lynn，但不想配 Telegram/飞书 bridge。OpenHanako 用户也提了这个需求。

**实现方式**：

Lynn 的 server 已经是独立 Node.js 进程 + Hono HTTP + WebSocket，只需要把监听地址从 `127.0.0.1` 改为 `0.0.0.0`，加上认证和一个移动端 Web UI：

1. `server/index.js` 的 `listen()` 加 `host` 参数，`PreferencesManager` 加 `network.lanAccess`（默认 false）
2. 开启后监听 `0.0.0.0:{port}`，同时在本地网络广播 mDNS（`lynn-{agentName}.local`），方便发现
3. 所有 HTTP/WS 请求强制验证 `serverToken`（已有机制），防止局域网其他设备未授权访问
4. 桌面端设置页"网络"tab 加"局域网访问"开关，开启后显示局域网 URL + 二维码（手机扫码直接打开）
5. 新增 `desktop/src/react/mobile/` 目录，用现有的 React 组件做一个简化版移动端 Web UI（只保留聊天 + 桌面文件浏览），通过 `<meta name="viewport">` 适配移动端
6. `server/index.js` 加路由：`/mobile` → 移动端 UI 的 HTML entry
7. 安全：首次从新 IP 访问时弹桌面端确认对话框（类似 SSH 首次连接信任）

**涉及文件**：
- `server/index.js` — listen 地址 + `/mobile` 路由
- `core/preferences-manager.js` — lanAccess 配置
- `desktop/src/react/settings/tabs/NetworkTab.tsx` — 新建网络设置 tab
- `desktop/src/react/mobile/` — 新建移动端 Web UI
- `desktop/main.cjs` — mDNS 广播

---

## 4. ComfyUI / 图片生成集成

**问题**：OpenHanako 用户请求本地 ComfyUI 图片生成功能。当前 Lynn 没有图片生成能力，差异化方向。

**实现方式**：

以 MCP 工具或内置技能的形式集成，不侵入核心架构：

1. 新建技能 `skills2set/comfyui-gen/SKILL.md`，声明 `generate_image` 工具
2. 工具逻辑：
   - 检测本地 ComfyUI 是否运行（`http://127.0.0.1:8188/system_stats`）
   - 如果本地没有 ComfyUI，fallback 到云端免费 API（SiliconFlow 的 `Qwen/Qwen-Image` 或 `stabilityai/stable-diffusion-3.5-large`）
   - 构造 ComfyUI workflow JSON → POST `/prompt` → 轮询结果 → 下载图片到桌面
3. Agent 调用 `generate_image` 时传入文本描述，工具自动选择本地/云端
4. 生成的图片自动放到 Agent 桌面（`desk/`），前端实时显示
5. 设置页"工具"tab 加 ComfyUI 地址配置（默认 `http://127.0.0.1:8188`）

**涉及文件**：
- `skills2set/comfyui-gen/SKILL.md` — 技能定义
- `skills2set/comfyui-gen/tool.js` — generate_image 工具实现
- `lib/default-models.json` — 加 SiliconFlow 图片模型 fallback 配置

---

## 5. 图片放大查看

**问题**：OpenHanako 用户反馈聊天中的图片（生成的、用户发的、工具返回的截图）只有缩略图，无法点击放大查看。当前 Lynn 的 `ChatArea.tsx` 里图片渲染是固定尺寸的 `<img>`，没有 lightbox 交互。

**实现方式**：

在聊天区的图片组件加 lightbox 弹层，不引入第三方库，纯 CSS + React 实现：

1. `desktop/src/react/components/chat/ImageBlock.tsx`（新建）：
   - 缩略图状态：`max-width: 320px`，`cursor: zoom-in`
   - 点击后进入全屏 lightbox：固定定位 `position: fixed; inset: 0; z-index: 9999`，半透明黑色背景
   - 图片居中 `object-fit: contain; max-width: 90vw; max-height: 90vh`
   - 支持鼠标滚轮缩放（`transform: scale()`）和拖拽平移
   - 点击背景或按 ESC 关闭
   - 底部工具栏：放大/缩小/1:1 原始尺寸/下载到桌面
2. `ChatArea.tsx` 中所有 `<img>` 渲染替换为 `<ImageBlock src={url} />`
3. 桌面文件预览（`DeskFilePreview.tsx`）的图片也接入同一个 `ImageBlock` 组件
4. 移动端适配：支持双指捏合缩放（`touch` 事件）

**涉及文件**：
- `desktop/src/react/components/chat/ImageBlock.tsx` — 新建 lightbox 组件
- `desktop/src/react/components/chat/ChatArea.tsx` — 替换 img 渲染
- `desktop/src/react/components/chat/Chat.module.css` — lightbox 样式
- `desktop/src/react/components/desk/DeskFilePreview.tsx` — 桌面预览接入

---

## 6. Linux 支持

**问题**：OpenHanako 标注 Linux "Planned"，Lynn 未提及。Linux 桌面用户群体（开发者为主）和 Lynn 目标用户高度重合。

**实现方式**：

Electron 本身跨平台，核心工作在打包和沙盒适配：

1. `package.json` 的 electron-builder 配置加 Linux target：
   ```json
   "linux": {
     "target": ["AppImage", "deb"],
     "category": "Utility",
     "icon": "assets/icon.png"
   }
   ```
2. `scripts/build-server.mjs` 加 `linux x64` 和 `linux arm64` 的 server bundle 构建
3. 沙盒适配：`lib/sandbox/os-sandbox.js` 的 Linux 分支已有 Bubblewrap 支持（从 OpenHanako 继承），需验证：
   - Bubblewrap (`bwrap`) 是否在主流发行版预装
   - 如果没有，fallback 到纯 PathGuard（应用级沙盒）
4. 系统托盘：Electron 的 `Tray` API 在 Linux 需要 `libappindicator`，加安装检测和提示
5. 自动更新：Linux 没有原生的 auto-updater，用 `electron-updater` 的 AppImage 差量更新
6. CI/CD：GitHub Actions 加 `ubuntu-latest` 构建矩阵，产出 `.AppImage` 和 `.deb`
7. README 加 Linux 安装说明

**涉及文件**：
- `package.json` — electron-builder linux 配置
- `scripts/build-server.mjs` — linux 构建
- `.github/workflows/build.yml` — CI 加 Linux
- `lib/sandbox/os-sandbox.js` — 验证 Bubblewrap
- `README.md` / `README_CN.md` — Linux 安装说明
