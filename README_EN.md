<p align="center">
  <img src="desktop/src/assets/Lynn.png" width="80" alt="Lynn">
</p>

<h1 align="center">Lynn</h1>

<p align="center"><strong>Open-source desktop AI assistant · see where every chat & task stands · realtime voice · long-term memory</strong></p>
<p align="center">An open-source desktop AI agent. The main window keeps you focused on the conversation — see how far each chat has gotten and what still needs attention, manage files, and review every change it makes. When you want to run several tasks at once, Lynn's CLI can act as a background worker driven by Codex, Claude, Qwen, and other tools.</p>

<p align="center"><a href="README.md">中文版 (默认)</a> | <strong>English</strong></p>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](https://github.com/MerkyorLynn/Lynn/releases)
[![HuggingFace Models](https://img.shields.io/badge/HuggingFace-Lynn%20Models-ffcc4d)](https://huggingface.co/nerkyor)
[![ModelScope Models](https://img.shields.io/badge/ModelScope-Lynn%20Models-624aff)](https://modelscope.cn/models/Merkyor/Qwen3.8-27B-Coder390-EfficientThink-Opus5.5-GPT6Astra-Grok4.7-DSV4Pro-K3-SFT-RLOO-GGUF-NInfer)

---

## Lynn V0.87.4 · Step 5 Cloud + Coder390 Local

Lynn is an open-source AI agent with a desktop GUI and standalone CLI for search, files, coding and realtime voice. It also runs as a headless worker for other agents and CI. **GUI and CLI are both V0.87.4; the default working model is Step 5 Preview, not Step 3.7.**

[Download mirror (recommended)](https://download.merkyorlynn.com/download.html) · [V0.87.4 release notes](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.87.4) · [Primary GitHub](https://github.com/MerkyorLynn/Lynn) · [Backup GitHub](https://github.com/LynnMerkyor/Lynn) · [Gitee](https://gitee.com/merkyor/Lynn)

### Current Models and Runtime

| Purpose | Current model | Access |
|---|---|---|
| Default chat, coding and tool tasks | **Step 5 Preview** (`step-5-preview`) | Brain-hosted by default in GUI / CLI |
| Default cloud image understanding | **Step 5 native vision** | Send images directly; no separate vision API key |
| Realtime voice conversation | **StepAudio 2.5 Realtime** (`stepaudio-2.5-realtime`) | GUI microphone; `/voice` or `lynn voice` inside CLI chat |
| Local text and coding | **Qwen3.8-27B Coder390 EfficientThink** | Explicit installation and startup of llama.cpp Q2 / Q3 in Settings |
| Your own models | User-configured providers or compatible endpoints | Select in model settings; route aliases are not actual model names |

### Local Models: Coder390 Q2 / Q3

Source: [Merkyor / Qwen3.8-27B-Coder390-EfficientThink](https://modelscope.cn/models/Merkyor/Qwen3.8-27B-Coder390-EfficientThink-Opus5.5-GPT6Astra-Grok4.7-DSV4Pro-K3-SFT-RLOO-GGUF-NInfer). Lynn uses the repository's [`GGUF/` directory](https://modelscope.cn/models/Merkyor/Qwen3.8-27B-Coder390-EfficientThink-Opus5.5-GPT6Astra-Grok4.7-DSV4Pro-K3-SFT-RLOO-GGUF-NInfer/tree/master/GGUF), **not the NInfer variant**.

| Tier | Recommended capacity | Model file size | Initial context |
|---|---|---|---|
| **Coder390 Q2** | **16GB** GPU VRAM / Apple unified memory | 13.28GB | 4K, one slot |
| **Coder390 Q3** | **24GB or above**; at least 23.5GiB reported | 17.30GB | 8K, one slot |

- Both are **llama.cpp GGUF with built-in Q4 MTP**. No separate DFlash2 draft, NInfer runtime or local vision component is installed.
- Apple Silicon uses unified-memory capacity. NVIDIA uses the largest single GPU's VRAM, not summed GPUs or system RAM.
- **Installation and startup are blocked below 14GiB or when detection fails.** The 14–under-16GiB range only meets Q2's minimum; it is not the recommended tier.
- File size is not runtime memory use: KV cache, compute buffers and the OS need additional headroom.
- Installation and startup require explicit user action. Switching tiers preserves existing files; Settings offers Q2 / Q3 rather than recommending the old 9B / 4B models.

### V0.87.4 Highlights

**2026-10-28 same-version hotfix**: fix the local Qwen settings crash caused by an empty GPU list on Apple Silicon and machines without detected dedicated GPUs. Users of the original V0.87.4 package should download and reinstall the repaired build; the version number is unchanged.

- **Windows process polling:** hidden native system queries replace PATH-provided ps.exe and POSIX flags (#76).
- **FX fallback:** AllRatesToday daily ECB reference rates, with explicit source/time attribution and bounded caching (#77).
- **Enhanced CLI:** streaming tools, concurrent reads with write barriers, precise edits, background jobs, plan mode, skills and session forks.
- **Safer execution:** explicit permissions take precedence, broken guards fail closed, cancellation stops process trees, and read state is task-scoped.
- **Installer and web fixes:** preserve unrelated command links, validate redirect targets and propagate cancellation.
- **Dated evidence:** distinguish publication, retrieval and event times; verify conflicting news and structured data instead of presenting old events as current results.
- **Retrieved content stays distinct from user input:** check the original server-held request while keeping retrieved evidence available to the model.
- **Complete sports answers:** let the model finish its analysis after tool results arrive, and remove canned score predictions.

See the [V0.87.4 verification and follow-up record](docs/ops/v0874-follow-ups.md).

### Retained conversation features

- **Long reasoning stays connected:** OpenAI-compatible endpoints and the built-in Qwen bridge share a 600-second first-chunk timeout, a 600-second resettable idle timeout and no default model-wide deadline. Continued output can run beyond ten minutes. Saved settings and explicit environment overrides remain authoritative; settings and `Lynn doctor --offline` show effective values and their sources.
- **No punctuation-based continuations:** one recovery attempt is allowed for an explicit `finish_reason=length` or a reasoning-only empty answer, not because an English answer is short.
- **Delete conversations permanently:** confirmation-based deletion, individual archived deletion and archive clearing stop in-flight work and remove session files so late output cannot resurrect them. See the [timeout and deletion guide](docs/ops/local-stream-timeouts-and-session-deletion.md).

Retained V0.87.1 model and tool capabilities:

- **The model supplies parameters; tools execute them.** Weather, sports, markets and currency tools receive model-provided locations, dates, leagues, tickers and currency pairs instead of extracting entities from whole questions. Compound locations retain their meaning; the model can supply a parent location or coordinates when needed.
- **One default across GUI / CLI:** Step 5 handles ordinary chat, coding, tool tasks and cloud image understanding.
- **Realtime voice restored:** StepAudio 2.5 Realtime uses the shared Brain-hosted path. Enter voice inside CLI chat and return with `Ctrl+C`.
- **Review and evidence:** manual review now carries device authentication. Real image recognition, manual review and concurrent review are verified against installed packages; failure fallbacks do not count as successful results.
- **Explicit local requirements:** recommend the Coder390 tier by detected capacity, verify pinned sizes and SHA-256 values, and preserve older files and manual import.

Non-blocking review-relevance and redundant vision-completion observations are retained in the [follow-up list](docs/ops/v0871-follow-ups.md). Historical models and research results later in this README do not describe current defaults or Coder390 benchmark results.

### GUI and CLI

Use the desktop for conversations, files, task progress and change acceptance. Use the CLI for terminal chat, coding and headless workers. Both share the default model and tool-execution capabilities. JSON / JSONL output lets terminals, CI and other agents call Lynn without automating desktop windows.

### CLI Quick Install

```bash
# 1. Node requirement: Node.js 20 LTS or 22 LTS with npm.
# macOS: brew install node@20
# macOS/Linux: nvm install 20 && nvm use 20
# Windows: winget install OpenJS.NodeJS.LTS

# 2. Install or update from the Lynn mirror.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.87.4.tgz?rev=20261028"

# 3. Launch.
Lynn          # interactive chat TUI; type /voice or lynn voice for realtime voice
Lynn code     # coding-agent TUI
Lynn --version  # should print 0.87.4
Lynn agents   # copyable headless worker commands for other agents
```

Default Brain V2 route: **Step 5 Preview (`step-5-preview`)** for normal GUI/CLI chat, `Lynn -p`, and coding execution. Voice is Brain-hosted **StepFun Realtime (`stepaudio-2.5-realtime`)** by default: the GUI microphone and `/voice` / `lynn voice` inside the CLI chat enter continuous realtime conversation with live status and waveform. Local manager routes remain explicit experiments and do not take over the ordinary GUI/CLI path.

Long runs follow a Reasonix-style **prefix-cache discipline**: stable instructions, tool specs, runtime constraints, and resume summaries stay in deterministic context layers so turns do not reorder the cacheable prefix. Cache hits now appear as `prefix-cache ... hit` in usage, sessions, replay, and `Lynn cache doctor --json`, not as an anxiety-inducing context meter.

Machine-call contract:

```bash
Lynn code -p "fix tests, run the suite, summarize the diff" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox danger-full-access \
  --save-session
```

For exhaustive best-effort work, use `--best` (or `/goal` / `/best` in the TUI). Lynn enables a 300-step budget, ultra task decomposition, atomic workers, adversarial verification, auto-verify, checkpoints/resume, and runtime compaction. The harness does not choose the final answer for the model; it only decomposes, schedules, verifies, repairs, and prevents tool storms.

Agents should parse JSONL, not the human terminal TUI. See [`docs/ops/lynn-code-headless-agent-contract.md`](docs/ops/lynn-code-headless-agent-contract.md).

## 🆕 Recent Updates

The current version is **V0.87.4**; see the introduction for current models and installation requirements. The entries below are historical release notes. Their models, memory tiers and routing describe those older versions, not current installation recommendations.

<details>
<summary><strong>Lynn v0.86.8</strong> · 2026-09-08 · Kimi QR sign-in, conversation search and mobile continuation</summary>

- **Kimi Datasource**: sign in with your own account from MCP settings; the included official datasource connects automatically, with no Kimi CLI installation.
- **MCP OAuth**: HTTP/SSE discovery, PKCE, local callbacks and token refresh.
- **Conversations and files**: search saved message text and excerpts; use session-scoped file IDs and retain uploaded copies in the correct conversation.
- **Lightweight automation**: direct reminders and selected plugin actions alongside existing Agent tasks, with notifications and run history.
- **Mobile continuation**: opt-in QR pairing and revocation, existing conversations and file transfers; PWA installation requires HTTPS.
- **Optional leaf shadows**: a subtle interface layer, disabled by default.

[Release notes](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.86.8)

</details>

<details>
<summary><strong>Lynn v0.86.7</strong> · 2026-09-07 · Hardware-adaptive local models and guided deployment</summary>

- **Q3 / Q2 by GPU memory**: Qwen3.8-27B EfficientThink SimPO: Q3 + Q4 DFlash2 for 24GB+ dedicated VRAM (18.18GB of model files), or Q2 + Q4 DFlash2 for 16GB dedicated VRAM (14.14GB). Q3 starts at 8K context and Q2 at 4K, with one slot. KV cache, compute buffers and the operating system need additional memory. Apple unified memory is evaluated separately; 16GB unified memory is not treated as 16GB dedicated VRAM.
- **Complete installation**: checks or installs compatible llama.cpp, verifies main and independent Q4 DFlash2 files by pinned size and SHA-256, then checks runtime health before switching models. Existing files are preserved.
- **Guided recovery**: model-card navigation, manual tier selection, pause/resume and a “Let Lynn help me deploy” action that prepares a diagnostic chat draft without sending it automatically.
- **Separate runtime roles**: DFlash2 uses draft-dflash, not draft-mtp. Windows keeps its existing unsigned NSIS distribution and bundled basic CPU runtime; the new GPU runtime is prepared after explicit consent.

[Model card and detailed requirements](https://modelscope.cn/models/Merkyor/Qwen3.8-27B-EfficientThink-K3-Opus5-Grok4.6-GPT5.6Sol-SFT-SimPO-DFlash2-GGUF)

</details>

<details>
<summary><strong>Lynn v0.86.6</strong> · 2026-09-05 · Reliable automation and long-conversation performance </summary>

- **Keep early harness terminal events**: completion/failure notifications arriving with the start response no longer leave the loop waiting; early process exit also settles waiters. Includes all v0.86.5 UI and architecture repairs.
- **Keep complete answers after less-than comparisons**: ordinary expressions such as “duration < 5 minutes” no longer trigger unfinished-tag filtering; full-answer chunk replay guards against recurrence.
- **Lossless automation edits** preserve monthly, range, step, one-shot, and interval schedules. Assigned models can be reset to the default.
- **Saving and testing have separate outcomes**: a failed test keeps the saved job ID and a persistent explanation; retries cannot create duplicate jobs.
- **Isolated IM history** prevents delayed responses or errors from a previous conversation from replacing the active one.
- **Long conversations** start with the latest 80 messages and load older pages on demand. Rich history is windowed, and long responses use size-aware rendering intervals.
- **On-demand editor languages** separate CodeMirror core from optional parsers, backed by an editor-entry size budget.
- **Clearer boundaries and UI gates** separate created tasks from templates, settings CSS by domain, review policy from execution, and CLI persistence from presentation. Screenshots initialize real translations and cover editing, complex schedules, and retry states.

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.86.6)

</details>

<details>
<summary><strong>Lynn v0.86.4</strong> · 2026-09-01 · Automation UI and on-demand rendering</summary>

**v0.86.4 Automation experience and frontend engineering update**:
- **Readable Automation UI in dark mode**: templates, job cards, forms, status pills, and actions use theme-semantic colors instead of light-only surfaces and low-contrast text.
- **Modular Automation surface**: data access, draft state, the template library, and the editor are separate modules; Automation-specific CSS is no longer mixed into the shared Floating Panels stylesheet.
- **Real on-demand renderer loading**: Mermaid, Wardley, KaTeX, Markdown, and sanitization vendors load as separate asynchronous chunks, backed by a static dependency gate.
- **Visual regression in the release gate**: light and dark themes are checked at 1440×900, 1024×768, and 720×900 against six reviewed baselines.
- **Existing Agent-loop contracts remain intact**: Codex app-server auto-preflight, original-loop fallback, one-turn local-model recovery, empty-response cooldown, and GUI/CLI terminal-state tracing are preserved.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.86.4.tgz"
```

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.86.4)

</details>

<details>
<summary><strong>Lynn v0.86.3</strong> · 2026-08-27 · Agent-loop stability and deterministic fallback</summary>

**v0.86.3 agent-loop and cross-client reliability update**:
- **More reliable Codex harness auto-selection**: when the optional Brain status endpoint is unavailable, Lynn proceeds to the authenticated Responses route preflight instead of declaring the harness unsupported. Explicit `--harness codex` now validates the current provider, model, and authentication too. Human-readable headless runs show the selected harness and reason before execution.
- **Local-model recovery is scoped to one turn**: when the local 27B model returns no output, Brain can finish that turn without permanently changing the session's selected model. Queued follow-ups return to the user's original model.
- **Cross-turn cooldown for empty/reasoning-only candidates**: a candidate that stops without visible content is handed off immediately and put into a short cooldown, preventing the next turn from selecting the same unhealthy lane again.
- **Paired CLI TUI history**: when an Ink stream ends without a visible answer, Lynn no longer stores an empty assistant or leaves an unmatched user entry in model history. The UI shows a clear retry/model-switch message instead.
- **Traceable GUI completion sources**: normal, fallback, local-direct, and forced-close `turn_end` events now carry `streamSource` for reliable diagnostics.
- **Current Feishu integration**: the Feishu bridge now uses the current SDK Channel API while preserving messages, replies, files, and cards.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.86.3.tgz"
```

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.86.3)

</details>

<details>
<summary><strong>Lynn v0.86.2</strong> · 2026-08-22 · Codex app-server harness and Agent lifecycle</summary>

**v0.86.2 Agent harness and reliability update**:
- **Codex app-server harness for Lynn Code** maps threads, turns, streaming events, plans, tool lifecycle, approval requests, compaction, and interruption into Lynn's Agent run state while preserving the original loop.
- **`auto` is the default and decides before execution**. Lynn validates the app-server executable, protocol, Brain Responses capability, authentication, and the active provider/model route; any failed check selects the original architecture before the task starts.
- **No feature regression in exchange for a new harness**. Attachments keep the verified Lynn multimodal bridge, `--json` keeps per-tool audit events, `ask`/`never` keep strict approval semantics, and ultra multi-worker tasks keep the original loop. Explicit `--harness codex` is limited to the verified ordinary `yolo/on-failure` path and rejects incompatible combinations; `--harness legacy` pins the original architecture.
- **GUI and CLI share a terminal run lifecycle** for completed, failed, cancelled, partial, resumable, and tool-ledger state, reducing empty replies, double-finalization, and state left behind after cancellation.
- **BYOK and Brain retain their routing ownership**. BYOK keeps the user-selected provider/model; StepFun, DeepSeek V4 Flash, MiMo, GLM, and other Brain models remain Brain-routed independently of harness selection.
- **Windows local GGUF works out of the box**. The v0.86.2 Windows installer bundles a pinned `llama.cpp` runtime, required DLLs, its license, and SHA-256 manifest. The release gate extracts the final NSIS payload, loads a real GGUF, and completes two generations.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.86.2.tgz"
```

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.86.2)

</details>

<details>
<summary><strong>Lynn v0.86.1</strong> · 2026-07-12 · GUI/CLI interaction and local-model management</summary>

**v0.86.1 UX and reliability update**:
- Busy Ctrl+C now cancels only the active Ink turn and keeps the REPL alive; the full Ink PTY gate requires cancellation within one second and a clean final exit.
- CLI history uses persistent `Static` output, streamed Markdown is batched, tool start/end share one row, and the input line has a visible movable cursor.
- The default 27B Q4 imatrix MTP download reports real aggregate progress, shard count, speed, and ETA, with pause/resume/cancel/delete controls.
- Eligible devices can snooze the local-model recommendation for seven days or dismiss it permanently; low-spec devices remain free of proactive prompts.
- Session search is always visible, long chats have a jump-to-latest button, low-frequency composer controls live under More, and Stop gives immediate feedback.
- User-facing errors no longer expose opaque transport codes, and warm/dark theme secondary text now meets a stronger contrast baseline.
- High-stakes answers use heterogeneous review: DS V4 Flash remains the fast asynchronous reviewer, while a DS V4 concern on medical, legal, financial, or current-fact answers can trigger one time-bounded MiMo 2.5 Pro Token Plan arbitration. It never blocks or automatically rewrites the original answer, and both GUI and CLI expose the structured outcome.
- All V0.86 security boundaries remain enabled and covered by security, Agent regression, CLI100, GUI100, packaged, signing, and notarization gates.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.86.1.tgz"
```

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.86.1)

</details>

<details>
<summary><strong>Lynn v0.86.0</strong> · 2026-07-12 · Security boundaries and runtime reliability</summary>

**v0.86.0 security, runtime, and UX update**:
- Model-driven browser sessions deny microphone, camera, location, notification, and storage access by default; navigation and subresources pass DNS/SSRF checks.
- Authorized execution remains inside the OS sandbox; SSH/cloud credentials, browser profiles, Lynn tokens, and agent configuration are deny-read paths.
- IPC trusts known window identities and rejects failures with trace IDs; local HTTP/WS validates Host, Origin, and the per-launch token.
- Windows finds `llama-server` through `where.exe`, while manual GGUF startup now reports real ready/failure, missing-runtime, timeout, crash, and port-conflict states.
- Per-session prompt admission, explicit turn-end fallback tests, larger reconnect state, and removal of legacy internal retry state prevent cross-turn contamination.
- Brain now strips pseudo-tool markup across stream chunks while the client keeps its final defensive sanitizer.
- CLI streaming supports Ctrl+C cancellation, strict flags, command-level help, consistent non-TTY exits, and Windows-safe external worker argv execution.
- Fleet workers appear in Activity, voice shows RTT and traffic, renderer recovery is visible, and i18n/dialog focus gaps are closed.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.86.0.tgz"
```

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.86.0)

</details>

<details>
<summary><strong>Lynn v0.85.10</strong> · 2026-07-11 · Session Progress and Agent reliability</summary>

**v0.85.10 runtime and UX update**:
- **Clearer Session Progress**: the right rail presents the current session once, collapses older details by default, and exposes explicit Open Session / New Branch actions with keyboard-accessible expansion state.
- **No cross-turn transient state**: each turn centrally resets tool, retry, parser, timer, sanitizer, and temporary-output state so retrying one prompt cannot pollute the next.
- **Ordinary answers stay in chat**: deliverable tools are exposed only for explicit reports, HTML, PDF, PPT, attachments, or exports; lists, world-building tables, code, and explanations remain normal messages.
- **Fallbacks get real time budgets**: Step, DS V4 Flash, MiMo Token Plan, local, and GLM candidates have bounded attempts, with reasoning-only and incomplete answers handed to the next candidate.
- **Evidence tools are intent-scoped**: lookup, citation, weather, market, score, and news prompts still get live tools; timeless planning and writing no longer trigger unnecessary searches.
- **Architecture gates are stronger**: WebSocket transport, layout control, and Engine/Agent boundary helpers are separated, with a runtime import-cycle gate and a real Session Progress component regression test.
- **The local 27B Agent path stays intact**: Q4 imatrix MTP download and `draft-mtp` startup remain the default; coding and tool tasks still enter the full Agent loop.
- **Compact empty states**: the right rail grows with its content instead of stretching an empty history surface, and delayed patrol refreshes are cancelled when the rail unmounts.
- **Packaging follows the real gate**: macOS and Windows `dist` commands enter the full release gate, including Agent regression, CLI100, and GUI100.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.10.tgz"
```

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.85.10)

</details>

<details>
<summary><strong>Lynn v0.85.8</strong> · 2026-07-09 · Windows local-27B startup hotfix</summary>

**v0.85.8 local-model hotfix**:
- **Fixes GitHub #2 Windows 27B startup failure**: some Win11 environments ship a llama.cpp binary that does not support the v0.85.7 MTP / reasoning / KV-cache flags, so the model verified and then the server exited. Lynn now strips unsupported optional flags based on the local binary's actual help output.
- **Main chat no longer looks like "nothing happened"**: the chat input listens for llama.cpp failed/crashed events, clears the optimistic starting state, and shows a visible error with a Settings handoff.
- **Settings shows the real failure reason**: the local-model panel now surfaces `child-exited`, startup timeouts, and recent child process output.
- **Confirms #75 `python3_not_found` is covered by the current path**: desktop setup continues to use the Electron main-process downloader / manager, so clean installs do not require Python.
- **Keeps the v0.85.7 edge-model chain**: the default local model remains the public 27B Coding Q4 imatrix MTP; low-config devices are not proactively prompted, and 9B / 4B remain explicit downgrade choices.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.8.tgz"
```

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.85.8)

</details>

<details>
<summary><strong>Lynn v0.85.7</strong> · 2026-07-07 · 27B Coding Q4 MTP default edge model</summary>

**v0.85.7 edge-model and release-flow update**:
- **Default local edge model is now public 27B Coding Q4 MTP**: Settings recommends the `Qwen3.6-27B-DSV4Pro-GLM52-SFT-GPT55-RL-Coding-GGUF` Q4 imatrix MTP four-shard GGUF, about 19.6GB.
- **Model links fixed**: README, release notes, download pages, and app model entry points now link to the public ModelScope / HuggingFace GGUF mirrors.
- **Low-config devices stay quiet**: underpowered machines no longer get a proactive 27B install prompt; 9B / 4B remain explicit downgrade choices in Settings.
- **Fixes local-model `python3_not_found`**: desktop setup uses the Electron main-process downloader first, so missing Python no longer blocks Settings → Models → load local model.
- **Release discipline tightened**: every new release or hotfix must sync `LynnMerkyor/Lynn`, `MerkyorLynn/Lynn`, Gitee `merkyor/Lynn`, and the Tencent download mirror; `release:verify-remotes` now checks all three code remotes by default.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.7.tgz"
```

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.85.7)

</details>

<details>
<summary><strong>Lynn v0.85.6</strong> · 2026-06-28 · local file-read fix + release gate coverage</summary>

**v0.85.6 client fix and release coverage**:
- **Fixes IJV6WH explicit absolute file reads**: when the user asks Lynn to read `/Users/.../main.tex`, Lynn reads that file instead of falling back to the current workspace or reporting an empty directory.
- **Stops `file://` meta-questions from triggering fake directory reads**: questions like "why was the file:// protocol blocked?" are treated as explanation requests, not local prefetch requests.
- **Prevents previous file-task pollution**: a prior ComfyUI, `main.tex`, or other file task no longer leaks into the next ordinary question; regression coverage includes the ComfyUI → main.tex stale-answer path.
- **Handles large explicit files more safely**: pointed local files use a capped preview so a huge LaTeX/code file does not freeze or flood the model context.
- **Improves Windows path compatibility**: `D:\...`, `D:/...`, and `%20` encoded paths are treated as local file paths instead of URL/protocol text.
- **Stabilizes settings deep links**: opening Model Services from chat or local-model prompts no longer occasionally lands on About; the installed-app gate now covers provider-list and model-removal regressions.
- **Release gates included**: this client build passed the requested CLI100 gate, packaged server / CLI smoke, remote CLI install smoke, macOS notarization/Gatekeeper checks, three-remote sync verification, and GitHub CI; daily life, public-service/legal, medical, education, travel, recruiting, office, industry ops, coding, and fiction-writing prompts now live in the same regression bank, so GUI and CLI are no longer relying on manual spot checks alone.
- **Keeps v0.85.5 UX changes**: Session Progress, 27B local recommendation, no proactive low-config local-model prompt, and hidden-reasoning fallback remain in place.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.6.tgz"
```

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.85.6)

</details>

<details>
<summary><strong>Lynn v0.85.5</strong> · 2026-06-27 · Session Progress rail + local model recommendation chain</summary>

**v0.85.5 UX and release update**:
- **Turns the right rail into Session Progress**: it now prioritizes the current session, items needing attention, recent sessions, and a lightweight preview. Historical session cards have an explicit Open button, and the current session can focus input directly.
- **Removes internal jargon and empty panels**: "map/materials/patrol/in progress/closed" copy is simplified to "progress/files/sync/active/done/needs attention"; empty related-session space falls back to recent sessions.
- **Confirms the edge model ladder**: Lynn now recommends **Qwen3.6-27B DSV4Pro GLM52-SFT-GPT55-RL-Coding LynnStyle Dense** by default: Q5 for 32GB, Q4 for 24GB, Q3 for 16GB, and Q2 as an 8GB experimental tier. 9B / 4B stay explicit low-config downgrades, while 35B-A3B remains a legacy option. Low-config machines do not get a proactive 27B install prompt.
- **Makes local startup more direct**: the chat input local-model prompt can prepare and start the 27B path directly instead of sending users through Settings first.
- **Guards against hidden-reasoning short answers**: when hidden reasoning consumes the turn but the visible answer is only a tiny fragment, Lynn adds a visible fallback and triggers auto-review.
- **Keeps the v0.85.4 retry-answer fix**: retrying an assistant answer no longer pollutes later fresh prompts with stale replacement targets.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.5.tgz"
```

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.85.5)

</details>

<details>
<summary><strong>Lynn v0.85.4</strong> · 2026-06-25 · retry-answer pollution fix + regression gate</summary>

**v0.85.4 hotfix**:
- **Fixes retry-answer state pollution**: after clicking retry on an assistant answer, Lynn rolls back from the matching previous user message and resends through the normal prompt path. A later new question no longer reuses the old prompt, old `replaceFromMessageId`, or old branch target.
- **Failed sends stay out of the transcript**: retry / edit-resend failures restore the draft only, without optimistically adding a stale assistant turn that can poison the next request.
- **Adds an exact regression test**: the store test now covers retry followed by a fresh question and asserts the second WebSocket payload is the new prompt with no stale replacement parameters.
- **Keeps the v0.85.3 quality fixes**: sports direct evidence closure, local data-analysis direct answers, safer evidence fallback, Windows workspace fixes, Session Runtime split, and mirror update feed remain included.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.4.tgz"
```

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases#v0.85.4)

</details>

<details>
<summary><strong>Lynn v0.85.3</strong> · 2026-06-25 · ReAct evidence-quality fixes + Session Runtime split</summary>

**v0.85.3 hotfix and quality fixes**:
- **GUI / CLI sports evidence closure**: when `sports_score` returns direct ESPN evidence, Lynn now closes on that evidence instead of letting generic search, local task lists, or stale scores overwrite the answer.
- **Stronger ReAct discipline for first-seen questions**: the default path decides whether tools are needed, observes usable tool evidence, then summarizes only from that evidence; failed tools no longer produce unrelated local-task or generic-search conclusions.
- **Direct answers for small local data analysis**: arithmetic / business-analysis prompts now answer directly instead of falling into `step_execute` timeouts.
- **Windows D-drive workspace fix**: selecting a workspace outside the user home now persists `last_cwd`, `cwd_history`, and `desk.trusted_roots` immediately, so Desk files and new sessions no longer fall back to the old folder.
- **IJV6WH evidence fallback fix**: file-read paths, LaTeX package/template fragments, and `\includegraphics` snippets are no longer treated as completed factual analysis.
- **Stale-task regression coverage**: edit-resend, assistant retry, and failed-send paths are covered so a new question does not continue the previous task branch.

**Stable core and work map**:
- **Stabilized v0.85 self-built core**: Lynn keeps the no-fork, no-Pi-SDK main path and folds the latest empty-answer, evidence-integrity, GUI/CLI parity, and provider-reliability findings into release verification.
- **Session Runtime split**: `create-session.ts` no longer carries the OpenAI/tool-continuation adapter and evidence fallback helpers inline; the public API stays stable while the runtime becomes easier to verify and repair.
- **Session Map workbench**: the right sidebar now follows the current thread's work map, inspection state, evidence, and branch-from-here controls instead of acting as a loose note pile.
- **Huge-session health markers**: session inspection marks large, huge, blocked, and archived states so multi-GB histories become visible risk nodes instead of GUI-freezing entries.
- **Simpler main UI**: the GUI no longer surfaces the Fleet command deck or standalone notes; MCP setup lives in Settings. Parallel worker power remains in `Lynn worker run` / `Lynn agents` for terminals, CI, and other agents.
- **GUI and CLI remain aligned**: both packages verify against Brain V2, evidence-first routing, tool events, and visible final-answer closure.
- **Brain ops fixes**: repaired one corrupt device JSON behind `internal auth error`, moved v2 healthcheck / cron-smoke to signed HMAC requests, and stopped old v1 smoke noise from probing an expired MiMo key.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.85.3.tgz"
```

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases#v0.85.3)

</details>

<details>
<summary><strong>Lynn v0.84.5</strong> · 2026-06-14 · BYOK DeepSeek stability + realtime search and market fixes</summary>

**Issue #74 and BYOK model closure**:
- **DeepSeek V4 Pro / V4 Flash verified in real multi-turn chats**: provider ids are normalized, unreadable legacy API keys show an explicit re-entry prompt, and duplicate provider entries no longer route models to an empty-key provider.
- **Thinking-model empty-turn poisoning fixed**: hard-empty assistant turns now persist a visible fallback and are stripped before the next prompt, so one blank BYOK turn no longer breaks the whole thread.
- **DeepSeek V4 context and output budget fixed**: V4 Pro / V4 Flash keep 1M context while their output budget returns to a provider-safe cap.
- **Provider settings cleanup**: deleting deprecated or discovered models no longer makes them loop back into the add-model list; blank saves do not overwrite an existing key.
- **Search, sports, and market tools hardened**: BYOK tool search uses the Brain GLM/MiMo chain first and no longer treats Baidu/Bing search pages as evidence; World Cup schedules, NBA scores, gold prices, and US stocks such as NVDA use structured or parseable sources.
- **Release gates**: the local app package passed packaged server / CLI / settings smokes, plus real DeepSeek V4 Pro / Flash multi-turn verification.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.5.tgz"
```

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.84.5)

</details>

<details>
<summary><strong>Lynn v0.84.4</strong> · 2026-06-13 · Agent local-file task hotfix + GUI/CLI tool-boundary gate</summary>

**Default-model Agent workflow hotfix**:
- **GUI / CLI local-file task fix**: default model turns now receive a real local workspace summary. Read-only requests such as "find the first local novel chapter", "read my desktop file", or "inspect this folder" no longer fail with a false no-filesystem-access refusal.
- **Deterministic read-only fallback**: simple local file searches can be answered from the local scan before a model guesses or refuses, so file secrets / chapter snippets return reliably.
- **Tool-boundary fix**: Brain-managed realtime tools and client-side local tools are filtered separately. Lynn no longer suppresses the entire GUI/CLI client-tool surface during Brain turns.
- **Local Qwen bridge narrowed**: utility and coding tasks no longer bypass the tool chain through the direct local-model bridge.
- **Pseudo tool-call cleanup**: fake `<tool_call>` / `<function=...>` style text is stripped from server streaming and frontend rendering.
- **Agent task-matrix gate**: a new release gate covers GUI + CLI local novel/file reads, routing, tool boundaries, pseudo-tool leakage, and live smoke tests.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.4.tgz"
```

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.84.4)

</details>

<details>
<summary><strong>Lynn v0.84.2</strong> · 2026-06-12 · StepFun default route + realtime voice + GUI empty-answer recovery</summary>

**GUI and CLI ship together**:
- **StepFun 3.7 Flash default route**: normal GUI/CLI chat, `Lynn -p`, and coding execution use StepFun 3.7 Flash by default. Experimental manager paths stay explicit.
- **Realtime voice primary path**: GUI microphone and `/voice` / `lynn voice` inside the CLI chat use Brain-hosted StepFun Realtime for continuous conversation; the CLI renders status and a live waveform below the chat. ASR/TTS utility commands remain auxiliary.
- **GUI empty-answer recovery**: stale device signatures are refreshed per request, and Brain no longer closes a tool turn after 8 seconds if the final assistant answer is still arriving.
- **reasoning-only retry**: Brain retries responses that contain reasoning but no visible answer at the source.
- **honest tool-turn close**: tool completion is rendered factually while waiting for the model's final answer; no silent close and no fake local summary.
- **GUI token/cost pipeline**: SDK usage now flows through WebSocket, store, and the input-row chip.
- **Fleet discoverability and acceptance panel**: desktop Fleet entry points and acceptance UI are easier to find and inspect.
- **Issue #72/#74 data isolation and repair**: Lynn no longer reads or migrates `~/.hanako` by default; import is opt-in via `LYNN_IMPORT_HANAKO_ON_FIRST_RUN=1`. Existing polluted `~/.lynn` installs repair retired MiMo/TokenPlan model references back to the Brain default route while preserving user API keys.
- **Safety and bug-fix rollup**: device-signature refresh, honest tool-turn close, reasoning-only retry, Fleet acceptance UI, release gates, and doc-drift checks ship together.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.2.tgz"
```

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.84.2)

</details>

<details>
<summary><strong>CLI v0.80.6</strong> · 2026-06-01 · prefix-cache visibility + long-run stability hotfix</summary>

**CLI-only hotfix; the desktop app remains v0.80.1**:
- **Prefix-cache visibility**: Reasonix-style stable prefix / resume history / volatile runtime / current user layers remain deterministic; usage, sessions, replay, and `Lynn cache doctor --json` now surface `prefix-cache ... hit` without adding a context-budget anxiety meter.
- **Runtime compaction during long tool loops**: `Lynn code --long` compacts older turns while preserving the original goal, current plan, and recent tool results; JSONL emits `code.runtime.compacted`, and the human TUI shows a lightweight info card.
- **Early Brain stream retry**: if an SSE stream disconnects before any visible answer, reasoning, or tool call, the CLI retries with backoff; once output has started, it avoids retrying to prevent duplicate half-turn tool calls.
- **Plan/tool card polish**: `update_plan` and resume plan echoes use Claude-Code-like plan cards, while route/tool/compaction events stay on the same left-gutter card language.
- **Release gate covers compaction**: `cli-longrun-smoke` now forces large tool results and requires a `code.runtime.compacted` event, so long-run stability is verified outside narrow unit tests.

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.84.4.tgz"
```

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.80.6)

</details>

<details>
<summary><strong>v0.80.1</strong> · 2026-05-31 · CLI stability hotfix + remote Brain fallback</summary>

**V0.80.1 stability hotfix**:
- **CLI works without the desktop app**: when the local Brain is unavailable, `Lynn` falls back to the hosted Brain route so fresh installs can chat immediately.
- **No noisy build prompts**: same-version build refreshes no longer interrupt users; only true version upgrades ask for confirmation.
- **Decode speed meter**: chat/code status bars show recent estimated decode TPS without adding context-budget anxiety.
- **Packaged Fleet runtime**: the desktop app bundles the same CLI runtime used by the mirror tarball, so GUI Worker Fleet can spawn real workers after packaging.
- **Release surfaces updated**: mirror install docs, GitHub release notes, README snippets, and CLI agent contract stay aligned.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.80.1)

</details>

<details>
<summary><strong>v0.80.0</strong> · 2026-05-30 · CLI Worker Fleet + StepFun/MiMo Brain Route</summary>

**Lynn's programming-focused release**:
- **Lynn CLI / Lynn Code**:new `@lynn/cli` package with Ink TUI, markdown/code rendering, real diff preview, multimodal input, `Lynn code -p ... --json`, and `Lynn agents`.
- **GUI Worker Fleet**:fan-out tasks to multiple CLI workers, inspect logs/diffs/tests/gates, and perform gated merges.
- **Brain V2 route**:StepFun 3.7 Flash (high reasoning + 32K reasoning/generation budget) → MiMo V2.5 Pro/Omni → Spark Qwen 3.6 35B A3B.
- **Long-run stability**:tool-result reinforcement, chain-tool hints, tool-storm guard, session checkpointing, frame repair, git snapshots, and stable context layers.
- **Local 9B opt-in**:Qwen3.5-9B MTP no longer auto-starts on app launch; users explicitly enable it when they want local inference.
- **Release gates**:CLI install docs, mirror tarball, packaged CLI runtime, and headless agent contract are part of the release checks.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.80.0)

