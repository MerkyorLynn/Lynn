# Lynn v0.80.7 CLI / v0.80.2 GUI Release Notes / 发布说明

> 发布日期: 2026-06-03 · CLI 权限语义热修 + GUI server-process 收口

本次发版同步更新 **Lynn CLI v0.80.7** 与 **Lynn GUI v0.80.2**。CLI 侧重点是
headless/Fleet 权限语义、原生工具链与长任务稳定；GUI 侧重点是桌面 Server 进程所有权、
启动自愈门禁和 Lynn 品牌启动页。

## 中文重点

- **授权后 bash 真执行**:交互式 `ask / workspace-write` 里,用户在授权卡片选择
  `y` 或 `a` 后,本次命令会按已确认的 full-access bash 执行,不再出现"已批准但仍被
  workspace sandbox 拦截"的反直觉结果。
- **Fleet/无头命令默认清晰**:无头 worker 建议统一使用
  `--approval yolo --sandbox danger-full-access`;若只写 `--approval yolo` 且未显式给
  sandbox,CLI 会推断为 `danger-full-access`。显式传 `--sandbox workspace-write` 时仍会尊重用户选择。
- **默认交互不变**:`Lynn` / `Lynn code` 面向人类仍默认 `ask / workspace-write`。不想逐次审批时,交互中使用 `/yolo`;Fleet/CI 中使用 yolo + danger-full-access。
- **原生 CLI 工具链**:`web_scan`、`update_working_checkpoint`、技能结晶/召回、`/rewind`
  sidecar 快照、tool ledger、checkpoint/resume、auto-verify 和 Fleet JSONL worker 继续走原生稳定线。
- **GUI server-process 收口**:`desktop/server-process.cjs` 统一持有 server pid、端口、token、日志和重启状态;真 App boot gate 会启动 Electron、等待 server ready、杀掉 server 并验证自动重启与窗口通知。
- **Lynn 品牌启动页**:splash fallback 回到 Lynn,不再退回 Hanako 时代文案或图标。

## 安装

```bash
# 前置: Node.js 20 LTS 或 22 LTS with npm.
node -v

# 从 Lynn 镜像安装或覆盖升级。
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.7.tgz"

# 启动。
Lynn            # 交互式聊天 TUI
Lynn code       # 编码 agent TUI
Lynn --version  # 应输出 0.80.7
Lynn agents     # 给其他智能体/Fleet 的可复制命令
```

默认 Brain 路由: **StepFun 3.7 Flash(256K 上下文, high 推理, 32K 推理/生成预算) -> MiMo V2.5 Pro/Omni -> Spark Qwen 3.6 35B A3B**。纯 CLI 首装在本地 Brain 不可达时会走 Lynn 远端 Brain;BYOK 仍可用。

---

> Release date: 2026-06-03 · CLI permission semantics hotfix + GUI server-process ownership

This release ships **Lynn CLI v0.80.7** and **Lynn GUI v0.80.2**. The CLI focuses
on headless/Fleet permission semantics, native toolchain stability, and long-run
agent loops. The GUI focuses on desktop server-process ownership, boot/restart
release gates, and Lynn-branded startup fallback.

## Highlights

- **Approved bash now runs**: in interactive `ask / workspace-write`, choosing
  `y` or `a` on the approval card executes the approved bash command with
  full-access for that confirmed operation/session, instead of approving and
  then failing on the workspace sandbox.
- **Clear Fleet/headless contract**: autonomous workers should use
  `--approval yolo --sandbox danger-full-access`. If `--approval yolo` is passed
  without an explicit sandbox, the CLI infers `danger-full-access`; explicit
  `--sandbox workspace-write` remains respected.
- **Human defaults stay guarded**: interactive `Lynn` / `Lynn code` still default
  to `ask / workspace-write`. Use `/yolo` only when you want zero per-command
  prompts.
- **Native CLI toolchain**: `web_scan`, `update_working_checkpoint`, skill
  crystallization/recall, `/rewind` sidecar snapshots, tool ledger,
  checkpoint/resume, auto-verify, and Fleet JSONL worker remain on the native
  stable path.
- **GUI server-process ownership**: `desktop/server-process.cjs` now owns the
  server pid, port, token, logs, and restart state; the true App boot gate starts
  Electron, waits for server ready, kills the bundled server, and requires auto
  restart plus window notification.
- **Lynn-branded splash fallback**: startup fallback no longer returns to
  Hanako-era copy or imagery.

## Install

```bash
# Prerequisite: Node.js 20 LTS or 22 LTS with npm.
node -v

# Install or update from the Lynn mirror.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.7.tgz"

# Launch.
Lynn            # interactive chat TUI
Lynn code       # coding-agent TUI
Lynn --version  # should print 0.80.7
Lynn agents     # copyable headless/Fleet commands
```

Default Brain route: **StepFun 3.7 Flash (256K context, high reasoning, 32K
reasoning/generation budget) -> MiMo V2.5 Pro/Omni -> Spark Qwen 3.6 35B A3B**.
Fresh CLI installs use the hosted Lynn Brain when local Brain is unavailable;
BYOK via `Lynn providers set ...` remains available.

## Headless / Fleet

```bash
Lynn -p "summarize this repository" --json --cwd /path/to/repo

Lynn code -p "fix tests, run the suite, summarize the diff" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox danger-full-access \
  --save-session

Lynn worker run --brief task.md --worktree /path/to/worktree \
  --jsonl \
  --approval yolo \
  --sandbox danger-full-access
```

## Verification

- `npm --prefix cli run typecheck`
- `npm --prefix cli test`
- `npm run build:cli`
- `npm run test:cli-pack`
- `npm run test:cli-install`
- `npm run test:cli-pty`
- GUI server bundle / main / renderer / runtime tests
- true Electron App boot/restart smoke
