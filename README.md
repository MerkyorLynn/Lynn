<p align="center">
  <img src=".github/assets/banner.png" width="100%" alt="Lynn Banner">
</p>

<p align="center">
  <img src="desktop/src/assets/Lynn.png" width="80" alt="Lynn">
</p>

<h1 align="center">Lynn</h1>

<p align="center">A personal AI agent with memory and soul</p>

<p align="center"><a href="README_CN.md">中文版</a></p>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](https://github.com/MerkyorLynn/Lynn/releases)

---

## What is Lynn

Lynn is a personal AI agent that is easier to use than traditional coding agents. It has memory, personality, and can act autonomously. Multiple agents can work together on your machine.

As an assistant, it is gentle: no complex configuration files, no obscure jargon. Lynn is designed not just for coders, but for everyone who works at a computer.
As a tool, it is powerful: it remembers important facts you've shared, operates your computer, browses the web, searches for information, reads and writes files, executes code, manages schedules, and can even learn new skills on its own.

This project started from a simple goal: narrow the gap between most people and AI agents, and bring powerful agent capabilities beyond the command line. That shaped two priorities for Lynn: make Agents feel more human to talk to, and make everyday desktop work easier through better tooling and workflows. Lynn also comes with a more approachable GUI.

## Not a Tool — A Companion

Lynn is not a generic "AI assistant". Each Agent has its own name, personality, and voice, shaped by personality templates (Yuan) — some are warm and gentle, others rational and precise. You can create multiple Agents, each running independently, delegating tasks to each other and collaborating via channel group chats. An Agent is just a folder — easy to back up and migrate.

Connect Telegram, Feishu, QQ, or WeChat bots and the same Agent can chat with you across platforms, even operating your computer remotely.

## Gets Smarter the Longer You Use It

Lynn's memory is not a static `memory.md`. It's a six-layer system:

- **Fact Store** — Stable facts confirmed in conversation, automatically extracted and structured
- **Deep Memory** — Long-term memory compiled across sessions, periodically organized by AI
- **Proactive Recall** — Automatically retrieves relevant memories based on context, without waiting for you to mention them
- **User Profile + Inferred Profile** — Your preferences, habits, and frequently used tools, learned naturally over time
- **Project Memory** — Per-workspace context and conventions
- **Skill Distiller** — After a complex task succeeds, automatically evaluates whether it's worth distilling into a reusable skill for next time

Memory and skill distillation work together: the more you use Lynn, the more accurate its recall, the faster it works — gradually becoming a long-term collaborator that truly understands you.

## Install and Go

Two paths on first launch. **Quick Start** requires zero API keys — a built-in default model works out of the box. Enter your name, grant permissions, start chatting. Want a stronger model? Connect your own provider anytime in Settings.

Lynn uses the OpenAI-compatible protocol, supporting any compatible provider (OpenAI, DeepSeek, Qwen, SiliconFlow, local models via Ollama, etc.). Some providers also support OAuth login. A nine-tier automatic fallback mechanism ensures conversations continue even when a provider is temporarily unavailable.

Interface available in 5 languages: Chinese, English, Japanese, Korean, and Traditional Chinese.

## Deep Optimization for Chinese Models

Lynn doesn't just slap an OpenAI-compatible wrapper and call it a day. From 9B small models to GLM-5 reasoning models, every tier has purpose-built adaptations:

**Free built-in models (Brain)** — Quick Start ships with a domestic built-in model pool, and the default route includes GLM-Z1-9B (Zhipu reasoning, 9B), GLM-4-9B, Qwen3-8B, and Step-3.5-Flash. No API key needed — device authentication only.

**Three-tier tool layering** — Tools are automatically pruned based on context window:
- Small models (<32K, e.g. ERNIE 8K, Moonshot 8K, Step 8K): only `web_search` + `web_fetch`, preventing tool descriptions from blowing out the context
- Medium models (32K, e.g. Doubao 32K, Hunyuan Pro, Baichuan Turbo): standard tool set (search, memory, file preview, notification — 10 tools)
- Large models (≥64K, e.g. GLM-5, Qwen3-Max, DeepSeek): full tool set, no pruning

**Small-model prompt engineering** — When context < 32K, four optimization directives are auto-injected: 500-word reply limit + key conclusion markers (`<!-- KEY: -->`, prioritized during compaction); sequential single-tool call rules (prevents weak models from calling tools in parallel incorrectly); tool overview summary (reduces token overhead from tool descriptions); plans required before 3+ step tasks.

**Adaptive context compaction** — Small-window models retain more recent context (40% vs 20% for large models), reduce output reservation (4K vs 16K), and trigger automatic session relay after just 1–2 compactions (vs 3 for large models), preventing context quality collapse.

**Reasoning model protocol adaptation** — Zhipu GLM-5 / GLM-5-Turbo use ZAI thinking format (`thinking: { type: "enabled" }`), while the entire Qwen3 family uses the `enable_thinking` quirk — each routed through different Pi SDK patch paths. Non-OpenAI providers uniformly disable `developer role` to prevent API errors.

**Coding Plan one-click setup** — 7 domestic vendors' coding subscriptions are pre-registered as separate providers (just add your API key): DashScope Coding, Zhipu Coding, Kimi Coding, MiniMax Coding, StepFun Coding, Tencent Cloud Coding, Volcengine Coding.

**Tool call fault tolerance** — Small models are prone to malformed tool calls. After 3 consecutive failures, the system auto-degrades: stops tool use and explains the situation in text. Empty `tools: []` arrays are stripped before sending (DashScope / Volcengine APIs return 400 on empty arrays).

## Works While You're Away

This is the fundamental difference between Lynn and conversational AI tools.

**Desk** is the async collaboration space between you and your Agent. Each Agent has its own desk where you can drop files and write notes (Jian). Tasks written on a Jian are proactively picked up and executed — no need to keep the chat window open.

**Heartbeat** periodically scans for file changes and Jian updates on the desk. When new tasks appear, they're automatically processed and you're notified when done.

**Cron** lets Agents run scheduled work. Each Agent's cron jobs run concurrently and independently — switching Agents doesn't interrupt other Agents' schedules. Recurring tasks written in a Jian automatically become cron jobs.

**Long-task stability** is the foundation of this autonomous work system. Lynn's server runs as a standalone Node.js process (independent of the Electron renderer), communicating via full-duplex WebSocket. Chat interruptions, window closures, and network hiccups won't break running tasks. A review system automatically verifies AI output quality, and the model auto-falls back to alternatives when issues are detected.

## Security

Lynn can read files, run commands, and operate your local environment — so security is not an add-on, it's the foundation. Four layers of defense-in-depth ensure Agent behavior stays within your control:

**Layer 1 · Path Guard**

Four-tier access control: `BLOCKED → READ_ONLY → READ_WRITE → FULL`. Every file operation goes through realpath resolution (resolving symlinks) before matching access zones. Sensitive system files (SSH keys, `.env`, password databases, etc.) are hardcoded as BLOCKED — Agents can never touch them. Paths outside the working directory default to read-only.

**Layer 2 · OS-Level Sandbox**

Terminal commands are not executed directly — they go through operating system isolation:
- macOS: `sandbox-exec` with dynamically generated Seatbelt SBPL profiles restricting filesystem, network, and IPC access
- Linux: Bubblewrap (`bwrap`) namespace isolation, mounting only policy-approved directories
- Windows: PathGuard path extraction + validation as the security layer (no OS sandbox available)

**Layer 3 · Prompt Injection Detection (ClawAegis)**

File contents dragged in by users or read by Agents are scanned by a lightweight injection detector — pure regex, zero latency, no LLM calls. Covers directive overrides (`ignore previous instructions`), role hijacking (`pretend you are`), and sensitive operation inducement (`read /etc/passwd`). Detections append warning context without blocking reads.

**Layer 4 · Behavioral Confirmation & Security Modes**

Three security modes for users to choose from:
- **Safe mode**: Read-only, no file writes or command execution
- **Plan mode**: Read/write allowed, dangerous operations pause for confirmation
- **Authorized mode**: Full autonomy, Agent makes its own decisions

Dangerous operations (`rm -rf`, `sudo`, `git push --force`) always trigger a confirmation dialog regardless of mode. Skill installation undergoes independent AI safety review (detecting prompt injection, overly broad triggers, privilege escalation) — installation is blocked if review fails.

## Harness Architecture

Six harness layers wrap Lynn's core Agent loop. Each layer operates independently without invading the Agent's internals, coordinating through shared data stores (FactStore / SQLite, experience/ directory, memory.md):

```
User Input
  │
  ├─ [1] Content Filter ─── DFA keyword filter, 17 risk categories, input blocking/warning
  ├─ [2] Proactive Recall ─ Memory recall: keyword extraction → FactStore search → inject invisible context
  │
  ▼
┌──────────────────┐
│  Core Agent Loop │  LLM conversation + tool calls
└──────────────────┘
  │
  ├─ [3] Tool Wrapper ───── Path validation + command preflight + dangerous operation authorization (3-mode policy)
  ├─ [4] ClawAegis ──────── Prompt injection scan on read/read_file tool return content
  │
  ├─ [5] Memory Ticker ──── Post-observation: rolling summary every 6 turns → daily deep memory → fact extraction → skill distillation
  ├─ [6] Review System ──── Post-evaluation: a second Agent reviews output → structured findings → auto-fix tasks
  │
  ▼
User Output
```

**Review and Memory converge**: The Review System (Layer 6) uses a second Agent as a "colleague code reviewer" — findings automatically become fix tasks fed back into the execution pipeline. The Memory Ticker (Layer 5) extracts facts and experiences from conversations, depositing them into FactStore. Proactive Recall (Layer 2) retrieves this knowledge on the next conversation and injects it as context. Together they form a complete feedback loop: **evaluate → deposit → recall → better execution → re-evaluate**.

Each layer is designed around **low latency, non-blocking**: Content Filter uses a DFA Trie (not LLM); ClawAegis uses pure regex (scans the first 10KB without calling an LLM); Proactive Recall uses regex keyword extraction plus FactStore / SQLite retrieval and stays lightweight; Memory Ticker and Review both run asynchronously in the background without blocking the current conversation.

## Tools

Read/write files, run terminal commands, browse the web, search the internet, take screenshots, draw on a canvas, execute JavaScript. Covers the vast majority of daily work scenarios.

**Skills** — Compatible with the community Skills ecosystem. Agents can also install skills from GitHub or write their own. Built-in safety review enabled by default.

## Screenshots

<p align="center">
  <img src=".github/assets/screenshot-main-20260407-v3.png" width="100%" alt="Lynn Main Interface">
</p>

## Quick Start

### Download

**macOS (Apple Silicon / Intel):** download the latest `.dmg` from [Releases](https://github.com/MerkyorLynn/Lynn/releases).

The app is signed and notarized with an Apple Developer ID. macOS should allow it to launch directly.

**Windows:** download the latest `.exe` installer from [Releases](https://github.com/MerkyorLynn/Lynn/releases) and run it directly.

> **Windows SmartScreen notice:** The portable build is not yet code-signed. Windows Defender SmartScreen may show a warning on first run. Click **More info** → **Run anyway**. This is expected for unsigned builds.

Linux builds are planned.

### First Run

Two paths on first launch:

- **Quick Start**: Enter your name → set permissions → jump right in. A built-in default model works out of the box — no API key required.
- **Advanced Setup**: Enter your name → connect your own provider (API key + base URL) → choose a **chat model** and a **utility model** → pick a theme → set permissions → enter.

Lynn uses the OpenAI-compatible protocol, so any provider that supports it will work (OpenAI, DeepSeek, Qwen, local models via Ollama, SiliconFlow, etc.). Some providers (e.g. MiniMax) also support OAuth login. All model settings can be adjusted later in Settings.

## Architecture

```
core/           Engine layer (HanaEngine Thin Facade + 8 Managers + 2 Coordinators)
lib/            Core libraries
  ├── memory/     Memory system (fact store, vector retrieval, deep memory, skill distillation)
  ├── tools/      Tool suite (browser, search, cron, delegate, skill install — 17 tools)
  ├── sandbox/    Two-layer sandbox (PathGuard + macOS Seatbelt / Linux Bubblewrap)
  ├── bridge/     Social platform adapters (Telegram, Feishu, QQ, WeChat)
  ├── desk/       Desk system (heartbeat patrol, cron scheduler, jian runtime)
  └── ...         LLM client, OAuth, channel storage, expert system, etc.
shared/         Cross-layer shared code (error bus, config schema, security mode, net utils)
server/         Hono HTTP + WebSocket server (24 routes, standalone Node.js process)
hub/            Background dispatch center
  ├── event-bus.js       Unified event bus
  ├── scheduler.js       Heartbeat + Cron scheduling
  ├── channel-router.js  Channel triage + dispatch
  ├── agent-messenger.js Agent-to-agent messaging
  ├── dm-router.js       DM routing
  └── task-runtime.js    Task runtime
desktop/        Electron app + React frontend
skills2set/     Built-in skill definitions
scripts/        Build tools (server bundler, launcher, signing)
tests/          Vitest test suite
```

**Engine layer**: `HanaEngine` is a Thin Facade holding AgentManager, SessionCoordinator, ConfigCoordinator, ModelManager, PreferencesManager, SkillManager, ChannelManager, BridgeSessionManager, ExpertManager, and PluginManager — exposing a unified API.

**Hub**: Runs independently of the active chat session. Handles heartbeat patrol, scheduled tasks (per-agent concurrent cron), channel routing, agent-to-agent communication (with hard round limits + cooldown to prevent infinite loops), and DM routing.

**Server**: Runs as a standalone Node.js process (spawned by Electron or independently), bundled via Vite with @vercel/nft for dependency tracing. Communicates with the frontend through full-duplex WebSocket.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Electron 38 |
| Frontend | React 19 + Zustand 5 + CSS Modules |
| Build | Vite 7 |
| Server | Hono + @hono/node-server + @hono/node-ws |
| Agent Runtime | [Pi SDK](https://github.com/nicepkg/pi) |
| Database | better-sqlite3 (WAL mode) |
| Testing | Vitest |
| i18n | 5 languages (zh / en / ja / ko / zh-TW) |

## Platform Support

| Platform | Status |
|----------|--------|
| macOS (Apple Silicon) | Supported (signed & notarized) |
| macOS (Intel) | Supported |
| Windows | Beta |
| Linux | Planned |
| Mobile (PWA) | Planned |

## Development

```bash
# Install dependencies
npm install

# Start with Electron (builds renderer first)
npm start

# Start with Vite HMR (run npm run dev:renderer first)
npm run start:vite

# Run tests
npm test

# Type check
npm run typecheck
```

## License

[Apache License 2.0](LICENSE)

This project is based on the open source work of [liliMozi](https://github.com/liliMozi/openhanako), modified and extended by Merkyor. See [NOTICE](NOTICE).

## Links

- [Report an Issue](https://github.com/MerkyorLynn/Lynn/issues)
- [Security](https://github.com/MerkyorLynn/Lynn/security)
- [Project Repository](https://github.com/MerkyorLynn/Lynn)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