</details>

<details>
<summary><strong>v0.79.9</strong> · 2026-05-29 · Risk Boundary Split + Search Source UI</summary>

**Final V0.79 stability release**:
- 🧩 **Five risk-heavy centers split**:`InputArea`, `stock-market`, `mcp-client`, `bridge-manager`, and `engine/agent` now have clearer module boundaries, reducing future conflict and regression risk.
- 🔎 **Safer, inspectable search**:web search prefers the brain v2 localhost proxy first, keeping paid search keys server-side; chat tool cards can expand synthesized answers and search sources.
- 🧭 **Local model upgrade window**:Qwen3.5-9B Q4_K_M imatrix MTP remains the default local onboarding model. Older 9B GGUF files now show as upgrade candidates, and 9B/35B download entries point to the ModelScope MTP repositories with MTP + thinking-on kept as default.
- 🛡️ **Runtime regression coverage tightened**:composer replacement, local Qwen status, stock-market, MCP transport, bridge streaming/attachment, session events, engine tool runtime, agent dynamic prompt, web-search, and search source UI all gained or updated focused tests.
- ✅ **Release gate**:V0.79.9 passed typecheck, runtime typecheck, full vitest, release static/live regressions, UI smoke, macOS signing/notarization/stapling/Gatekeeper validation, and Windows installer signing.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.79.9)

