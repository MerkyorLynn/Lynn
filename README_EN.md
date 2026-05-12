<p align="center">
  <img src=".github/assets/banner.png" width="100%" alt="Lynn Banner">
</p>

<p align="center">
  <img src="desktop/src/assets/Lynn.png" width="80" alt="Lynn">
</p>

<h1 align="center">Lynn</h1>

<p align="center">A personal AI agent with memory and soul</p>

<p align="center"><a href="README.md">中文版 (默认)</a> | <strong>English</strong></p>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](https://github.com/MerkyorLynn/Lynn/releases)

---

## 🆕 Recent Updates

<details>
<summary><strong>v0.77.11</strong> · 2026-05-09 · Deep Research desktop entry + quality gate + session persistence <em>(latest)</em></summary>

**Deep Research UX**:
- 🧠 **New `Deep Research` entry**:the chat composer now exposes a dedicated research toggle for multi-model research with quality review.
- 🧪 **Quality floor**:low-confidence winners, especially ambiguous abbreviations such as `A3B`, are rejected instead of being shown as final answers.
- 📌 **Transparent footer**:answers show the quality-review status, winner provider and candidate scores.

**Persistence and packaging**:
- 💾 **Session persistence**:`/api/deep-research` accepts `sessionPath`, so Deep Research user/assistant messages are appended to the local JSONL session and survive reloads.
- 🧩 **Explicit mode**:Deep Research does not hijack normal chat; users opt in from the composer.
- 📊 **Benchmarks archived**:tool-abstain and Qwen3.5 vs Qwen3.6 experiment files live under `tests/benchmarks/` for reproducibility.

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.11)

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

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.7)

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

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.6)

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

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.5)

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

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.4)

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

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.3)

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

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.2)

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

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.1)

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

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.76.9)

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

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.76.8)

</details>

<details>
<summary><strong>v0.76.7</strong> · 2026-04-27 · TTS end-to-end + Voice Phase 1 + CSP media-src fix</summary>

- 🗣️ **TTS playback wired up**: SenseVoice ASR + CosyVoice 1.0 SFT (7 built-in speakers), beige 🎤 button → ssh tunnel → frp → DGX docker
- 🎙️ **B-mode press-and-lock**: hold 600ms to lock continuous recording, tap again to stop
- 🔌 **Provider Registry framework**: Alibaba stack as default + 4 BYOK fallbacks (Faster Whisper / OpenAI Whisper / Azure / Edge TTS)
- 🔧 **CSP media-src fix**: vite CSP_PROFILES now allows `blob:` URLs to be loaded by Audio elements (the actual blocker for this release)
- 🛠️ **vite hono external**: vite.config.server.js fix so plugin dynamic imports resolve correctly
- 🪟 **IME stability**: Chinese input candidate switching no longer jitters; thinking blocks collapsed by default
- 📦 **3-platform notarization**: macOS Apple Silicon + Intel + Windows all notarized, mirror site synced

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.76.7)

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

[Full Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.76.6)

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

👉 [Full release history · GitHub Releases](https://github.com/MerkyorLynn/Lynn/releases)

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

**Free built-in models (Brain v2)** — Quick Start ships with a built-in model pool. v0.77.7+ routes through brain v2 with multi-tier auto-fallback:

```
T1  ⭐ Xiaomi MiMo v2.5-pro (default head; enable_search built-in web search + thinking)
T2  GPU Qwen3.6-35B-A3B FP8 (128K window; self-hosted SGLang+MTP on DGX Spark)
T3  DeepSeek V4-flash / V4-pro (cloud, long context)
T4  Zhipu GLM-5-Turbo / GLM-5.1 (coding plan)
T5  Kimi K2.6 (api.kimi.com coding plan, 256K window)
T6  Step-3.5 Flash / MiniMax M2.7-highspeed (last-resort)
```

No API key needed — device authentication only. MiMo upstream supports `thinking:{type:"disabled"}` fast-mode (simple chat TTF -51%). Some tiers go through DGX Spark GPUs which require physical access; cloud tiers remain available as fallbacks.

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
