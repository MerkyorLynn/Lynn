[English](README.md)

<p align="center">
  <img src=".github/assets/banner.png" width="100%" alt="Lynn Banner">
</p>

<p align="center">
  <img src="desktop/src/assets/Lynn.png" width="80" alt="Lynn">
</p>

<h1 align="center">Lynn</h1>

<p align="center">一个有记忆、有灵魂的私人 AI 助理</p>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](https://github.com/MerkyorLynn/Lynn/releases)

---

## Lynn 是什么

Lynn 是一个更加易用的 AI agent，有记忆，有性格，会主动行动，还能多 Agent 在你的电脑上一同工作。

作为助手，Ta 是温柔的：不需要写复杂的配置，不需要理解晦涩的术语。Lynn 不只面向 coder ，而是为每一个坐在电脑前工作的人设计的助手。
作为工具，Ta 是强大的：记住你说过的每一件事，操作你的电脑，浏览网页，搜索信息，读写文件，执行代码，管理日程，还能自主学习新技能。

我开这个项目的初衷是：弥合绝大多数人和 AI Agent 之间的缝隙，让强大的 Agent 能力不再只局限于命令行里。于是我做了比传统 Coding Agent 更多一些的优化：一方面是强化 Agent「像人」的属性，是你和他们沟通更自然；另一方面，因为我本职也是一介文员，所以我也针对日常办公场景做了很多工具性和流程性的优化，敬请探索。
此外，Lynn 有比较完备的图形页面。

如果你用过 claude code、codex、Manus 等 CLI 或是图形化的 Agent，你会在 Lynn 这里找到熟悉又新奇的感觉。

## 功能特性

**记忆** — 结合主流的记忆方案，自己又发挥了一下，做了个记忆系统，近期的事情记得非常牢固，但目前确实有待优化。

**人格** — 不是千篇一律的"AI 助手"。通过人格模板和自定义人格文件塑造独特的性格，每个 Agent 都有自己的说话方式和行为逻辑，Agent 之间分离做得很好，备份方便，Agent 就是文件夹，后续还会添加备份功能。

**工具** — 读写文件、执行终端命令、浏览网页、搜索互联网、截图、画布绘图、JavaScript 执行。能力覆盖日常办公的绝大多数场景。

**SKILLS 支持** — 内置兼容庞大 SKILLS 社区生态，之外，我也做了一些主动的优化：有时候干活之前，Agent 会从 GitHub 安装社区技能，Agent 也可以自己编写并学会新技能，有比较不错的主动性。当然，默认情况给 Agent 做了比较严格的 SKILLS 审核，如果发现 SKILLS 装不上可以自行关闭。

**多 Agent** — 创建多个 Agent，各自有独立的记忆、人格和定时任务。Agent 之间可以通过频道群聊协作，也可以互相委派任务。

**书桌** — 每个 Agent 都有自己的书桌，可以放文件、写笺（类似便签，Agent 会主动读取并执行）。支持拖拽操作，文件预览，是你和 Agent 之间的异步协作空间。

**定时任务与心跳** — Agent 可以设置定时任务（Cron），也会定期巡检书桌上的文件变化。你不在的时候，Ta 也能按计划自主工作。

**安全沙盒** — 双层隔离：应用层 PathGuard 四级访问控制 + 操作系统级沙盒（macOS Seatbelt / Linux Bubblewrap）。Agent 的权限在你的掌控之中。平时只能访问工作目录和一些用户文件，如果你想放开权限，可以点五下关于里面的图标。

**多平台接入** — 同一个 Agent 可以同时接入 Telegram、飞书、QQ、微信机器人，在任何平台和 Ta 对话，可以远程操作电脑。

**国际化** — 界面支持中文、英文、日文、韩文、繁体中文 5 种语言。

## 截图

<p align="center">
  <img src=".github/assets/screenshot-main-20260407-v3.png" width="100%" alt="Lynn 主界面">
</p>

## 快速开始

### 下载安装

**macOS（Apple Silicon / Intel）**：从 [Releases](https://github.com/MerkyorLynn/Lynn/releases) 下载最新 `.dmg`。

应用已通过 Apple Developer ID 签名和公证，macOS 应该可以直接打开。

**Windows**：从 [Releases](https://github.com/MerkyorLynn/Lynn/releases) 下载最新 `.exe` 安装包。

> **Windows SmartScreen 提示：** 安装包暂未经过代码签名，首次运行时 Windows Defender SmartScreen 可能会拦截，点击**更多信息** → **仍要运行**即可，未签名版本的正常现象。

Linux 版本计划中。

### 首次运行

首次启动有两条路径：

- **Quick Start**：输入名字 → 设置权限 → 直接进入。内置默认模型开箱即用，无需填写 API Key。
- **Advanced Setup**：输入名字 → 连接自己的供应商（API Key + Base URL）→ 选择**对话模型**和**工具模型** → 选择主题 → 设置权限 → 进入。

Lynn 使用 OpenAI 兼容协议，支持任意兼容的提供商（OpenAI、DeepSeek、通义千问、Ollama 本地模型、硅基流动等）。部分供应商（如 MiniMax）也支持 OAuth 登录。所有模型配置后续都可以在设置中调整。

## 架构

```
core/           引擎层（HanaEngine Thin Facade + 8 个 Manager + 2 个 Coordinator）
lib/            核心库
  ├── memory/     记忆系统（事实存储、向量检索、深层记忆、技能提炼）
  ├── tools/      工具集（浏览器、搜索、Cron、委派、技能安装等 17 个工具）
  ├── sandbox/    双层沙盒（PathGuard + macOS Seatbelt / Linux Bubblewrap）
  ├── bridge/     社交平台适配器（Telegram、飞书、QQ、微信）
  ├── desk/       书桌系统（心跳巡检、Cron 调度、笺运行时）
  └── ...         LLM 客户端、OAuth、频道存储、专家系统等
shared/         跨层共享（错误总线、配置 schema、安全模式、网络工具）
server/         Hono HTTP + WebSocket 服务（24 个路由，独立 Node.js 进程）
hub/            后台调度中枢
  ├── event-bus.js       统一事件总线
  ├── scheduler.js       心跳 + Cron 调度
  ├── channel-router.js  频道 triage + 调度
  ├── agent-messenger.js Agent 间私聊
  ├── dm-router.js       私信路由
  └── task-runtime.js    任务运行时
desktop/        Electron 应用 + React 前端
skills2set/     内置技能定义
scripts/        构建工具（server 打包、启动器、签名）
tests/          Vitest 测试
```

**引擎层**：`HanaEngine` 是一个 Thin Facade，持有 AgentManager、SessionCoordinator、ConfigCoordinator、ModelManager、PreferencesManager、SkillManager、ChannelManager、BridgeSessionManager、ExpertManager、PluginManager，对外暴露统一 API。

**Hub**：独立于当前聊天会话运行，负责心跳巡检、定时任务（per-agent 并发 Cron）、频道路由、Agent 间通信（含防无限循环的硬上限 + 冷却期）、DM 路由。

**Server**：以独立 Node.js 进程运行（由 Electron spawn 或独立启动），通过 Vite 打包，@vercel/nft 追踪依赖，与前端通过 WebSocket 全双工通信。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面端 | Electron 38 |
| 前端 | React 19 + Zustand 5 + CSS Modules |
| 构建 | Vite 7 |
| 服务端 | Hono + @hono/node-server + @hono/node-ws |
| Agent 运行时 | [Pi SDK](https://github.com/nicepkg/pi) |
| 数据库 | better-sqlite3（WAL 模式） |
| 测试 | Vitest |
| 国际化 | 5 语言（zh / en / ja / ko / zh-TW） |

## 平台支持

| 平台 | 状态 |
|------|------|
| macOS (Apple Silicon) | 已支持（已签名公证） |
| macOS (Intel) | 已支持 |
| Windows | Beta |
| Linux | 计划中 |
| 移动端 (PWA) | 计划中 |

## 开发

```bash
# 安装依赖
npm install

# Electron 启动（自动构建 renderer）
npm start

# Vite HMR 开发（需先运行 npm run dev:renderer）
npm run start:vite

# 运行测试
npm test

# 类型检查
npm run typecheck
```

## 许可证

[Apache License 2.0](LICENSE)

本项目基于 [liliMozi](https://github.com/liliMozi/openhanako) 的开源工作，由 Merkyor 修改和扩展。详见 [NOTICE](NOTICE)。

## 链接

- [提交 Issue](https://github.com/MerkyorLynn/Lynn/issues)
- [安全页](https://github.com/MerkyorLynn/Lynn/security)
- [项目仓库](https://github.com/MerkyorLynn/Lynn)
- [安全政策](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)