</details>

<details>
<summary><strong>v0.79.8</strong> · 2026-05-28 · Chat Runtime Split + CosyVoice Streaming</summary>

**Stability and maintenance-cost release**:
- 🧩 **Chat runtime split**:`server/routes/chat.ts` is now under 500 lines, with request normalization, hub event forwarding, prompt turn running, WebSocket control, tool finalization, and local model bridging split into `server/chat/*`.
- 🔊 **True streaming CosyVoice TTS**:Spark `lynn-tts.service` pins the GPU startup path, while the chat speaker prefers reader + PCM streaming playback and falls back to the file-based path when needed.
- 🧪 **TTS inspection hardened**:`brain-tools-inspection` now checks CosyVoice through both health and a real lightweight synthesis probe, and MiMo TTS uses the token-plan endpoint with both auth headers.
- 🧭 **Local model upgrade window**:Qwen3.5-9B Q4_K_M imatrix MTP remains the default local onboarding model; older 9B GGUF files now show as upgrade candidates instead of default-ready models. The 9B/35B download entries point to the ModelScope MTP repositories, and startup keeps MTP + thinking-on by default.
- ✅ **Release gate**:the V0.79.8 candidate passed `npm run release:gate`:typecheck, runtime typecheck, full vitest, server/main/renderer builds, static regression, and Electron UI smoke.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.79.8)

