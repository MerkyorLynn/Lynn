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

Lynn 是一个更易上手的 AI Agent：有记忆，有性格，会主动行动，还能让多个 Agent 在你的电脑上协同工作。

作为助手，Ta 是温柔的：不需要写复杂配置，也不需要理解晦涩术语。Lynn 不只面向 coder，而是为每一个坐在电脑前工作的人设计的助手。
作为工具，Ta 也是强大的：记住重要事实，操作你的电脑，浏览网页，搜索信息，读写文件，执行代码，管理日程，还能自主学习新技能。

我做这个项目的初衷，是弥合绝大多数人和 AI Agent 之间的缝隙，让强大的 Agent 能力不再只局限于命令行。于是我做了比传统 Coding Agent 更多一些的优化：一方面强化 Agent「像人」的属性，让沟通更自然；另一方面，围绕日常办公场景补了很多工具和流程层的体验。Lynn 也提供了相对完整、友好的图形界面。

如果你用过 claude code、codex、Manus 等 CLI 或是图形化的 Agent，你会在 Lynn 这里找到熟悉又新奇的感觉。

## 不是工具，是伙伴

Lynn 不是千篇一律的"AI 助手"。每个 Agent 有自己的名字、性格和说话方式，通过人格模板（Yuan）塑造——有的温柔细腻，有的理性冷静，有的活泼跳脱。你可以创建多个 Agent，各自独立运行，互相委派任务、频道群聊协作。Agent 就是一个文件夹，备份和迁移都很简单。

当你连接 Telegram、飞书、QQ 或微信机器人后，同一个 Agent 可以同时在多个平台和你对话，甚至远程操作你的电脑。

## 用得越久越懂你

Lynn 的记忆不是一个静态的 `memory.md`。它由六个层级组成：

- **事实存储（Fact Store）**——对话中确认的稳定事实，自动提取并结构化保存
- **深层记忆（Deep Memory）**——跨 session 的长期记忆编译，定期由 AI 整理沉淀
- **主动召回（Proactive Recall）**——对话时根据上下文自动检索相关记忆，而非被动等你提及
- **用户画像（User Profile + Inferred Profile）**——你的偏好、习惯、常用工具，用久了 Agent 自然知道
- **项目记忆（Project Memory）**——针对每个工作目录独立记录的项目背景和约定
- **技能提炼（Skill Distiller）**——当一次复杂任务完成后，自动判断是否值得提炼成可复用技能，下次遇到类似场景直接调用

记忆系统和技能提炼协同工作：你用得越多，Agent 记得越准，干活越快，逐渐变成一个真正理解你的长期协作者。

## 装完就能用，就会用

首次启动有两条路径。**Quick Start** 全程不需要填写任何 API Key——内置默认模型开箱即用，输入名字、授权权限，直接进入主界面开始对话。想要更强的模型？随时在设置中连接自己的供应商。

Lynn 使用 OpenAI 兼容协议，支持任意兼容的提供商（OpenAI、DeepSeek、通义千问、硅基流动、Ollama 本地模型等），部分供应商也支持 OAuth 一键登录。九级梯度自动降级机制确保即使某个供应商暂时不可用，对话也不会中断。

界面支持中文、英文、日文、韩文、繁体中文 5 种语言。

## 国内模型深度优化

Lynn 不是简单地套一层 OpenAI 兼容协议就完事。从 9B 小模型到 GLM-5 推理模型，每一级都有针对性的适配：

**开箱即用的免费模型（Brain）** — Quick Start 内置了国产模型池，默认链路包含 GLM-Z1-9B（智谱推理小模型）、GLM-4-9B、Qwen3-8B、Step-3.5-Flash。无需 API Key，设备鉴权直接可用。

**三级工具分层（Tool Tiering）** — 按模型上下文窗口自动裁剪工具集：
- 小模型（<32K，如 ERNIE 8K、Moonshot 8K、Step 8K）：仅保留 `web_search` + `web_fetch` 两个工具，避免工具描述撑爆上下文
- 中型模型（32K，如豆包 32K、混元 Pro、百川 Turbo）：标准工具集（搜索、记忆、文件预览、通知等 10 个）
- 大模型（≥64K，如 GLM-5、Qwen3-Max、DeepSeek）：全部工具不裁剪

