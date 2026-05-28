# Lynn CLI MVP — Design Doc

Date: 2026-05-28
Branch: `claude/lynn-cli-mvp`
Status: **Design (pre-code review gate)** — per `docs/ops/multi-cli-collaboration-guide.md`, doc before code.

---

## 1. Goal & Non-Goals

### Goal (one sentence)

A terminal-first thin client for Lynn's brain v2 mirror — so a developer can `lynn -p "..."` from any tmux / ssh / CI shell, get the same multi-provider routing, web-search, and local-9B-MTP fallback that the GUI gets, optimized around DeepSeek V4 Pro's prefix-cache stability.

### What this is

- Frontend No. 2 to brain v2 mirror (frontend No. 1 = Electron GUI).
- Reuse of brain v2 + lib/tools / server/chat/* — **not** a rewrite of router or providers.
- DeepSeek V4 Pro as default primary; brain v2's `universalOrder` chain still picks up MiMo / Spark / GLM / local-9B on failure.
- Shared session store with the GUI (open a session in CLI, continue in GUI, and vice versa).

### Non-goals (explicit, listed so they stop sneaking in)

- Not a "Reasonix replacement". We are not optimizing for the single-DeepSeek case; we are leaning on Lynn's multi-source moat.
- Not a plugin / MCP / hooks platform in v0.80. (Reasonix-format skills compat is a nice-to-have but explicit non-MVP.)
- Not an inference engine, not a code editor, not an IDE plugin.
- No Rust rewrite. (See §13 prior decision.)
- No Tauri desktop variant. (Reasonix already explores this; we don't duplicate.)
- No deep TUI dashboards in v0.80 — Ink primitives are enough.

---

## 2. User Stories (the only 5 that ship in MVP)

1. **One-shot prompt**: `lynn -p "为什么这个 SSE 流偶尔卡 5s"` → streams a reply to stdout, exits.
2. **REPL**: `lynn` → interactive chat session, `Ctrl+C` exits cleanly, `Ctrl+D` saves & exits.
3. **Coding agent loop**: `lynn code` → enters a project-aware mode where the model can `read_file` / `write_file` / `edit_file` / `bash` / `grep` / `glob` / `web_search` against the cwd.
4. **Continue a GUI session**: `lynn -s <session_path>` → opens an existing GUI session in CLI, message history intact, cache prefix preserved.
5. **Provider override**: `lynn --provider deepseek-pro` / `lynn --local` → force a provider tier without changing global config.

Stories 1-3 are the MVP shipping floor. Stories 4-5 ship in MVP if there is time, else v0.81 follow-up.

---

## 3. Architecture (boundary diagram)

```
┌──────────────────────────────────────────────────────────────────┐
│  Lynn CLI process  (lynn-cli / Node ≥20 / esbuild bundle)        │
│                                                                  │
│  ┌────────────────┐    ┌────────────────────┐                   │
│  │ commander CLI  │    │  Ink TUI (REPL)    │                   │
│  └────────┬───────┘    └────────┬───────────┘                   │
│           │                     │                                │
│           ▼                     ▼                                │
│  ┌──────────────────────────────────────────┐                   │
│  │  ConversationDriver                       │                   │
│  │  - Pillar 1 history layers                │                   │
│  │  - SSE consumer (undici)                  │                   │
│  │  - Tool dispatch (file/shell client tools)│                   │
│  └────────────┬──────────────┬──────────────┘                   │
│               │              │                                   │
│               ▼              ▼                                   │
│   ┌──────────────────┐  ┌─────────────────────┐                 │
│   │ Brain HTTP client│  │ Client tools        │                 │
│   │ (POST /v1/chat   │  │ - read_file         │                 │
│   │  /v1/web-search) │  │ - write_file        │                 │
│   └────────┬─────────┘  │ - edit_file (S/R)   │                 │
│            │            │ - bash              │                 │
│            │            │ - grep / glob       │                 │
│            │            └─────────────────────┘                 │
└────────────│─────────────────────────────────────────────────────┘
             │ HTTP/SSE on 127.0.0.1:8790 (brain v2 default)
             ▼
┌──────────────────────────────────────────────────────────────────┐
│  brain-v2-mirror (already running, possibly on a remote tunnel)  │
│  - router.ts (universalOrder cascade, cooldown, capability)      │
│  - search-context.ts (MiMo pre-search broker)                    │
│  - audio-transcribe.ts (Whisper fallback)                        │
│  - tool-storm.ts (loop guard)                                    │
│  - context-compact.ts (turn-end auto-compaction)                 │
│  - tool-exec/* (server-side tools: web_search, weather, ...)    │
└──────────────────────────────────────────────────────────────────┘
```

Key invariant: **the CLI process holds zero LLM/search API keys**. All keys (MiMo / Zhipu / DeepSeek / GLM) live in the brain v2 server process. The CLI only sends `{ messages, tools, extra_body }` and reads SSE chunks.

### What runs where

| Concern | CLI process | Brain v2 server |
|---|---|---|
| Argv parsing, REPL UI, Ink rendering | ✓ | — |
| Local file/shell tools (read/write/edit/bash/grep/glob) | ✓ — runs in user's cwd | — |
| Markdown / syntax-highlight rendering | ✓ | — |
| Session persistence (history JSONL) | ✓ — same path as GUI | — |
| Provider selection / fallback / cooldown | — | ✓ |
| MiMo/Zhipu/Bocha/Tavily/Serper search | — | ✓ via `/v1/web-search` |
| Audio transcribe fallback | — | ✓ (CLI never sees audio in MVP) |
| Tool-call storm guard | — | ✓ in brain |
| Local 9B MTP launch / health | — | ✓ via `/v1/local-qwen35-9b/*` |

---

## 4. Tech Stack (confirmed)

| Layer | Choice | Justification |
|---|---|---|
| Language | TypeScript | Reuse brain v2 / lib types directly. |
| Runtime | Node ≥ 22 | Match Claude Code / Reasonix; brain v2 already requires Node ≥ 20. |
| Dev runner | `tsx` | Existing repo standard (`node --import tsx`). |
| Bundler | `esbuild --bundle --platform=node --target=node22` | Single-file output, fast cold-start. |
| Distribution | npm: `@lynn/cli` global, `npx lynnc` ad-hoc | Standard for terminal LLM tools. |
| CLI parser | `commander@13` | Lightweight, mature. |
| TUI | `ink@5` + `ink-text-input` + `ink-select-input` | Same React mental model as desktop renderer. |
| HTTP/SSE | `undici` | Already brain v2 dep, native streams. |
| Markdown | `marked@14` + `marked-terminal@7` | Renders bold/code/lists in 256-color terminals. |
| Color | `chalk@5` | Standard. |
| Shell exec | `node:child_process` `spawn` + `tree-kill` | Avoid orphan PIDs. |
| File ops | `node:fs/promises` | Standard. |
| Search | `picomatch` (glob) + own `ripgrep`-aware `grep` (fallback to node) | Honor `rg` when present. |
| Session JSONL | shared with GUI store under `~/.lynn/sessions/` | See §8. |
| Logging | `pino` to `~/.lynn/cli.log` (json, rotating) | Same logger family as brain v2. |
| Tests | `vitest` | Repo standard. |

Hard rule: **no new heavy dep without a doc note**. The deps above are exhaustive for MVP.

---

## 5. File Layout in the Monorepo

```
cli/                           ← new directory at repo root
├── package.json               (own deps, but resolved against root node_modules where possible)
├── tsconfig.json              (extends ../tsconfig.json, paths to brain-v2-mirror / lib / server)
├── bin/
│   └── lynn.mjs               (#!/usr/bin/env node — esbuild output)
├── src/
│   ├── cli.ts                 (commander entry, argv → command dispatch)
│   ├── commands/
│   │   ├── chat.ts            (default REPL command)
│   │   ├── one-shot.ts        (lynn -p / lynn --prompt)
│   │   ├── code.ts            (coding agent loop)
│   │   ├── sessions.ts        (lynn sessions list / show / rm)
│   │   ├── version.ts
│   │   └── doctor.ts          (sanity check: brain reachable? keys ok?)
│   ├── brain-client.ts        (HTTP+SSE client to brain v2 mirror)
│   ├── conversation.ts        (ConversationDriver: Pillar 1 layers + tool loop)
│   ├── history-layers.ts      (ImmutablePrefix / AppendOnlyLog / VolatileScratch)
│   ├── render/
│   │   ├── markdown.ts        (marked-terminal config matched to Lynn theme)
│   │   ├── chunk-renderer.ts  (SSE chunk → terminal effect)
│   │   ├── tool-render.ts     (tool_progress / web_search.sources panel)
│   │   └── fallback-banner.ts (cascade fallback visualization)
│   ├── tools/                 (CLIENT-side tool implementations — run in user cwd)
│   │   ├── read-file.ts
│   │   ├── write-file.ts
│   │   ├── edit-file.ts       (SEARCH/REPLACE blocks, idempotent)
│   │   ├── bash.ts            (allow-list + confirmation hook)
│   │   ├── grep.ts            (rg-aware, falls back to node)
│   │   ├── glob.ts
│   │   ├── list-files.ts
│   │   └── tool-registry.ts
│   ├── ui/
│   │   ├── App.tsx            (Ink root for REPL)
│   │   ├── PromptInput.tsx
│   │   ├── MessageList.tsx
│   │   ├── StatusBar.tsx      (token count, provider, MTP accept rate, cache hit %)
│   │   └── ConfirmDialog.tsx  (bash / write-file approval)
│   ├── session/
│   │   ├── store.ts           (read/write JSONL, shared schema with GUI)
│   │   ├── resume.ts          (continue a GUI session)
│   │   └── types.ts           (mirrors core session types)
│   ├── config/
│   │   ├── loader.ts          (~/.lynn/config.yaml + CLI flag overrides)
│   │   └── defaults.ts        (DeepSeek V4 Pro default, brain URL 127.0.0.1:8790)
│   ├── prefix-cache/
│   │   ├── hash.ts            (sha256 of immutable prefix region)
│   │   └── telemetry.ts       (parse `prompt_cache_hit_tokens` from response)
│   └── util/
│       ├── slash-commands.ts  (/clear /save /model /history /help)
│       ├── keybindings.ts
│       └── errors.ts
├── scripts/
│   ├── build.mjs              (esbuild bundle to bin/lynn.mjs + chmod +x)
│   └── dev.mjs                (tsx watch for iteration)
└── tests/
    ├── brain-client.test.ts
    ├── history-layers.test.ts
    ├── tool-registry.test.ts
    ├── slash-commands.test.ts
    └── session-store.test.ts
```

Total target: ~3.5K LOC TS for MVP (Reasonix is ~5K, we're thinner since brain v2 owns the heavy lifting).

---

## 6. Brain v2 Reuse Contract (explicit)

This is the single most important section — it's what justifies "1-2 week MVP".

### Direct imports (zero copy, type-stable)

| What we import | From | Used as |
|---|---|---|
| `ChatMessage`, `StreamChunk`, `ToolCall`, `ToolDefinition`, `Provider`, `ProviderId`, `ToolCallDelta`, `FallbackEntry` | `brain-v2-mirror/types.ts` | CLI's own SSE consumer + tool dispatch types. |
| `errorMessage`, `errorName` | `brain-v2-mirror/types.ts` | Error normalization. |
| `WebSearchSource`, `WebSearchPublicSummary`, `ToolPublicSummary` | `server/chat/tool-summary.ts` | Render web_search sources panel in terminal. |
| `summarizeToolExecution` | `server/chat/tool-summary.ts` | Reuse for client-tools result → tool_end shape. |
| i18n keys (`searchSynthesized`, `searchSources`, etc.) | `desktop/src/locales/{zh,en,ja,ko,zh-TW}.json` | Same labels as GUI. |

These imports are **type imports + pure-function imports** — no Electron, no React DOM, no renderer-only modules.

### What we do NOT import

- `desktop/src/react/**` — React renderer, has DOM deps.
- `desktop/src/main.tsx` etc. — Electron main process boot.
- `brain-v2-mirror/router.ts` — server-side routing logic, runs only in brain process.
- `lib/tools/web-search.ts` — agent-SDK shaped, expects `searchConfigResolver`. CLI uses brain proxy directly instead.
- `lib/tools/realtime-info.ts`, `stock-market.ts`, `weather.ts` — server-side specialized tools. CLI lets brain handle them.

### HTTP endpoints consumed

| Endpoint | Use |
|---|---|
| `POST /v1/chat/completions` | Primary chat SSE. `extra_body: { reasoning_effort, thinking }` passes through to provider. |
| `POST /v1/web-search` | Tier 1 search (just shipped, returns `{items, summary, sources}`). |
| `GET /v2/local-qwen35-9b/status` | Check local model state before suggesting fallback. |
| `POST /v2/local-qwen35-9b/setup` | (Optional MVP) `lynn doctor --setup-local` invokes this. |
| `GET /health` | Used by `lynn doctor`. |

CLI runs `lynn doctor` once on first launch to verify brain is reachable; persists last-good base URL in `~/.lynn/config.yaml`.

---

## 7. Command Surface (MVP exhaustive list)

```
lynn                          # default → REPL chat
lynn -p "..."                 # one-shot prompt to stdout
lynn -p "..." --no-color      # plain text mode (for piping)
lynn code                     # coding agent mode in cwd
lynn sessions list            # list session JSONL files
lynn sessions show <path>     # render a saved session
lynn sessions rm <path>       # delete with confirmation
lynn doctor                   # diagnose brain reachability, config, perms
lynn doctor --setup-local     # trigger local 9B install via brain endpoint
lynn version

# Inside REPL (slash commands):
/help        /clear        /save [name]      /history
/model [id]  /provider [id] /local           /pro      /flash
/edit        /undo         /sources          /exit
/copy        /share        /token            /cache
```

Flag reference:
- `--brain-url <url>` — override `BRAIN_V2_URL` for one run.
- `--provider <id>` / `--local` — force a provider/local.
- `--no-tools` — disable client tool dispatch (chat-only).
- `--effort {minimal,low,medium,high}` — reasoning effort hint.
- `--session <path>` — resume a session.

---

## 8. Session Store — Shared Schema with GUI

### Schema

GUI currently stores sessions under platform-specific paths (e.g. `~/Library/Application Support/Lynn/sessions/` on macOS). For MVP we standardize CLI on:

```
~/.lynn/sessions/<yyyy-mm-dd>/<session-id>.jsonl
~/.lynn/sessions/index.json       (id → title, lastTs, msgCount)
~/.lynn/config.yaml
~/.lynn/cli.log                   (rotating)
```

GUI continues to use its native path; the CLI also reads from there if env `LYNN_DATA_DIR` is set or if `~/.lynn/cli.config.yaml` `gui_path` is configured.

### Format (JSONL, append-only, byte-stable per Pillar 1)

One line per turn-event. Each line is a JSON object:

```json
{"t":"system","content":"...","ts":1717000000}
{"t":"user","content":"...","ts":1717000010}
{"t":"assistant","content":"...","reasoning":"...","provider":"deepseek-pro","ts":1717000020}
{"t":"tool_call","id":"tc-x","name":"read_file","args":{"path":"src/app.ts"},"ts":1717000021}
{"t":"tool_result","id":"tc-x","content":"file contents...","ts":1717000022}
{"t":"meta","prompt_tokens":1234,"completion_tokens":56,"cache_hit_tokens":1200,"ts":1717000025}
```

Append-only invariant: **never rewrite earlier lines**, **never reorder**. This is also what gives us prefix-cache stability (§9).

### Cross-frontend resume

`lynn -s <path>` reads the JSONL from start, reconstructs ChatMessage[], passes to brain v2. The GUI does the same. Same byte stream → same cache prefix → DeepSeek bills 10% rate.

---

## 9. DeepSeek V4 Pro Prefix-Cache Strategy

### Three layers (Reasonix Pillar 1, adapted)

```
ImmutablePrefix:
  system_prompt + tool_specs + few_shots
  → SHA256 pinned at session start, asserted on every turn
  → bytes flow into LLM request unchanged

AppendOnlyLog:
  [assistant_1, tool_call_1, tool_result_1, assistant_2, ...]
  → grows only by append
  → no edit-in-place, no reorder

VolatileScratch:
  - in-flight reasoning chunks before final assistant message
  - search context block (when brain proxy injects it)
  - audio transcript replacement (when brain proxy substitutes)
  → never persisted into AppendOnlyLog
  → never sent upstream after the turn it belongs to
```

### What we change vs current brain v2 chat flow

- `search-context.ts` already injects context **before the last user message**, which keeps the cache prefix for prior turns stable (verified in our prior audit). CLI relies on this; **does not duplicate the injection client-side**.
- CLI guarantees that when it constructs the next-turn `messages` array, it passes exactly the bytes of past turns (no whitespace mutation, no field reordering). The hash assertion catches drift.

### Telemetry surface

Brain v2 forwards DeepSeek's `usage.prompt_cache_hit_tokens` and `usage.prompt_cache_miss_tokens` (existing in DeepSeek API response). CLI shows this in the status bar:

```
provider: deepseek-pro  |  cache: 98.7%  |  cost: $0.012/turn  |  ctx: 4.2K/128K
```

Cache hit % drives our quality signal. Below 70% = something is rewriting the prefix → log a warning.

### What we explicitly do NOT do

- We do NOT cache LLM responses ourselves. DeepSeek's own prefix cache is the contract.
- We do NOT use `<<<NEEDS_ESCALATE>>>` model self-report in MVP. (Possibly v0.81; was discussed as Phase B.)
- We do NOT shrink prior tool results inside the CLI. `brain-v2-mirror/context-compact.ts` already does this on the server side (just landed).

---

## 10. The 9 "Rust TUI 不好用" Problems — Explicit Solutions

Listed because they're the only reason this project exists. Each problem maps to a concrete subsystem in this design.

| # | Problem in old Rust DS TUI | Lynn CLI solution | §  |
|---|---|---|---|
| 1 | No real agent loop — just chat shell | `ConversationDriver` runs tool-use loop; `lynn code` mode. | §3, §5 |
| 2 | Streaming SSE jitter / dropped chars | `undici` (battle-tested); chunk-level renderer with backpressure. | §4 |
| 3 | Markdown plain / no code highlight | `marked-terminal` + `chalk` 256-color; per-language fence highlighting. | §4 |
| 4 | No tool calls / function call | Full server + client tool dispatch (web_search via brain, file/shell client-side). | §5 §6 |
| 5 | Closes → history lost | JSONL append-only persistence, same path as GUI. | §8 |
| 6 | No GUI / IPC integration | Shared session store, can `lynn -s` to continue GUI session. | §8 |
| 7 | Manual API key config | brain v2 proxy = zero CLI keys; `lynn doctor` validates. | §3, §6 |
| 8 | No skills / plugins | (Non-MVP) v0.81 will add Reasonix-format `.lynn/skills/` reader. | non-goals |
| 9 | Chinese input weird | Use Ink's input handling which supports IME; emit `clusterCount` not `codePointAt` for slicing. | §5 |

---

## 11. Client Coding Tools (file/shell)

These are CLIENT-SIDE tools — they run in the CLI's process in the user's cwd, not on brain. They follow the same OpenAI tool-call schema, so brain v2 forwards them back unchanged (per `router.ts` client-forward branch).

| Tool name | Args | Approval gate | Notes |
|---|---|---|---|
| `read_file` | `{path, offset?, limit?}` | none | Honors `.gitignore` for safety. Max 2000 lines default. |
| `write_file` | `{path, content}` | always confirms | Diff preview before write. |
| `edit_file` | `{path, old_string, new_string, replace_all?}` | always confirms | SEARCH/REPLACE block. Idempotent if old_string == new_string. |
| `bash` | `{command, cwd?, timeout?}` | confirms unless allow-listed | Allow-list = `git status`, `git diff`, `ls`, `cat`, `head`, `tail`, `pwd`, `npm test`, `vitest run`. |
| `grep` | `{pattern, path?, glob?, multiline?}` | none | Uses `rg` if on PATH, else node fallback. |
| `glob` | `{pattern, cwd?}` | none | `picomatch`. |
| `list_files` | `{path?}` | none | First-level listing, max 200 entries. |

Each tool's `parallelSafe` flag (Reasonix-style) is set; read-only tools (`read_file`, `grep`, `glob`, `list_files`) get `true`, mutating tools (`write_file`, `edit_file`, `bash`) stay `false`. In MVP we don't parallel-dispatch yet (single tool per turn), but the flag is recorded for v0.81 promotion.

### Approval flow

When the model emits a `bash` or `write_file` / `edit_file` tool call, the CLI:
1. Pauses the stream.
2. Renders a confirm modal (Ink `<ConfirmDialog>`).
3. Shows the command/diff in full.
4. Three options: **(y)** approve once, **(a)** approve + add to session allow-list, **(n)** reject (becomes a tool error).
5. On reject the model sees `{ ok: false, error: 'user_declined' }` and continues.

---

## 12. Status Bar & Cascade Visualization (the actual UX)

ASCII mockup (real Ink will color):

```
┌────────────────────────────────────────────────────────────────┐
│ Lynn v0.80                                          ?:help     │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  > 帮我改一下 router.ts 的 fallback chain 的 cooldown          │
│                                                                │
│  ⚙ deepseek-pro (think:on) ...                                 │
│  📋 已综合: 当前 cooldown 是 300s,放宽到 60s 即可。            │
│  ▾ sources (mimo, zhipu) — lynn-brain/mimo                     │
│  ⚙ read_file router.ts                                         │
│    265 lines                                                   │
│  ⚙ edit_file router.ts                                         │
│    +1 -1 [view diff]                                           │
│                                                                │
│  ✓ 改好了。改在 router.ts:38 — cooldown_ms 300_000 → 60_000.   │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│ deepseek-pro | cache 99.2% | $0.014/turn | ctx 8.4K/128K | mtp - │
└────────────────────────────────────────────────────────────────┘
```

Status bar fields (right to left):
- `mtp -` or `mtp 60%` — MTP accept rate when local 9B is active.
- `ctx 8.4K/128K` — context usage.
- `$0.014/turn` — current-turn cost (only DeepSeek path; MiMo/local show `—`).
- `cache 99.2%` — DeepSeek prefix-cache hit ratio.
- `deepseek-pro` — current provider.

When cascade fallback fires:
```
⚠ deepseek-pro unavailable (cooldown) → spark-i-balanced → returned in 1.2s
```

---

## 13. Roadmap (MVP + post-MVP)

### MVP (target: 1-2 weeks, this v0.80 cycle)

1. **Day 1-2**: Scaffold `cli/` package, esbuild bundling, smoke test (`lynn -p "hi"`).
2. **Day 3-4**: `brain-client.ts` + `chunk-renderer.ts` + Markdown render. Working one-shot mode.
3. **Day 5-6**: Ink REPL, slash commands, session JSONL.
4. **Day 7-8**: Client tools (read/write/edit/bash/grep/glob) + approval gates.
5. **Day 9-10**: `lynn code` mode, web_search sources rendering, cascade banner.
6. **Day 11-12**: Status bar, cache telemetry, `lynn doctor`, polish.
7. **Day 13-14**: Tests, docs, internal dogfood, release alpha.

### v0.81+ (out of scope for MVP, listed so they don't sneak in)

- `<<<NEEDS_ESCALATE>>>` self-report (Reasonix Phase B).
- Reasonix-format / Claude-format `.lynn/skills/` loader.
- MCP client integration.
- Parallel tool dispatch (read_file batches).
- Plan mode (Claude Code style).
- Subagent spawn.
- Background job tracking.
- Native ANSI hyperlinks for source URLs (terminals supporting OSC 8).
- Token budget alerts.
- Tauri-based desktop variant — explicitly not pursued.

---

## 14. Open Questions (need answer before code)

1. **Package boundary**: ship `cli/` as a workspace inside the Lynn monorepo (single `package.json` + cli folder), or as a separate npm `@lynn/cli` published independently? My recommendation: **monorepo subfolder, separately published**. Build script in `scripts/build-cli.mjs` produces a publishable `cli/dist/`.
2. **brain v2 URL discovery**: default `127.0.0.1:8790` works when Lynn GUI is running. If GUI isn't running, do we spawn a brain subprocess or refuse with `lynn doctor` guidance? My recommendation: **refuse + guide** in MVP; auto-spawn is a v0.81 quality-of-life.
3. **Confirm dialog default**: should `bash` confirm be `y` or `n`? My recommendation: **`n` default** (the Reasonix pattern), explicit user keystroke to approve.
4. **TTY width**: terminals 80 cols vs 120 cols. My recommendation: respect `process.stdout.columns`, gracefully truncate. No magic numbers.
5. **Logging**: do we ship a `--debug` flag that dumps raw SSE to stderr, or always go through `pino` file? My recommendation: **both**, file by default, stderr only with `--debug`.
6. **GUI session path discovery**: do we read from Electron's `app.getPath('userData')`? CLI can't easily do that without running Electron. My recommendation: **document `LYNN_DATA_DIR` env**; user sets once. v0.81 ships a `lynn doctor --import-gui` helper.
7. **DeepSeek key validation**: do we ask brain `/health` whether DS keys are configured, or just try and fail? My recommendation: **try and surface a clean error**; `lynn doctor` runs a tiny ping prompt with `max_tokens: 1`.

Answers go above before code lands.

---

## 15. Validation Plan (per multi-cli-collab-guide §"Testing Rules")

Before MVP merge:

```bash
# Type contract:
npm run typecheck
cd cli && npx tsc --noEmit

# Focused tests (vitest, repo standard):
npx vitest run cli/tests/brain-client.test.ts
npx vitest run cli/tests/history-layers.test.ts
npx vitest run cli/tests/tool-registry.test.ts
npx vitest run cli/tests/slash-commands.test.ts
npx vitest run cli/tests/session-store.test.ts

# Bundle smoke:
node cli/bin/lynn.mjs version
node cli/bin/lynn.mjs doctor
node cli/bin/lynn.mjs -p "hello" --no-color    # against running brain v2

# Bundle size cap:
ls -lh cli/bin/lynn.mjs   # must be ≤ 20 MB

# Cold start:
time node cli/bin/lynn.mjs version   # must be < 500ms on M-series
```

Release gate criteria:
- ✓ tsc passes both runtime and full.
- ✓ All cli/tests/*.test.ts green.
- ✓ Manual e2e: one-shot + REPL + code mode + session resume.
- ✓ Bundle ≤ 20 MB.
- ✓ Cold start < 500 ms (target 250 ms).
- ✓ `lynn doctor` against a stock brain v2 returns `ok=true`.
- ✓ No `@ts-nocheck` introduced (multi-cli rule).

---

## 16. Worker Dispatch Template (per multi-cli-collab-guide §"Suggested Dispatch Template")

If we later split this into parallel CLI work (e.g. one worker per `cli/src/` subdirectory), the dispatch template is:

```
You are CLI-N. Worktree: /private/tmp/lynn-cli-N-<area>
Branch: cli-N/lynn-cli-<area>

Goal:
- One sentence objective from §5.

Owned files:
- cli/src/<area>/**
- cli/tests/<area>/**

Forbidden files:
- cli/src/brain-client.ts (CLI-A owns)
- cli/src/conversation.ts (CLI-A owns)
- brain-v2-mirror/** (frozen)
- server/chat/tool-summary.ts (frozen)
- desktop/** (frozen)

Required:
- See §5 file list under your area.
- Tests under cli/tests/<area>.test.ts.
- npm run typecheck.

Done means:
- tsc passes.
- vitest run cli/tests/<area>.test.ts green.
- Bundle still ≤ 20 MB.
- No `@ts-nocheck` added.
- Commit message includes validation summary.
```

For MVP I (Claude) plan to do this single-handed. Parallel dispatch is reserved for v0.81+ if the surface grows.

---

## 17. Decision Log (recorded for future readers)

| Decision | Date | Rationale | Alternative considered |
|---|---|---|---|
| TS over Rust | 2026-05-28 | Reuse brain v2 main repo; LLM-wait dwarfs cold start; team expertise. | Rust binary (rejected: 50ms cold start gains invisible behind 1-3s first token). |
| `cli/` as monorepo subfolder | 2026-05-28 | Single source of truth, easier rebases. | Separate repo (rejected: type drift, painful sync). |
| DeepSeek V4 Pro primary | 2026-05-28 | Best reasoning + tool quality at < 5% Claude Opus cost; prefix-cache friendly. | V4 Flash (rejected for main: weaker on long tool chains). |
| brain v2 holds all keys | 2026-05-28 | Zero-key CLI UX; matches GUI; centralized rotation. | CLI reads env keys directly (rejected: duplicates GUI work, key exposure surface). |
| No MCP / skills / plan mode in MVP | 2026-05-28 | Time-box. Reasonix scope creep is the failure mode. | Ship full agent platform (rejected for MVP, queued v0.81). |
| Ink for TUI | 2026-05-28 | Same React mental model as renderer; what Claude Code & Reasonix use. | Pure terminal-kit / blessed (rejected: less hireable mental model). |
| Session JSONL append-only | 2026-05-28 | Enables prefix cache stability across CLI/GUI handoff. | SQLite (rejected: adds native dep, no append-only invariant by default). |

---

## 18. What I Need From You (review checklist)

Please confirm or push back on these specific items before code:

- [ ] §3 boundary diagram — is the CLI process / brain process split correct?
- [ ] §5 file layout — is `cli/` at repo root acceptable, or do you want it elsewhere?
- [ ] §7 command surface — anything missing from MVP, anything that should be cut?
- [ ] §8 `~/.lynn/sessions/` path standard — happy with the JSONL schema?
- [ ] §10 problem 8 (no skills in MVP) — confirmed cut, ok?
- [ ] §11 client tools approval flow — `bash` always confirms by default, ok?
- [ ] §14 open questions (1) — monorepo subfolder vs separate repo, your call.
- [ ] §14 open questions (2) — refuse vs auto-spawn brain on first run, your call.
- [ ] §14 open questions (6) — `LYNN_DATA_DIR` env vs GUI auto-discovery in MVP, your call.

Once these are answered I'll start coding the file scaffolding (cli/package.json, tsconfig, esbuild script, lynn.mjs binary stub) as the first PR. Subsequent PRs follow §13 day-by-day plan.

---

*End of design doc. Next action: human review.*