</details>

<details>
<summary><strong>v0.79.7</strong> · 2026-05-28 · LynnEngine TS + final central runtime cleanup</summary>

**V0.79 final central TypeScript cleanup release**:
- 🧱 **LynnEngine facade is now TypeScript**:`core/engine` moved from JS to TypeScript, bringing agent/session/config/model/plugin composition into runtime typecheck.
- 🔁 **Legacy import compatibility**:existing `HanaEngine` imports remain available as a `LynnEngine` alias, so plugins and older code do not need an immediate rename.
- 🧰 **Tool safety boundaries are typed**:tool guards, tool aliases, on-demand MCP activation, sandbox options, and event dispatch now have typed wrappers.
- 🧭 **Earlier central migrations remain gated**:`server/routes/chat`, `core/session-coordinator`, and `core/agent` stay covered by the same release gate.
- 🧭 **Local model policy unchanged**:Qwen3.5-9B Q4_K_M imatrix MTP remains the default local onboarding model; 4B remains a low-config downgrade with the thinking-on risk documented.
- ✅ **Release gate**:V0.79.7 passed `typecheck:runtime`, full `typecheck`, full `npm test`, release static/UI/live regressions, and package/notarization gates.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.79.7)

</details>

<details>
<summary><strong>v0.79.3</strong> · 2026-05-25 · TypeScript safety migration + notarized package</summary>

**V0.79 architecture hardening release**:
- 🧱 **TypeScript migration keeps moving**:`server/chat` leaf helpers, lightweight `server/routes` modules, and shared runtime utilities are now typed, reducing string typos and unguarded `unknown` values in hot paths.
- 🔎 **Release gate tightened**:V0.79.3 passed full `npm test`, `typecheck`, `typecheck:runtime`, server/main/renderer builds, and targeted regression tests after the merge.
- 🧭 **Local model policy unchanged**:Qwen3.5-9B Q4_K_M imatrix MTP remains the default local onboarding model; 4B remains a low-config downgrade with the thinking-on risk documented.
- 🧾 **Chat/artifact paths are easier to maintain**:stream emitters, turn state, artifact recovery, tool summaries, and voice fallback helpers now have TS boundaries ahead of the larger `chat.js` and core split.
- 🧪 **Core migration deferred intentionally**:`core/session-coordinator.js`, `core/engine.js`, and similarly large files stay out of this package to keep the release stable.
- 📦 **macOS release artifacts are notarized**:Apple Silicon and Intel DMGs are signed, notarized, stapled, and Gatekeeper-validated; Windows ships as a signed NSIS installer.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.79.3)

</details>

<details>
<summary><strong>v0.79.2</strong> · 2026-05-25 · Stability patch + TypeScript migration foundation</summary>

**V0.79 stabilization patch**:
- 🧭 **Local onboarding stays on 9B by default**:Qwen3.5-9B Q4_K_M imatrix MTP remains the default; 4B stays as a low-config downgrade with the thinking-on risk documented.
- 🌦️ **Weather and realtime tools hardened**:weather answers now follow the tool-returned absolute dates and precipitation wording instead of misreading relative day ranges.
- 🔁 **Brain v2 fallback stabilized**:Spark APEX-MTP fallback now uses the canonical model id, disables thinking by default for fallback, and has configurable cold-start health probe timeouts.
- 🧾 **Deep Research artifact shape unified**:local, BYOK, and default model paths all create clickable HTML preview cards in chat.
- 🧱 **Architecture debt cleanup**:`brain-v2-mirror` continues its TypeScript island hardening, while `server/chat` leaf helpers and `core` provider/LLM contracts now have migration-safe type boundaries.
- ✅ **Release gate**:full `npm test` passed, `typecheck:runtime` was added, brain-v2 `tsc + 104 tests` passed, and release preflight covers build/regression gates.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.79.2)

</details>

<details>
<summary><strong>v0.79.1</strong> · 2026-05-25 · Default local model stays on Qwen3.5-9B MTP, 4B as downgrade</summary>