**小模型专属 Prompt 工程** — context < 32K 时自动注入四段优化指令：回复限 500 字 + 关键结论标注（`<!-- KEY: -->`，压缩时优先保留）；单工具串行调用规则（防止弱模型并行调错）；工具概览摘要（减少工具描述占用的 token）；3 步以上任务强制先列计划等用户确认。

**自适应上下文压缩** — 小窗口模型保留更多近期上下文（40% vs 大模型 20%），减少输出预留（4K vs 16K），压缩 1-2 次即自动 session 接力（大模型是 3 次），防止上下文质量崩溃。

**推理模型协议适配** — 智谱 GLM-5 / GLM-5-Turbo 使用 ZAI thinking format（`thinking: { type: "enabled" }`），Qwen3 全系列使用 `enable_thinking` quirk，两者走不同的 Pi SDK 补丁路径。非 OpenAI provider 统一禁用 `developer role`，避免 API 报错。

**Coding Plan 一键接入** — 7 个国产厂商的编码套餐已预注册为独立 provider，填入 API Key 即用：百炼 Coding、智谱 Coding、Kimi Coding、MiniMax Coding、阶跃 Coding、腾讯云 Coding、火山引擎 Coding。

**工具调用容错** — 小模型容易产生无效的工具调用格式，连续失败 3 次后自动降级：停止工具调用，用文字向用户说明情况。空 `tools: []` 数组在发送前自动清理（dashscope / volcengine 等 API 不接受空数组会返回 400）。

## 不在的时候也在干活

这是 Lynn 与对话型 AI 工具最本质的区别。

**书桌（Desk）** 是你和 Agent 之间的异步协作空间。每个 Agent 都有自己的书桌，你可以放文件、写笺（Jian，类似便签）。写在笺上的待办事项，Agent 会主动读取并执行——你不需要开着对话窗口盯着它。

**心跳巡检（Heartbeat）** 会定期扫描书桌上的文件变化和笺的内容更新。发现新任务就自动处理，处理完了通知你。

**定时任务（Cron）** 让 Agent 按计划重复执行工作。每个 Agent 的 Cron 独立并发运行，切换 Agent 不会中断其他 Agent 的定时任务。笺里写的重复性待办会自动变成 Cron 任务。

**长任务稳定性** 是这套自主工作体系的基础。Lynn 的 server 以独立 Node.js 进程运行（不依赖 Electron 渲染进程），通过 WebSocket 全双工通信。对话中断、窗口关闭、网络波动都不会打断正在执行的任务。复查系统会自动校验 AI 回答的质量，模型响应异常时自动回退到备选模型继续完成。

## 安全防护

Lynn 能读文件、跑命令、操作本地环境，所以安全不是附加功能，而是底座。我们用四层纵深防御确保 Agent 的行为始终在你的掌控范围内：

**第一层 · 路径守卫（PathGuard）**

四级访问控制：`BLOCKED → READ_ONLY → READ_WRITE → FULL`。每个文件操作先经过 realpath 解析符号链接，再匹配访问区域。系统敏感文件（SSH 私钥、.env、密码数据库等）硬编码为 BLOCKED，Agent 无论如何无法触及。工作目录以外的路径默认为只读。

**第二层 · 操作系统沙盒**

终端命令不是直接执行，而是经过操作系统级隔离：
- macOS：通过 `sandbox-exec` 加载动态生成的 Seatbelt SBPL 策略，限制进程的文件系统、网络和 IPC 访问
- Linux：通过 Bubblewrap (`bwrap`) 创建命名空间隔离，只挂载策略允许的目录
- Windows：PathGuard 路径提取 + 校验作为安全层（无 OS 级沙盒）

**第三层 · Prompt Injection 检测（ClawAegis）**

