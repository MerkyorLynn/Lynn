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
As a tool, it is powerful: it remembers everything you've said, operates your computer, browses the web, searches for information, reads and writes files, executes code, manages schedules, and can even learn new skills on its own.

## Features

**Memory** — A custom memory system that keeps recent events sharp and lets older ones fade naturally.

**Personality** — Not a generic "AI assistant". Each agent has its own voice and behavior through personality templates. Agents are self-contained folders, easy to back up and manage.

**Tools** — Read/write files, run terminal commands, browse the web, search the internet, take screenshots, draw on a canvas, execute JavaScript. Covers the vast majority of daily work scenarios.

**Skills** — Built-in compatibility with the community Skills ecosystem. Agents can also install skills from GitHub or write their own. Strict safety review enabled by default.

**Multi-Agent** — Create multiple agents, each with independent memory, personality, and scheduled tasks. Agents can collaborate via channel group chats or delegate tasks to each other.

**Desk** — Each agent has a desk for files and notes (Jian). Supports drag-and-drop, file preview, and serves as an async collaboration space between you and your agent.

**Cron & Heartbeat** — Agents can run scheduled tasks and periodically check for file changes on the desk. They work autonomously even when you're away.

**Sandbox** — Two-layer isolation: application-level PathGuard with four access tiers + OS-level sandboxing (macOS Seatbelt / Linux Bubblewrap).

**Multi-Platform Bridge** — A single agent can connect to Telegram, Feishu, QQ, and WeChat bots simultaneously. Chat from any platform and remotely operate your computer.

**i18n** — Interface available in 5 languages: Chinese, English, Japanese, Korean, and Traditional Chinese.

## Screenshots

<p align="center">
  <img src=".github/assets/screenshot-main-20260407-v3.png" width="100%" alt="Lynn Main Interface">
</p>

## Quick Start

### Download

**macOS (Apple Silicon / Intel):** download the latest `.dmg` from [Releases](https://github.com/MerkyorLynn/Lynn/releases).

The app is signed and notarized with an Apple Developer ID. macOS should allow it to launch directly.

**Windows:** download the latest `.exe` installer from [Releases](https://github.com/MerkyorLynn/Lynn/releases).

> **Windows SmartScreen notice:** The installer is not yet code-signed. Windows Defender SmartScreen may show a warning on first run. Click **More info** → **Run anyway**. This is expected for unsigned builds.

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