**Default local tier swap**:
- 🧠 **Default Qwen3.5-9B Q4_K_M imatrix MTP**: 5.38 GB · 24GB VRAM/unified memory recommended · MTP acceleration · stable thinking-on first. Spark retests confirmed 4B can think for a long time and return no visible answer with thinking-on, so it is no longer the default onboarding model.
- 🎚️ **Three-tier hardware ladder**:
  - **Default (24GB VRAM/unified memory+)**: Qwen3.5-9B Q4_K_M imatrix MTP — stronger quality, MTP acceleration
  - **Low-config downgrade (8~16GB optional)**: Qwen3.5-4B Q4_K_M imatrix (Lynn) — thinking-off recommended; thinking-on may think for a long time and return no visible answer
  - **High-end (24GB VRAM/unified memory+)**: Qwen3.6-35B-A3B Q4_K_M imatrix — MMLU 90.40% / GPQA Diamond 80.70% · Lynn-calibrated · 21 GB
- 🔁 **Smooth migration**: old 4B default configs migrate back to 9B MTP; 4B remains an explicit low-config downgrade.
- 🧾 **Deep Research HTML reports**: local 9B, BYOK, and the default model now create a clickable HTML report inside chat; local/BYOK thinking models retry with no-think fallback when the first response has no visible answer.
- 🛡️ **Architecture and safety refresh**: the chat route is split into smaller service modules, local GGUF downloads validate source and file type, and model status/token copy now comes from provider state to avoid 4B/9B confusion.
- ✅ **Test matrix**: installed-app smoke passed for 9B MTP, GPT-5.4, and the default model; Deep Research HTML artifact gates passed for local/BYOK/default paths; the 4B thinking-on risk is documented in the model guide.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.79.1)

</details>

<details>
<summary><strong>v0.79.0</strong> · 2026-05-22 · Local 9B offline inference + local model manager</summary>

**Local model release**:
- 🧠 **Local 9B MTP for daily offline use**:Qwen3.5-9B Q4_K_M imatrix MTP is now the default one-click local model path. Lynn prepares llama.cpp, downloads and verifies the GGUF, starts a local OpenAI-compatible `/v1` endpoint, and registers the provider after user authorization.
- 📦 **Local model manager**:Settings → Models supports in-app 35B GGUF download, user-provided GGUF import, endpoint inspection, and stopping the local runtime to release memory.
- ⏳ **Warmup feedback**:the first local reply now explains the 30-60s weight-load/context-warmup window and shows staged progress instead of leaving users waiting.
- 🧭 **Brain V2 migration**:legacy Brain endpoints migrate to the V2 canonical endpoint; GLM Coding Plan uses the dedicated coding endpoint; empty-answer recovery remains a fallback, not a model-output override.
- ✅ **Regression gate**:full test suite `168 files / 1447 passed / 1 skipped`,TypeScript, renderer build, local install, and GUI smoke passed.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.79.0)

</details>

<details>
<summary><strong>v0.77.11</strong> · 2026-05-09 · Deep Research desktop entry + quality gate + session persistence</summary>

**Deep Research UX**:
- 🧠 **New `Deep Research` entry**:the chat composer now exposes a dedicated research toggle for multi-model research with quality review.
- 🧪 **Quality floor**:low-confidence winners, especially ambiguous abbreviations such as `A3B`, are rejected instead of being shown as final answers.
- 📌 **Transparent footer**:answers show the quality-review status, winner provider and candidate scores.

**Persistence and packaging**:
- 💾 **Session persistence**:`/api/deep-research` accepts `sessionPath`, so Deep Research user/assistant messages are appended to the local JSONL session and survive reloads.
- 🧩 **Explicit mode**:Deep Research does not hijack normal chat; users opt in from the composer.
- 📊 **Benchmarks archived**:tool-abstain and Qwen3.5 vs Qwen3.6 experiment files live under `tests/benchmarks/` for reproducibility.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.77.11)

</details>

<details>
<summary><strong>v0.77.7</strong> · 2026-05-05 · Performance optimizations + dangerous-command detection hardening</summary>

**Performance (brain v2 side, all users benefit immediately)**:
- 🚀 **MiMo fast-mode passthrough**: Lynn ThinkingLevelButton 'off' → Pi SDK `reasoning_effort: off` → brain v2 translates to MiMo `thinking:{type:"disabled"}`. **Simple chat TTF-Content -51% (2.7s → 1.3s)**, first-byte latency nearly halved.
- 🌐 **HTTP/2 enabled**: nginx `api.merkyorlynn.com` upgraded with ALPN h2; SSE over H/2 cuts head-of-line blocking, TTFB ~50-100ms improvement.
- 🔌 **undici Pool keep-alive**: brain v2 upstream 16 connections + 30s keep-alive; **evening peak 3-concurrent -23%** (12.7s → 9.7s), resolves cold-connection stalls.
- 📊 **e2e smoke before/after**: HMAC valid -41% / stock_market -54% / web_fetch -38% / exchange_rate -33% / calendar -33% / multi-scenario -23~54%.

**Safety hardening (client)**:
- 🛡️ **Dangerous-command detection regex fix**: `commandLooksLike{Delete,MoveOrCopy,Create,LocalMutation}` previously missed `/bin/rm`, `./rm`, `exec rm` etc. absolute-path forms — confirmation card high-risk markers were absent. Fix:
  - leading set adds `/` (catches `/bin/rm` etc.)
  - trailing lookahead enforces strict boundary (prevents `rmdir-nope` filename false positives)
  - **51 new parameterized tests** (`tests/command-looks-like.test.js`) covering 17+11+10+4 positives + 6+3 negatives

**Brain provider reasoning passthrough**:
- 🧠 **`engine.js`** marks brain models default `reasoning: true` so Pi SDK's standard `reasoning_effort` field flows through to brain v2 (no extra client change needed).

**Monitoring updates**:
- 📊 Feishu health-check adds MiMo as primary + local GPU route rename + Kimi K2.6 (kimi-for-coding API) replaces K2.5 + brain v2 /api/v2 health probe.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.77.7)

</details>

<details>
<summary><strong>v0.77.6</strong> · 2026-05-05 · Brain v2 backend rewrite (transparent to users)</summary>

**Backend rewrite — invisible to users**:
- 🧠 **Brain v2 deployed**: 11k-line v1 monolith replaced by 5-module v2 (< 2000 LoC production), OpenAI-compatible, full Lynn client protocol preserved.
- 🚀 **MiMo `enable_search:true` as primary**: simple chat 2-5s, tool calls 5-10s, multi-turn web_search 7-10s.
- 🛠️ **16 server tools fully ported**: web_search / web_fetch / weather / exchange_rate / express_tracking / sports_score / calendar / unit_convert / create_artifact / create_pdf / stock_market / live_news / stock_research / create_report / create_pptx / parallel_research — all e2e verified.
- 🔧 **Fixed a v1 hidden bug along the way**: `create_pptx` was actually erroring in v1 due to deprecated pptxgenjs 4.0.1 fill API, v2 uses modern `{color}`.
- 🎯 **Zero client changes for fallback paths**: `<lynn_tool_progress>` markers + reasoning_content stream + tool_calls SSE fields are byte-identical to v1.
- 🔐 **HMAC sign verify reuses v1 device store**: legacy clients unaffected, new clients use new endpoint.
- 📊 **Monitoring online**: pulse every 5min (/health + ping chat) + smoke every 2h (4 core scenarios), Feishu alerts on failure.
- 🔄 **Natural rollout**: v0.77.6 routes to brain v2 (`/api/v2/`), v0.77.5 and earlier keep v1 (`/api/`), dual-stack for 30 days then v1 sunset.

**Quality gate** (all green):
- 90 vitest unit tests + 16 e2e smoke scenarios
- Server-side TypeScript / Lint / Build all pass

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.77.6)

</details>

<details>
<summary><strong>v0.77.5</strong> · 2026-05-02 · stoppable speech + WeChat bridge stability + voice latency</summary>

**Speech & voice**:
- 🛑 **Speech can be stopped anytime**: the chat "Read aloud" button is now a toggle — press again during a long playback to stop instantly. Switching messages or unmounting also stops audio.
- ⚡ **Voice first-token latency**: trimmed brain text_delta → TTS first-segment path; quicker first audio.
- 🧯 **Voice append race fix**: fixed "full text arrived but only the first audio segment played" (B2 race); server now adds a 150ms grace period plus a pendingAppendQueue double buffer.

**Bridge stability**:
- 🤖 **WeChat/Feishu weather queries no longer "empty answer"**: long conversation history caused A3B output to be over-stripped by the pseudo-tool detector and fall back to the empty-turn copy. The bridge now keeps the raw text when sanitize empties it, so users always see a reply.

**Regression**:
- Unit / Integration / Voice runtime / TypeScript / Lint / Renderer / Main / Server build all pass

**Hotpatch #1 (2026-05-02)** — Windows install ERR_DLOPEN_FAILED
- ⚠️ **Windows package re-published**: the initial Setup.exe shipped Mach-O `clipboard.darwin-*.node` files inside the win-x64 server bundle. Windows Node tried to dlopen the macOS dylib at startup and crashed with `ERR_DLOPEN_FAILED`.
- 🔧 Fixed `scripts/build-server.mjs` to sweep `@mariozechner/clipboard-*` for non-target platforms during Windows builds (mirrors the existing koffi platform-sweep block).
- ✅ Windows Setup.exe re-signed; GitHub Release & Tencent mirror updated. `latest.yml` size/sha512 refreshed.
- ✅ macOS dmgs are unaffected (only ever shipped darwin variants).

**Hotpatch #2 (2026-05-04)** — Windows install ERR_DLOPEN_FAILED (continued)
- ⚠️ **Hotpatch #1 was incomplete**: it cleaned `clipboard-darwin-*` from the server bundle, but desktop's `desktop/native-modules/aec/lynn-aec-napi.darwin-arm64.node` (V0.79 Phase 2 AEC native module, only prebuilt for Mac arm64) was still bundled into Win Setup.exe via electron-builder's `files` glob `*.node`. Win Node attempted to dlopen the Mach-O dylib at startup and crashed.
- 🔧 Added a native-modules platform-sweep pass to `scripts/fix-modules.cjs` afterPack hook: scans `app.asar.unpacked/desktop/native-modules/**` and removes any napi-rs-pattern `.node` (`*.{darwin|win32|linux}-*.node`) that doesn't match the current build target.
- ✅ Win Setup.exe size 204.5MB → 204.4MB (removed 132KB darwin-arm64.node); GitHub Release & Tencent mirror updated. `latest.yml` size/sha512 refreshed.
- ✅ macOS dmgs are unaffected (still ship darwin-arm64 prebuild).

**Hotpatch #4 (2026-05-04)** — Intel Mac startup ERR_DLOPEN_FAILED (better-sqlite3 ABI mismatch from cross-build)
- ⚠️ **Scenario**: After Hotpatch #3 shipped, Intel Mac users hit immediate crash — `better_sqlite3.node was compiled against NODE_MODULE_VERSION 115. This version requires NODE_MODULE_VERSION 127` (ABI mismatch)
- 🔧 **Root cause**: `scripts/build-server.mjs` cross-build (arm64 host → x64 target) used the host Node to run npm install. `prebuild-install` downloaded the better-sqlite3 prebuilt for the host's Node v20 (ABI 115) and dropped it into `dist-server/mac-x64/` — but that bundle ships its own Node v22 binary (ABI 127). At runtime, Node v22 dlopens an ABI-115 .node → instant crash. Apple Silicon was unaffected (host and target both v22). Hotpatch #1's sweep only checked `file` output (Mach-O arch), not the embedded NODE_MODULE_VERSION, so it slipped past.
- ✅ **Fix**: cross-build env now explicitly sets `npm_config_target=22.16.0` + `npm_config_runtime=node` + `npm_config_disturl=https://nodejs.org/dist`, forcing prebuild-install to download the v22-ABI-127 prebuilt for the target.
- ✅ **Verification**: actual dlopen + `new Database(':memory:')` instantiation test using each `dist-server/{platform}/node` binary — both mac arm64 and mac Intel now FULL OK. Windows Setup.exe shared the same root cause (arm64 cross-build → win32 x64) and was rebuilt the same way.
- ✅ All three artifacts (Mac arm64 / Mac Intel / Win x64) rebuilt, re-signed, re-notarized, and re-mirrored.

