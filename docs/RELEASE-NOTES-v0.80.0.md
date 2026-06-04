# Lynn v0.80.0 Release Notes

> 发布日期:2026-05-30 · 代号:"CLI Worker Fleet"

v0.80.0 是 Lynn 回到编程主战场的版本。它把桌面端从单一聊天客户端扩展成 **Lynn 客户端 GUI 指挥台 + Lynn CLI / Lynn Code worker**:GUI 负责拆任务、派发、看日志、看 diff、跑门禁和合并;CLI 负责在终端或后台静默执行具体编码任务。

## 重点更新

- **Lynn CLI / Lynn Code**:新增 `@lynn/cli` npm 包、Ink TUI、流光等待、Markdown/代码高亮、真实 diff 预览、多行输入、图片/音频/视频附件、`Lynn code -p ... --json` 无交互调用和 `Lynn agents` 机器可读命令面。
- **GUI Worker Fleet**:Lynn 客户端 GUI 可以把一个 task brief fan-out 给多个 CLI worker,每个 worker 在独立 worktree 中运行,并在 GUI 内展示 stdout/stderr、测试、diff、越界红灯、gate 状态和 gated merge 结果。
- **Brain V2 默认路由**:StepFun 3.7 Flash high+32K → MiMo V2.5 Pro/Omni → Spark Qwen 3.6 35B A3B。StepFun 负责高速文本与编码主路,MiMo 接多模态与原生搜索兜底,Spark 接本地/自建零成本兜底。
- **链式工具加固**:tool result reinforcement、链式工具 hint、tool-storm 抑制、context compact 和 pre-search/web_search proxy 一起降低多步工具漂移与重复调用。
- **长任务续跑**:CLI 会话 JSONL、checkpoint、帧恢复、计划重建、原始目标钉住、git 快照和 stable context layers 一起支撑长任务稳定续跑。
- **本地 9B 改为显式启用**:本地 Qwen3.5-9B MTP 不再随应用启动自动占用约 6GB 显存/统一内存;用户点击启用时才下载/启动,并只在本地模型入口提示首次暖机较慢。
- **CLI 发布链路**:README、CLI README、headless agent contract、镜像安装片段和 release static gate 都写入 Node 要求、CDN tarball、`Lynn` / `Lynn code` / `Lynn agents` 启动命令。

## CLI 安装

```bash
# 1. Node requirement: Node.js 20 LTS or 22 LTS with npm.
# macOS: brew install node@20
# macOS/Linux: nvm install 20 && nvm use 20
# Windows: winget install OpenJS.NodeJS.LTS

# 2. Install or update Lynn CLI from the CDN.
npm install -g --force https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.0.tgz

# 3. Launch.
Lynn          # interactive chat TUI
Lynn code     # coding-agent TUI
Lynn agents   # copyable headless/Fleet commands for other agents
```

## Headless / Fleet

```bash
# One-shot prompt, no TUI.
Lynn -p "summarize this repository" --json --cwd /path/to/repo

# Headless coding worker inside an isolated worktree.
Lynn code -p "fix tests, run the suite, summarize the diff" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox workspace-write \
  --save-session

# GUI Fleet adapter. Emits Fleet JSONL.
Lynn worker run --brief task.md --worktree /path/to/worktree \
  --jsonl \
  --approval yolo \
  --sandbox workspace-write
```

Rules for agents:use `--json` or `--jsonl`,always pass `--cwd` or `--worktree`,and use `--approval yolo --sandbox danger-full-access` only inside an isolated git worktree.

## 回归门禁

- `npm run typecheck` ✓
- `npm run typecheck:runtime` ✓
- CLI focused gates:`build:cli`, `test:cli`, `test:cli-install`, `test:cli-fleet`, `test:packaged-cli` ✓
- Brain v2 focused and full gates ✓
- Local 9B explicit-enable regression ✓
- Release static gate covers README version, update manifest, mirror URLs, CLI install snippet, and headless agent contract ✓

## English Summary

v0.80.0 turns Lynn into a GUI-commanded CLI worker fleet. The desktop app becomes the orchestration surface for dispatching multiple coding CLIs, while `@lynn/cli` provides the terminal and headless worker runtime.

Highlights:
- New `@lynn/cli` package with `Lynn`, `Lynn code`, `Lynn agents`, Ink TUI, markdown/code rendering, real diff preview, multimodal input, and JSONL headless mode.
- GUI Fleet can dispatch multiple workers into isolated worktrees, show logs/diffs/tests/gates, and perform gated merges.
- Brain V2 defaults to StepFun 3.7 Flash high+32K, then MiMo V2.5 Pro/Omni, then Spark Qwen 3.6 35B A3B.
- Local Qwen3.5-9B MTP is now explicit opt-in and no longer auto-starts on app launch.
- Release docs and gates now include CLI install, mirror distribution, and the machine-readable headless agent contract.