用户拖入或 Agent 读取的文件内容会经过轻量级注入检测器扫描——纯正则、零延迟、不调 LLM。覆盖指令覆盖（`ignore previous instructions`）、角色劫持（`pretend you are`）、敏感操作诱导（`read /etc/passwd`）等攻击模式。检测到时追加警告上下文，不阻断读取。

**第四层 · 行为确认与安全模式**

三种安全模式供用户选择：
- **安全模式**：只读，不写文件不跑命令
- **规划模式**：可读可写，危险操作暂停等待确认
- **执行模式**：完全授权，Agent 自主决策

危险操作（`rm -rf`、`sudo`、`git push --force`）始终弹出确认对话框，不受模式影响。技能安装经过独立的 AI 安全审查（检测 prompt injection、过宽触发条件、权限提升），审查不通过则阻止安装。

## Harness 架构

Lynn 的核心 Agent 循环外面包裹了六层 harness，每一层独立运作，不侵入 Agent 内部逻辑，但通过共享的数据存储（FactStore / SQLite、experience/ 目录、memory.md）实现协同：

```
用户输入
  │
  ├─ [1] Content Filter ─── DFA 关键词过滤，17 类风险词库，输入拦截/警告
  ├─ [2] Proactive Recall ─ 主动记忆召回：关键词提取 → FactStore 检索 → 注入隐形上下文
  │
  ▼
┌──────────────────┐
│  Core Agent Loop │  LLM 对话 + 工具调用
└──────────────────┘
  │
  ├─ [3] Tool Wrapper ───── 路径校验 + 命令 preflight + 危险操作授权（三模式安全策略）
  ├─ [4] ClawAegis ──────── read/read_file 等工具返回内容的 Prompt Injection 扫描
  │
  ├─ [5] Memory Ticker ──── 后置观察：每 6 轮滚动摘要 → 每日深度记忆 → 事实提取 → 技能蒸馏
  ├─ [6] Review System ──── 后置评估：另一个 Agent 复查输出 → 结构化发现项 → 自动修复任务
  │
  ▼
用户输出
```

**复查者和记忆殊途同归**：Review System（第 6 层）用第二个 Agent 作为"同事 code review"，发现问题后自动构建修复任务回注到执行链路；Memory Ticker（第 5 层）从对话中提取事实和经验，沉淀到 FactStore；而 Proactive Recall（第 2 层）在下一次对话时把这些知识召回注入上下文。三者形成一条完整的反馈闭环：**评估 → 沉淀 → 召回 → 更好的执行 → 再评估**。

每一层的设计原则是**低延迟、不阻断**：Content Filter 用 DFA Trie 树而非 LLM；ClawAegis 用纯正则（扫描前 10KB，不调 LLM）；Proactive Recall 用正则提取关键词 + FactStore / SQLite 检索，整体保持轻量；Memory Ticker 和 Review 都在后台异步运行，不阻塞当前对话。

## 工具能力

读写文件、执行终端命令、浏览网页、搜索互联网、截图、画布绘图、JavaScript 执行。能力覆盖日常办公的绝大多数场景。

**Skills** — 兼容社区 Skills 生态，Agent 也可以从 GitHub 安装技能或自己编写新技能。内置安全审查，默认开启。

## 截图

<p align="center">
  <img src=".github/assets/screenshot-main-20260407-v3.png" width="100%" alt="Lynn 主界面">
</p>

## 快速开始

### 下载安装

**macOS（Apple Silicon / Intel）**：从 [Releases](https://github.com/MerkyorLynn/Lynn/releases) 下载最新 `.dmg`。

应用已通过 Apple Developer ID 签名和公证，macOS 应该可以直接打开。

**Windows**：从 [Releases](https://github.com/MerkyorLynn/Lynn/releases) 下载最新 `.exe` 安装包，直接运行即可。

> **Windows SmartScreen 提示：** 便携版暂未经过代码签名，首次运行时 Windows Defender SmartScreen 可能会拦截，点击**更多信息** → **仍要运行**即可，这是未签名版本的正常现象。

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