**Hotpatch #3 (2026-05-04)** — "Confirm delete" no-op old bug + brain lip-service defense + route metadata leak fix
- ⚠️ **Scenario 1**: user typed "delete the zip files in Downloads" → brain returned empty → Lynn fallback promised "reply 'confirm delete' to trigger execution" → user replied "confirm delete" → **empty again** (the old bug — files were never actually deleted). Even after re-injecting context, brain (Qwen3.6-A3B) may still "say 'understood, executing now' without calling bash" or emit a placeholder `bash {"command": "command"}` literal.
- ⚠️ **Scenario 2**: user sent a research-style long task ("research and analyse Chinese executive coaching circles — pricing, headcount, key features") → brain returned empty → Lynn's fallback ended with **"Kind: utility"** route-metadata leak (user-confirmed screenshot) — brain echoed the internal retry prompt's `任务类型: utility` line as user-visible text.
- 🔧 **Root cause 1**: the fallback text lied — Lynn had no mechanism to persist the prior turn's delete target to the session, so the 4-character "confirm delete" prompt entered brain as a standalone request with zero target info. Plus brain's tool-routing preference is flaky (V8 CODE-02 documented) — even with a strong prompt the model can still pick empty / lip-service / placeholder.
- 🔧 **Root cause 2**: `buildEmptyReplyRetryPrompt` embedded `任务类型:${routeIntent}` (intended as brain context), but a flaky brain echoed it back as "system narration" — same pollution pattern as `pseudoToolSteered`-path reflect-tag leaks.
- ✅ **Three-tier safety net** (guarantees the user's "confirm delete" results in a real delete):
  1. **Context persistence**: user sends a delete-class prompt → immediately stash `originalPrompt + requirement` to `ss.pendingMutationContext` (10-min TTL). Next turn matches a confirmation phrase ("confirm delete" / "confirm" / "yes" / "ok" / "go ahead" / etc.) → Lynn auto-rehydrates the prior prompt and re-injects the strict-execution retry prompt (`buildLocalMutationContinuationRetryPrompt` — strict execution requirements + known directory aliases + delete safety preamble).
  2. **Lip-service escalation retry** (Path A): if after rehydrate brain still empty / lip-service / `model_tool_error` / emits placeholder → Lynn intercepts the turn close and schedules one internal retry with a "CRITICAL ESCALATION" prompt (`buildPostRehydrateEscalationPrompt` — explicitly forbids placeholder strings, pseudo-tool markup, and lip-service phrasing).
  3. **Deterministic fallback** (Path B): if escalation retry still doesn't produce a real delete → Lynn server-side **synthesizes** a `find ${aliasPath} -name '*.${ext}' -delete` command directly, bypassing brain. Routes through `executeRecoveredBashCommand` and the confirmation card so the user gets a final approval before any rm runs.
  4. **Auto-clear on real delete**: when `rm` / `trash` / `find -delete` is detected in `lastSuccessfulTools`, `pendingMutationContext` is cleared to prevent pollution of the next turn.
  5. **Route-metadata leak — two-layer fix**: (a) `buildEmptyReplyRetryPrompt` no longer embeds `任务类型:${routeIntent}`; instead, it tells brain "do not echo system / routing labels (任务类型 / 类型 / Route / Kind)"; (b) added `stripRouteMetadataLeaks` and applied it to the persisted-assistant-text replay path (`extractLatestAssistantVisibleTextAfter`), so even leftover residue in old session history is stripped before being shown to the user.
- ✅ E2E dev verified across multiple runs (with brain in actively flaky state): `PENDING-DELETE-REQUEST v1` 100% fires, `MUTATION-CONFIRM-REHYDRATE v1` 100% fires, `POST-REHYDRATE-ESCALATE v1` fires when brain lip-services after rehydrate. Path B `POST-REHYDRATE-DETERMINISTIC v1` correctly synthesizes `find ... -delete` for Downloads/Desktop/Documents alias scenarios.
- ✅ +17 unit tests covering storage / consume / confirmation phrases / TTL / unrelated input / auto-clear on real delete / `find -delete` recognition / escalation-prompt forbidden phrasing / route-metadata strip / retry prompt no longer embeds `routeIntent`

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.77.5)

</details>

<details>
<summary><strong>v0.77.4</strong> · 2026-05-01 · compact voice waveform + interrupt fixes + tool stability</summary>

**Voice, tools, and report UX**:
- 🎛️ **Compact voice overlay**: the voice runtime now uses a small waveform card instead of a large transcript panel that can cover the input area.
- 🧯 **Interrupt handling fixes**: fixed THINKING/SPEAKING interrupt crashes, stale turns blocking new recording, and lingering "understanding..." placeholders after ASR failure.
- 🎙️ **ASR compatibility**: Qwen3-ASR now normalizes language names, infers WAV MIME type, and applies request timeouts.
- 🧰 **Local toolchain hardening**: more guardrails for pseudo tools, malformed bash, file-operation feedback, and dangerous-operation authorization.
- 🌦️ **Realtime evidence checks**: weather/market answers require actual evidence fields instead of homepage/navigation snippets.
- 🌐 **Translation and report artifacts**: chat translation, sanitized HTML artifacts, and PNG export are tightened.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.77.4)

</details>

<details>
<summary><strong>v0.77.3</strong> · 2026-05-01 · Lynn voice runtime + startup white-screen fix + long-reply speech</summary>

**Voice and startup stability**:
- 🎙️ **Lynn voice overlay**: the new voice entry now presents itself as Lynn instead of Jarvis.
- 💬 **Normal chat pipeline integration**: voice transcripts enter the current chat, so tools, memory, history, and reflection follow the same path as typed messages.
- 🗣️ **Default Chinese female voice restored**: spoken replies use the CosyVoice default female voice, with 22.05kHz WAV normalized to 16kHz PCM playback.
- 🔢 **Chinese number speech fix**: dates, temperatures, percentages, and stock codes are normalized before TTS so mixed English number readings do not leak into Chinese speech.
- 📚 **Sustained long-reply playback**: long answers are cleaned, split into small sentence/comma chunks, queued, and retried as smaller chunks when a segment fails.
- 🪟 **Startup white-screen fixes**: fixed the React selector update-depth loop and the splash screen path when `app-ready` is missed.
- 🧩 **Packaging hardening**: plugin standalone loading, `build:server` npm registry retry, and local cold-start verification are covered.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.77.3)

</details>

<details>
<summary><strong>v0.77.2</strong> · 2026-04-29 · weather evidence gate + HTML report styles + PNG export</summary>

**Report and realtime data UX**:
- 🌦️ **Weather evidence gate**: weather tools now require actual conditions, temperature, rain, or similar fields before a weather result is considered valid.
- 📰 **HTML report styles**: `create_report` supports `editorial-paper`, `finance-dark`, `magazine`, and `clean-briefing`, with deep reports defaulting to editorial-paper.
- 🖼️ **Artifact PNG export**: HTML artifacts can be previewed, opened in browser, and exported as PNG.
- 🎨 **frontend-design skill**: ships the Apache 2.0 frontend-design skill to improve generated HTML report quality.
- 🧯 **Turn quality gate hardening**: background, empty-answer, and fallback paths now recover more reliably.
- 🧼 **Streaming pseudo-tool cleanup**: unified cleanup of fake `<web_search>` / `<weather>` / `<bash>` tags.
- 🧩 **Runtime stability patches**: stream LRU, async EventBus errors, ChannelRouter locks, and plugin unload cleanup are hardened.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.77.2)

</details>

<details>
<summary><strong>v0.77.1</strong> · 2026-04-29 · guarded operations + pseudo-tool fallback + local task feedback</summary>

**Execution and safety UX**:
- 🛡️ **Dangerous-operation authorization cards**: delete, sudo, bulk move, overwrite, and similar high-risk commands now require confirmation in execute mode.
- 🎨 **Beige Lynn-style authorization UI**: the confirmation card now fits the app instead of using the old dark Codex look.
- 🧰 **Local task feedback hardening**: file organization, deletion, and move tasks must surface a visible final result after commands run.
- 🧼 **Pseudo-tool leak guard**: fake `<web_search>` / `<bash>` style text is detected and recovered instead of being shown to users.
- 🔁 **Empty-answer and retry fallback**: failed tools, preparatory lead-ins, and no-content retries now end with recoverable feedback.
- 📁 **File task recognition improvements**: better aliases for Desktop/Downloads and safer handling of zip/excel/pdf cleanup tasks.
- 🧪 **Release Regression Gate**: continues covering tool calls, file operations, pseudo-tool leaks, thinking leaks, and UI smoke.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.77.1)

</details>

<details>
<summary><strong>v0.76.9</strong> · 2026-04-28 · DeepSeek v4 + route reshape + brain tool fallback + UI stream fix</summary>

**Hotpatch #1 (2026-04-28 PM)**:
- 🛡️ **TOOL-FAILED-FALLBACK v1**: when a tool call fails AND the model only emitted a preparatory lead-in ("let me check…") before turn_end (typical: live_news / stock_market failure), automatically inject a system prompt that forces the model to retry **without** calling tools — give a cautious answer clearly labeled "general knowledge / not verified live", or honestly tell the user the data couldn't be retrieved. Fixes the "Lynn only answers half a sentence then stops" dogfood bug.
- 🧪 **+262 lines of tests** (`tests/chat-route-events.test.js`) covering TOOL-FAILED-FALLBACK trigger conditions, retry path, and locale.

**Model / routing ABD reshape**:
- 🚀 **DeepSeek API upgrade**: `deepseek-chat` → `deepseek-v4-flash` (non-thinking), `deepseek-reasoner` → `deepseek-v4-flash` (thinking mode with `thinking:{type:"enabled",reasoning_effort:"high"}`), new `deepseek-v4-pro` provider for routing.
- 🧠 **Explicit `thinking` field**: v4-flash defaults to thinking mode and burns tokens; brain injects `thinking:{type:"disabled"}` in chat chain and `enabled+high` in reasoner chain — no more empty `finish=length`.
- 🛣️ **chatOrder reshape**: Spark FP8 first (light tasks local-first) → local GPU wrapper → DeepSeek V4-flash → GLM/MiniMax/Step → K2.6 second-to-last → K2.5 last.
- 📚 **New creativeOrder** (novel/chapter/poetry/literary translation/style rewrite) → DeepSeek V4-pro first + K2.6 second + GLM-5-Turbo.
- 📜 **complexLongOrder K2.6 first** (200K+ context only K2.6 supports) → V4-pro → V4-flash → fallback chain.
- 📦 **Client BYOK compat**: `lib/known-models.json` + `lib/default-models.json` add v4-flash/v4-pro, old names marked `deprecated:true + alias`.

