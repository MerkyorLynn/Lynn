# Lynn v0.81.0 Release Notes / 发布说明

> 发布日期: 2026-06-06 · StepFun 3.7 Flash 专项优化 + 统一版本号

本次发版统一 **Lynn CLI 与 GUI 版本号为 v0.81.0**。重点是让 StepFun 3.7 Flash 在 Lynn 的 CLI / GUI 工作流里更适合“穷尽最优解”:显式 best/exhaustive 模式、300 步长任务预算、原子工具步进、自动验证、计划契约、工具预算和 Fleet/headless 默认建议对齐。

## 中文重点

- **统一版本号**:CLI 与桌面 GUI 同步为 v0.81.0,下载页、更新 manifest、README 与 Release 说明统一口径。
- **StepFun 穷尽最优模式**:
  - `Lynn code --best -p "任务" --json --cwd /path --approval yolo --sandbox danger-full-access`
  - `/goal`、`/best`、`/exhaustive` 会进入更适合长任务的 300 步预算与 ultra 编排。
- **原子步进 + 验证保留**:不通过提示词兜底抢模型工作,而是让模型逐步调用工具,由 harness 做计划契约、自动验证、工具预算与失败上下文回喂。
- **Fleet/headless 合约更清楚**:黑灯工厂建议 `--approval yolo --sandbox danger-full-access`,适合隔离 worktree;普通人类交互仍使用 ask / workspace-write。
- **GUI 对齐**:桌面包、更新 manifest、下载页与 CLI tarball 统一同一个 v0.81.0 发布号。

## 安装

```bash
# 前置:Node.js 20 LTS 或 22 LTS with npm.
node -v

# 从 Lynn 镜像安装或覆盖升级 CLI。
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.81.0.tgz"

# 启动。
Lynn            # 交互式聊天 TUI
Lynn code       # 编码 agent TUI
Lynn --version  # 应输出 0.81.0
Lynn agents     # 给其他智能体/Fleet 的可复制命令
```

默认 Brain 路由: **StepFun 3.7 Flash(256K 上下文, high 推理, 32K 推理/生成预算) -> Spark Qwen 3.6 35B A3B**。纯 CLI 首装在本地 Brain 不可达时会走 Lynn 远端 Brain;BYOK 仍可用。

---

> Release date: 2026-06-06 · StepFun 3.7 Flash specialization + unified app/CLI version

This release unifies **Lynn CLI and desktop GUI at v0.81.0**. The focus is making StepFun 3.7 Flash work better for exhaustive best-result coding loops across Lynn CLI and GUI: explicit best/exhaustive mode, a 300-step long-task budget, atomic tool progression, finish gates, plan contracts, tool budgets, and clearer Fleet/headless defaults.

## Highlights

- **Unified version**: CLI, desktop GUI, update manifest, download page, README, and release notes all use v0.81.0.
- **StepFun best mode**:
  - `Lynn code --best -p "task" --json --cwd /path --approval yolo --sandbox danger-full-access`
  - `/goal`, `/best`, and `/exhaustive` enter the longer 300-step + ultra orchestration path.
- **Atomic tools + verification kept**: Lynn does not take over model output through prompt fallbacks. The model chooses tools step by step while the harness enforces plan contracts, auto-verification, tool budgets, and rich failure feedback.
- **Fleet/headless contract**: silent factory workers should use `--approval yolo --sandbox danger-full-access` inside isolated worktrees; human interactive sessions stay on ask / workspace-write.
- **GUI alignment**: desktop artifacts, update manifest, download site, and CLI tarball share the same v0.81.0 train.

## Install

```bash
# Prerequisite:Node.js 20 LTS or 22 LTS with npm.
node -v

# Install or update from the Lynn mirror.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.81.0.tgz"

# Launch.
Lynn            # interactive chat TUI
Lynn code       # coding-agent TUI
Lynn --version  # should print 0.81.0
Lynn agents     # copyable headless/Fleet commands
```

Default Brain route: **StepFun 3.7 Flash (256K context, high reasoning, 32K reasoning/generation budget) -> Spark Qwen 3.6 35B A3B**. Fresh CLI installs use hosted Lynn Brain when local Brain is unavailable; BYOK via `Lynn providers set ...` remains available.

## Headless / Fleet

```bash
Lynn -p "summarize this repository" --json --cwd /path/to/repo

Lynn code --best -p "fix tests, run the suite, summarize the diff" \
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

- `npm run release:preflight`
- `npm run test:cli-toolchain`
- `npm run test:cli-fleet`
- `npm run test:release:static`
- GUI build/sign/notarize gates for the desktop artifacts
