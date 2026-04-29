# Lynn Release Regression Gates

目标：发版前同时验证 UI、桌面运行时、Brain/模型链路、工具调用、流式事件、发布资产，避免“发布后马上 hotpatch”。

## 入口

```bash
# 最小阻断门禁：适合 hotpatch 前
npm run test:release:smoke

# 正式发版门禁：默认推荐
npm run test:release

# 桌面 UI smoke：需要先完成 renderer build
npm run test:release:ui

# 一键发版前检查：单测 + 类型 + 构建 + live gate + UI smoke
npm run release:preflight

# 正式 macOS/Windows 打包会先强制执行 release:preflight
npm run dist
npm run dist:win

# 夜间/大版本门禁：含 extended 用例
npm run test:release:nightly
```

默认读取 `~/.lynn/server-info.json` 并连接当前本机 Lynn。开发版可指定：

```bash
LYNN_HOME=~/.lynn-dev npm run test:release
```

报告输出在 `output/release-regression-*/report.md`，同时保存 `static-results.json` 和 `live-results.json`。

## 分层

### Static Gate

不启动模型，直接扫仓库和发布资产：

- `package.json` 必须有 build/test/release manifest 入口。
- `.github/update-manifest.json` 二进制资产不能指 GitHub `.dmg/.exe`，必须走腾讯镜像。
- `site/app.js`、`site/download.html`、`site/index.html` 不能把 `.dmg/.exe` 链到 GitHub。
- 核心 UI 文件必须存在：AssistantMessage、ThinkingBlock、ToolGroupBlock、WritingDiffViewer、TaskModePicker、PressToTalkButton、streaming store。
- WebSocket 事件协议必须保留共享定义：`shared/ws-events.js` / `shared/ws-events.d.ts`。
- 多语言文件必须存在。
- README 必须提到当前 `package.json` 版本。

### Live Gate

通过真实 WebSocket 走 Lynn 当前服务，不裸打模型端点。重点覆盖今天暴露过的问题：

- 首包和 `turn_end` 是否正常。
- 空答、0 token、超时。
- thinking 是否泄露到可见文本。
- `<web_search>`、`<bash>`、`||1read||{}`、`web_search(...)` 等伪工具格式是否泄露。
- 工具请求是否真的 emit `tool_start/tool_end`。
- 工具 turn 后下一 prompt 是否被污染。
- 同一个 WebSocket 内跨轮记忆是否正常。
- 工具失败/工具慢时是否有可见答复。
- 安全边界：系统提示词、密钥、服务器密码不得外泄。
- 长写作、代码、数据分析不应退化为空答或循环。

### Manual UI Gate

自动脚本不能完全替代真实桌面视觉检查。正式发版前必须用打包后的 app 做一次人工 UI 检查：

1. 首屏：会话列表、输入框、模型选择、安全模式、任务模式、语音按钮无重叠。
2. 发送短 prompt：用户消息、助手消息、thinking block、停止按钮状态正确。
3. 发送工具 prompt：工具卡片展开/折叠、失败态、重试态、最终答案都可见。
4. 发送长输出：滚动、代码块、复制按钮、Markdown 表格不遮挡。
5. 触发文件 diff：diff viewer、apply/reject、rollback 可见且不挤压。
6. Settings：Providers、Voice、Bridge、Security 在 1280px 宽度下无截断。
7. Voice：长按录音、权限提示、ASR 插入、TTS 播放状态至少跑一次。
8. Bridge：微信/飞书各跑一条短问答和一条工具问答。

### Electron UI Smoke

`npm run test:release:ui` 会启动真实 Electron 窗口，但使用内置 UI fixture，不连接模型和服务器。它会截图并断言 4 个高风险界面：

- `home`：首屏 / 侧栏 / 标题栏。
- `short`：短问答消息、头像、操作栏。
- `tools`：工具组、工具完成态、文件 diff 卡片。
- `long-code`：长输出、thinking block、代码块、底部操作栏。

截图和结果保存在 `output/ui-smoke-*/`。这一步用于抓 UI 遮挡、空白页、构建入口缺失和核心组件渲染崩溃；真实工具链体验仍由 `npm run test:release` 和人工 UI Gate 覆盖。

## 阻断规则

- `blocker` 失败：禁止发版。
- `critical` 失败：正式发版禁止；hotpatch 必须写明风险并复测相关用例。
- `extended` 失败：不阻断 hotpatch，但大版本发布前必须处理或记录。

## 与 V8/V9 的关系

V8/V9 benchmark 主要衡量模型能力和路由质量；release regression 主要衡量用户会不会遇到坏体验。发版前顺序应是：

1. `npm test`
2. `npm run typecheck`
3. `npm run build:server`
4. `npm run build:main`
5. `npm run build:renderer`
6. `npm run test:release`
7. `npm run test:release:ui`
8. 人工 UI Gate
9. 平台打包、公证、manifest、镜像站更新（`dist` / `dist:win` 会先跑 `release:preflight`）
10. 真实安装包 smoke

不要用裸 `/v1/chat/completions` 结果替代 `test:release`。裸模型端点测不到 Lynn 的 WebSocket、事件解析、UI 渲染、工具卡片和跨 prompt fence。

## 新增用例原则

新增回归用例时必须满足至少一条：

- 复现过真实用户可见 bug。
- 能捕获工具协议、streaming、UI event contract、发布资产中的高风险回归。
- 有明确机器可判定的失败条件。
- 不依赖长时间外部服务，或外部失败时能给出清晰原因。

用例位置：`tests/release-regression/release-regression-cases.mjs`。