**Brain tool chain & timeout fallback**:
- 🛠 **stock_research NaN sanitize**: Tushare occasionally returns illegal JSON `:NaN/:Infinity`; auto-replace with `:null` before parse — no more 90s LLM fallback chain triggered by tool crash.
- ⏱ **web_search 25s total budget**: multi-source race (DDG+Zhipu) + WeChat+SearXNG fallback total capped at 25s; on timeout returns empty so model answers from context.
- 🚫 **HK bail v2 strict A-share whitelist**: tsCode must match `60/00/30/68/8X/92.SH/SZ/BJ`; rest (89xxxx fund / 4-digit HK / US tickers) bail to stock_market — **fixes "HK 700 → 890001 pseudo-report" bug**.
- 📊 **dataChunks guard**: deep research context aborts the report-template flow if zero real data chunks were fetched; tells the model to fall back instead of misleading the user.
- 🌐 **realtime-info multi-source enhancement**: gold / oil / market quote sources expanded with clearer failure messages.

**UI / client stream fixes**:
- 🔤 **\</user> chat-template tag no longer leaks to UI**: when streaming chunk boundary cuts `</user>` into `</us` + `er>`, buffer the partial close tag to next chunk so ORPHAN_CLOSE_TAG_RE catches it correctly.
- 🛎 **Slow-tool progress hint**: tools running >15s auto-emit `tool_progress slow_warning` event so UI doesn't feel frozen.
- 🧰 **Bash schema 3-layer fallback**: `extractToolDetail` + `TOOL_ARG_SUMMARY_KEYS` + `normalizeToolArgsForSummary` all accept `cmd/shell/script` aliases; Spark emitting `{cmd:"..."}` no longer renders as empty "Ran command".
- 🎤 **Recording permission ghost detection**: ≥0.4s + blob<1KB recognized as macOS TCC ghost permission; UI tells user to re-authorize Lynn in System Settings + restart app.
- 🔏 **install:local no longer drops permissions**: sign-local.cjs defaults to Developer ID instead of ad-hoc, cdhash consistent with electron-builder so macOS TCC no longer treats Lynn.app as a "new app".
- 🎙️ **PressToTalk UI polish**: button styles + state machine refactor; press-and-lock + recording feedback more stable.
- 🧱 **brain report-research-context boost**: `server/chat/report-research-context.js` injects more structured data so the model's report generation is more accurate.

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.76.9)

</details>

<details>
<summary><strong>v0.76.8</strong> · 2026-04-27 · BYOK-equality + Spark FP8 rollback + file management fix + bash schema fallback + recording permission UX</summary>

**Hotpatch #3 (2026-04-28 early morning)**:
- 🛠️ **Bash tool schema consistency**: `extractToolDetail` / `TOOL_ARG_SUMMARY_KEYS` / `normalizeToolArgsForSummary` all accept `cmd/shell/script` aliases; Spark emitting `{cmd:"..."}` no longer renders as empty "执行 命令".
- 🎤 **Recording permission friendly hint**: when user records ≥0.4s but blob<1KB, recognized as macOS microphone TCC ghost permission; UI tells user to re-authorize Lynn in System Settings + restart app.
- 🔏 **install:local no longer drops permissions**: `sign-local.cjs` defaults to Developer ID instead of ad-hoc, keeping cdhash consistent with electron-builder so macOS TCC no longer treats Lynn.app as a "new app" requiring re-authorization on every reinstall.
- 📝 **Brain long-answer stability** (server-side): `max_tokens` simple 1500→4000 / longForm 6000→8000; `__longFormRx` matches Chinese long-answer keywords (介绍/说说/讲讲/写一段/简介/教程...); `temperature` 0.6→0.4 for consistent re-asks.


- 🚨 **Emergency Spark rollback PRISM-NVFP4 → Qwen3.6-35B-A3B-FP8 + SGLang+MTP**: the heretic safety-removal pipeline broke tool-call decisiveness; curl-verified reasoning deadloop at 2048 tokens with no tool_call emitted. FP8 + "首先" injection + NEXTN MTP restored immediately.
- 🧠 **BYOK-equality refactor**: Lynn client no longer uses "scenario contracts + prefetch + force tools" to override routing — brain now follows the same autonomous-judgment path as BYOK (GPT/Claude/Kimi direct).
- 🔧 **File management classification fix**: verbs like "create / move / organize" + folder/directory/image objects always route to UTILITY/local_automation, no longer misclassified as vision/multimedia by the bare "image" keyword.
- 🛡️ **6 brain server patches**: HYBRID-1 (hasGpuTools→max=32K) / HYBRID-3 (reasoning guardrail) / B1 (`__needsFileTools`) / B2 (tightened `__isFileEditIntent`) / LYNN BYOK-equality / loop-breaker v4 (log-only, no enforcement — allows legitimate multi-step ls→mkdir→mv).
- 🤖 **New LLM Triage v1**: regex + Spark FP8 hybrid classifier with 5min cache, auto fallback to regex when Spark unreachable.
- 🛠️ **Bash args normalization**: tool-wrapper auto-coerces query/cmd/shell/script into `command`, recovering from Spark's occasional schema slip.
- 🎤 **Recording min-size guard**: PressToTalkButton rejects <1KB blob or <0.4s duration to prevent sensevoice 500 EBML header errors.
- ⌨️ **IME triple-OR**: `isComposing || nativeEvent.isComposing || keyCode === 229` — the last Chinese segment no longer drops on Enter submit.
- 🔇 **Empty-answer fallback**: when the model only thinks but never produces text → retry button shown (5 locales added).
- 🔠 **i18n**: Settings page Voice tab now displays "语音" (5 locales were missing the translation).
- 🚫 **Pseudo tool-call detection & recovery**: when the model writes `<web_search>...` / `web_search(query=...)` as plain text instead of a real tool_call, brain auto-steers back to the real tool flow and the user never sees the broken text.
- 🧪 **771/771 tests + 30 new regression cases** locking in "file-move-image never again misroutes to vision".

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.76.8)

</details>

<details>
<summary><strong>v0.76.7</strong> · 2026-04-27 · TTS end-to-end + Voice Phase 1 + CSP media-src fix</summary>

- 🗣️ **TTS playback wired up**: SenseVoice ASR + CosyVoice 1.0 SFT (7 built-in speakers), beige 🎤 button → ssh tunnel → frp → DGX docker
- 🎙️ **B-mode press-and-lock**: hold 600ms to lock continuous recording, tap again to stop
- 🔌 **Provider Registry framework**: Alibaba stack as default + 4 BYOK fallbacks (Faster Whisper / OpenAI Whisper / Azure / Edge TTS)
- 🔧 **CSP media-src fix**: vite CSP_PROFILES now allows `blob:` URLs to be loaded by Audio elements (the actual blocker for this release)
- 🛠️ **vite hono external**: server Vite config fix so plugin dynamic imports resolve correctly
- 🪟 **IME stability**: Chinese input candidate switching no longer jitters; thinking blocks collapsed by default
- 📦 **3-platform notarization**: macOS Apple Silicon + Intel + Windows all notarized, mirror site synced

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.76.7)

</details>

<details>
<summary><strong>v0.76.6</strong> · 2026-04-21 · Tools enhancement + research path + OAuth + 715 tests green</summary>

- 📈 **stock-market tool overhaul** (+425 lines): multi-source quotes + fault tolerance + 4 new tests
- 🧠 **Research context expansion** (+428 lines): structured weather/stock data injection, fused research path
- 🔧 **LLM client refactor** (+188 lines): provider-aware request building, more stable across providers
- 💭 **ThinkTag/XingParser expansion**: thinking-chain parsing covers 5 more scenarios
- 🔐 **OAuth path fix**: Lynn OAuth provider id correctly maps to auth.json
- 🎯 **Turn isolation TURN-FENCE v1**: when previous turn aborts with no output, next turn auto-isolates to avoid reading residue
- 🧪 **Tests**: 4 new + 7 expanded, `715/715 vitest all green`

[Full Release Notes →](https://gitee.com/merkyor/Lynn/releases/tag/v0.76.6)

</details>

<details>
<summary><strong>v0.76.5</strong> · 2026-04-21 · Encoding cleanup + local office answers + vision arg fix</summary>

- Encoding cleanup: intermittent garbled characters in LLM output now intercepted
- Local office answers: simple office math handled locally to avoid LLM mental-arithmetic errors
- Vision argument regression fixed (9 tests)
- Tool intent narrowing: fewer false-positive tool triggers

</details>

<details>
<summary><strong>v0.76.4</strong> · 2026-04-20 · ThinkTagParser v2 + FAKE-PROGRESS-GUARD v2 + 25s TTFT timer</summary>

- **ThinkTagParser v2**: thinking-tag parsing rewritten to handle more model formats
- **FAKE-PROGRESS-GUARD v2**: blocks LLMs from fabricating tool_progress messages
- **25s TTFT timer**: time-to-first-token timeout fallback for steadier UX
- **vLLM back to real A3B** (server-side): fixes prior version mistakenly using a dense model
- QA quality score: 1.3 → 4.42

</details>

<details>
<summary><strong>v0.76.3</strong> · 2026-04-19/20 · True streaming + Diff view + Brain concurrency 3×</summary>

- 20-hour marathon: true-streaming refactor, 10+ brain patches
- **vLLM tuning**: KV pool capacity 4×
- **WritingDiffViewer**: word-level red-strike / green-add, designed for writing
- **Loop-breaker v2**: detects tool-call infinite loops
- **Review routing**: cross-session task tracking

</details>

<details>
<summary><strong>v0.76.2</strong> · 2026-04-18 · Intel crash fix + tool aliases + Chinese thinking</summary>

- Fixed Intel Mac startup crash
- 6 tool-name aliases (read_file → read, etc.)
- Chinese thinking hit rate 91%
- ThinkingBlock R1-style rendering

</details>

<details>
<summary><strong>v0.76.1</strong> · 2026-04-17 · Task mode switching + on-demand MCP</summary>

- **Task mode chips**: ⚡ Auto / 📖 Fiction / 🖋️ Long-form / 🌶️ Social / ⌘ Code / 💼 Business / 🌐 Translate / 🔬 Research / 📝 Notes
- 7 social-mode slash commands (`/xhs` `/gzh` `/weibo` `/douyin` `/zhihu` `/hashtags` `/titles`)
- **On-demand MCP servers**: 0 MCP tools by default, enable per-need so the model isn't slowed down
- IME bug fix
- GPU 64K context support

</details>

👉 [Full release history · Gitee release mirror](https://gitee.com/merkyor/Lynn/releases)

---

## What is Lynn

Lynn is a personal AI agent for the desktop: it has memory, personality, writing tools, autonomous work loops, and now a path toward orchestrating coding work.

Early Lynn focused on bringing agent workflows out of the terminal so writers, researchers, operators, students, founders, and non-programmers could actually use them. V0.85.6 keeps that quieter GUI direction: chat, Session Progress, files, and acceptance stay on the desktop, while this release hardens local file reads and stale-task isolation; parallel workers remain available as headless CLI capabilities for terminals, CI, and other agents.

If you use Claude Code, Codex, or Cursor, Lynn should feel familiar but more like a workbench than a command deck. It turns the current thread, attention signals, evidence, files, automations, and branches into inspectable Session Progress. If you have never used those tools, you can still start from the GUI and gradually hand coding, documents, research, and automation work to Lynn.

## Who Lynn is for

**Good fit**

- Writers and researchers who want long-term memory, writing diffs, and deep research.
- Operators, founders, and product teams that need recurring work, reports, cross-platform messaging, and local file tasks.
- Developers and technical leads who want GUI Session Progress for acceptance, plus headless CLI workers for parallel tasks.
- Teams that want code work and business work to share one review and acceptance surface.
- People who want a desktop AI workspace instead of another browser tab.

**Not the best fit**

- If you only want code completion, use Cursor / your IDE.
- If you only want a single terminal agent, Claude Code, Codex CLI, or Gemini CLI may be simpler.
- If you are building a multi-tenant hosted agent service, use a server-first framework.

Lynn does not replace Cursor. Cursor owns the editor loop. Lynn owns the layer around the loop: goals, evidence, files, automations, branch state, review gates, reports, and long-term memory across the whole process.

## Lynn vs Cursor / Claude Code

|  | **Lynn V0.85.6** | Cursor | Claude Code / Codex CLI |
|---|---|---|---|
| Core shape | **GUI Session Progress + headless CLI workers** | IDE coding flow | Single CLI agent |
| Parallel work | **CLI worker / worktree / JSONL protocol** | Limited | Manually managed |
| Code acceptance | **Session Progress + GUI diff + test gates** | Inside IDE | Terminal output |
| Long-term memory | **6-layer persistent memory** | Session-level | Session-level |
| Writing and research | **Word-level diff + Deep Research** | Weak | Weak |
| Built-in keyless route | **Brain provider pool** | Subscription/API required | Provider key required |
| Multi-agent/persona | **Yuan templates + agent desks** | No | No |
| Platform bridges | **Feishu / Telegram / WeChat / QQ** | No | No |
| License | **Apache 2.0** | Closed commercial | Closed/commercial or mixed |

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

## Local models — hardware ladder

Hardware detection uses unified memory on Apple Silicon and the largest single NVIDIA GPU's VRAM reported by `nvidia-smi` on Windows/Linux. Host RAM and separate GPUs are never added to VRAM. Recommend Q2 at 16GB and Q3 at 24GB or above (at least 23.5GiB reported for the 24GB tier). Installation is blocked below 14GiB or when detection fails; manual selection cannot bypass this check. A 13GB device is insufficient. At 14 to under 16GiB, Q2 only meets the minimum and has limited context headroom. Model files, KV cache, runtime buffers and the OS all require memory; total capacity does not guarantee enough memory is currently available.

Qwen3.8-27B Coder390 EfficientThink: Q3 is the default at 24GB and above (17.30 GB main model). Below 24GB (16GB tier) uses Q2 (13.28 GB). Both GGUF files include built-in Q4 MTP. This install does not download a separate DFlash2 draft or a vision component. Q3 starts at 8K context and Q2 at 4K, with one slot. KV cache, compute buffers and the operating system need additional memory. Installation and startup require explicit user action. Older downloaded files remain until the user deletes them.

| Tier | Model | Size | Recommended hardware | Context | Capability signal |
|------|-------|:----:|---------------------|:-------:|-------------------|
| **24GB and above** | **Qwen3.8-27B Coder390 EfficientThink Q3** | 17.30 GB | Default at 24GB and above | 8K | Built-in Q4 MTP; one slot |
| **Below 24GB (16GB tier)** | **Qwen3.8-27B Coder390 EfficientThink Q2** | 13.28 GB | Below 24GB (16GB tier) | 4K | Built-in Q4 MTP; tighter memory budget |
| Legacy option | Qwen3.6-35B-A3B DSV4Pro Distill Q5_K_M imatrix MTP | 25.3 GB | 32GB VRAM/unified memory+ | 32K | Legacy 35B orchestrator path kept for existing users and comparison tests |

> See the [model card](https://modelscope.cn/models/Merkyor/Qwen3.8-27B-Coder390-EfficientThink-Opus5.5-GPT6Astra-Grok4.7-DSV4Pro-K3-SFT-RLOO-GGUF-NInfer) for model details. Model-file sizes are not runtime memory guarantees. Old model files are never silently deleted.

| Universal | Details |
|---|---|
| Runtime | llama.cpp local server, OpenAI-compatible `/v1` endpoint |
| Privacy | Fully offline capable; no API key required; conversations stay on device |
| Default thinking | Automatic: light tasks disable thinking; complex tasks can enable it in the Lynn composer |

### Downloads and mirrors

**Recommended Qwen3.8-27B Coder390 EfficientThink**:

- [Model card and GGUF files](https://modelscope.cn/models/Merkyor/Qwen3.8-27B-Coder390-EfficientThink-Opus5.5-GPT6Astra-Grok4.7-DSV4Pro-K3-SFT-RLOO-GGUF-NInfer)
- Download `GGUF/Qwen3.8-27B-Coder390-EfficientThink-Q3LynnStyle-MTP.gguf` or `GGUF/Qwen3.8-27B-Coder390-EfficientThink-Q2LynnStyle-MTP.gguf`. Both include built-in Q4 MTP; no separate DFlash2 draft is downloaded.
- Each GGUF file is checked against its pinned byte size and SHA-256; no vision component is included in this install.

**Historical 9B / 4B / 35B models (not current recommended tiers)**: these links are for existing users or manual deployment. The current Settings page no longer offers 9B / 4B installation; legacy models do not bypass Coder390 capacity checks.
- 9B: [Merkyor/Qwen3.5-9B-GGUF-imatrix-MTP](https://modelscope.cn/models/Merkyor/Qwen3.5-9B-GGUF-imatrix-MTP) / [Hugging Face](https://huggingface.co/nerkyor/Qwen3.5-9B-GGUF-imatrix) (`Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf`, **5.38 GB**) — low-config downgrade
- 4B: [Merkyor/Qwen3.5-4B-GGUF-imatrix](https://modelscope.cn/models/Merkyor/Qwen3.5-4B-GGUF-imatrix) (`Qwen3.5-4B-Q4_K_M-imatrix.gguf`, **2.6 GB**) — lower-config downgrade; thinking-off recommended
- 35B legacy: [Merkyor/Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill-GGUF](https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill-GGUF) / [Hugging Face](https://huggingface.co/nerkyor/Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill-GGUF) (`Qwen3.6-35B-A3B-DSV4Pro-Distill-MTP-Q5_K_M-imatrix.gguf`, **25.3 GB**) — legacy orchestrator path for existing users and comparison tests

In the app: **Settings → Models → Local Qwen3.8-27B → Select a tier → Install and start**. Qwen3.8-27B Coder390 EfficientThink uses Q3 at 24GB and above (17.30 GB) and Q2 below 24GB (16GB tier) (13.28 GB), with built-in Q4 MTP. Q3 starts at 8K context and Q2 at 4K, with one slot. Use **Let Lynn help me deploy** to bring a diagnostic draft into chat. Existing models and manual GGUF import remain available.

## Install and Go

Two paths on first launch. **Quick Start** requires zero API keys — a built-in default model works out of the box. Enter your name, grant permissions, start chatting. Want a stronger model? Connect your own provider anytime in Settings.

Lynn uses the OpenAI-compatible protocol, supporting any compatible provider (OpenAI, DeepSeek, Qwen, SiliconFlow, local models via Ollama, etc.). Some providers also support OAuth login. A nine-tier automatic fallback mechanism ensures conversations continue even when a provider is temporarily unavailable.

Interface available in 5 languages: Chinese, English, Japanese, Korean, and Traditional Chinese.

## Deep Optimization for Chinese Models

Lynn doesn't just slap an OpenAI-compatible wrapper and call it a day. From 9B small models to GLM-5 reasoning models, every tier has purpose-built adaptations:

**Free built-in models (Brain v2)** — Quick Start ships with a built-in model pool. V0.87.4 uses Step 5 Preview as the ordinary GUI/CLI default route, with vendor fallbacks and an explicit local manager path:

```
T1  ⭐ Step 5 Preview (step-5-preview, text/coding route)
T2  DS-V4 Flash (vendor fallback for StepFun outage or specific high-risk work)
T3  Local manager (explicit `Lynn manager run` experimental path)
T4  Vision: native Step 5 Preview (image content retained; no separate vision key required)
T5  Zhipu GLM / Kimi / MiniMax (vendor backup lanes)
```

No API key needed — device authentication only. The normal text/coding lane is Step 5 Preview first; local manager and alternate providers are explicit or fallback paths.

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

**Session Progress** is the async collaboration space between you and your Agent. The right rail is no longer a loose note pile or an internal map; it tracks the current session, attention signals, recent sessions, evidence, and branch-from-here entry without dragging the whole long context back into the model.

**Heartbeat** periodically scans the workspace, conversation state, and Session Progress. When new tasks appear, they're automatically processed and you're notified when done.

**Cron** lets Agents run scheduled work. Each Agent's cron jobs run concurrently and independently — switching Agents doesn't interrupt other Agents' schedules. Recurring work can be generated from chat plans and Session Progress.

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

**macOS (Apple Silicon / Intel):** download the `.dmg` for your architecture from the [download mirror](https://download.merkyorlynn.com/download.html); see the [V0.87.4 release notes](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.87.4). Official DMGs must pass Developer ID signing, Apple notarization, stapling and Gatekeeper validation before publication.

**Windows:** download the latest `.exe` installer from the [download mirror](https://download.merkyorlynn.com/download.html) and run it directly; release records live on [GitHub Releases](https://github.com/MerkyorLynn/Lynn/releases).

> **Windows SmartScreen notice:** The v0.86.8 release keeps the existing NSIS installation method and does not include a publicly trusted Authenticode code signature. Windows may show an unknown-publisher or SmartScreen prompt. Download only from the official channels above and verify the published SHA-256.

Linux builds are planned.

### First Run

Two paths on first launch:

- **Quick Start**: Enter your name → set permissions → jump right in. A built-in default model works out of the box — no API key required.
- **Local model**: Settings → Models → Local Qwen3.8-27B. Qwen3.8-27B Coder390 EfficientThink uses Q3 at 24GB and above (17.30 GB) and Q2 below 24GB (16GB tier) (13.28 GB), with built-in Q4 MTP. Q3 starts at 8K and Q2 at 4K, one slot. [Full model card](https://modelscope.cn/models/Merkyor/Qwen3.8-27B-Coder390-EfficientThink-Opus5.5-GPT6Astra-Grok4.7-DSV4Pro-K3-SFT-RLOO-GGUF-NInfer).
- **Advanced Setup**: Enter your name → connect your own provider (API key + base URL) → choose a **chat model** and a **utility model** → pick a theme → set permissions → enter.

Lynn uses the OpenAI-compatible protocol, so any provider that supports it will work (OpenAI, DeepSeek, Qwen, local models via Ollama, SiliconFlow, etc.). Some providers (e.g. MiniMax) also support OAuth login. All model settings can be adjusted later in Settings.

## Architecture

```
core/           Engine layer (LynnEngine Thin Facade + 8 Managers + 2 Coordinators)
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

**Engine layer**: `LynnEngine` is a Thin Facade holding AgentManager, SessionCoordinator, ConfigCoordinator, ModelManager, PreferencesManager, SkillManager, ChannelManager, BridgeSessionManager, ExpertManager, and PluginManager — exposing a unified API.

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
| macOS (Apple Silicon) | Supported (V0.86.4 notarized DMG) |
| macOS (Intel) | Supported (V0.86.4 notarized DMG) |
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
