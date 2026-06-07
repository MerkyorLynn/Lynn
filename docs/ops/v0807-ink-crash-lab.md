# Lynn CLI Ink Crash Lab (2026-06-03)

## Summary

Apple Terminal can run Lynn's current boxed-input renderer safely with Chinese IME. Forcing the old Ink/full-TUI path is not safe yet. The crash is reproducible at the Terminal.app process level, outside Node/Lynn's exception handling.

The decisive crash reports are Terminal.app reports, not Node reports. The newest reproduced case (`Terminal-2026-06-03-142729.ips`) aborts on the Terminal main thread with `BUG IN CLIENT OF LIBMALLOC: memory corruption of free block`; an earlier case (`Terminal-2026-06-03-142119.ips`) crashes in QuartzCore layer display (`CA::ColorProgram::Cache::set_colorspace`). Both reports include an HIE/input-method thread around the crash window.

The register pattern also points at TUI border output rather than ordinary prose. Repeated values such as `0x94e28094e28094e2` expand on little-endian ARM as `e2 94 80 e2 94 80 ...`, which is UTF-8 for U+2500 `─` (box drawing light horizontal). This matches Lynn/Ink border and sweep output. It is not U+2014 em dash (`e2 80 94`). That does not prove a single character is the whole bug, but it narrows the trigger to repeated box-drawing redraw pressure plus IME/Terminal rendering.

The important distinction is:

- Raw mode alone is not the root cause. Lynn's boxed input and Claude Code both use raw-style terminal input safely.
- The unsafe combination reproduced so far is Apple Terminal + full Ink tree redraw + Chinese IME composition + dynamic TUI updates. Animation makes it easier to trigger, but disabling animation is not sufficient by itself.

## Evidence

### Passing controls

- `LYNN_CLI_TERMINAL_IME_TURNS=6 node scripts/cli-terminal-ime-smoke.mjs`
  - Passed Terminal.app + Apple Pinyin/SCIM with the default boxed-input renderer.
  - No new Terminal diagnostic report was produced.
- `LYNN_CLI_TERMINAL_APP_TURNS=3 node scripts/cli-terminal-app-smoke.mjs --full-tui`
  - Passed full Ink TUI in Terminal.app for non-IME scripted commands.
  - No new Terminal diagnostic report was produced.
- `LYNN_CLI_TERMINAL_IME_TURNS=6 node scripts/cli-terminal-ime-smoke.mjs --full-tui --no-animation`
  - Passed a short full Ink TUI + Chinese IME run when TUI animation was disabled.
  - This is not sufficient for release safety: a longer 10-turn run still crashed Terminal.app.

### Failing cases

- `LYNN_CLI_TERMINAL_IME_TURNS=6 node scripts/cli-terminal-ime-smoke.mjs --full-tui`
  - Produced Terminal.app crashes during the experiment.
- `LYNN_CLI_PTY_FULL_TUI=1 node scripts/cli-pty-smoke.mjs`
  - Did not crash, but exposed an input protocol bug: bracketed paste (`ESC [200~ ... ESC [201~`) is rendered as ordinary text in the Ink path and the smoke cannot complete.

### Crash signatures captured

Terminal diagnostic reports created during forced Ink/IME experiments:

- `~/Library/Logs/DiagnosticReports/Terminal-2026-06-03-140642.ips`
  - `EXC_BREAKPOINT / SIGTRAP`
  - main thread top: `libsystem_malloc.dylib _xzm_xzone_malloc_freelist_outlined`
- `~/Library/Logs/DiagnosticReports/Terminal-2026-06-03-141411.ips`
  - same signature as above
- `~/Library/Logs/DiagnosticReports/Terminal-2026-06-03-142119.ips`
  - `EXC_BAD_ACCESS / SIGSEGV`
  - main thread top: `QuartzCore CA::ColorProgram::Cache::set_colorspace(CGColorSpace*)`
  - crash report includes an HIE/input-method service thread, matching the IME-composition hypothesis.
- `~/Library/Logs/DiagnosticReports/Terminal-2026-06-03-142729.ips`
  - `EXC_BREAKPOINT / SIGTRAP`
  - main thread top: `libsystem_malloc.dylib _xzm_xzone_malloc_freelist_outlined`
  - application-specific information: `BUG IN CLIENT OF LIBMALLOC: memory corruption of free block`
  - registers contain repeated box-drawing UTF-8 byte patterns (`e2 94 80`, U+2500 `─`), consistent with border/sweep redraw output.
  - produced by `--full-tui --no-animation` at 10 turns, proving animation disablement alone is not enough.

These are Terminal.app crashes, not Lynn process errors. They cannot be caught with Node try/catch.

## Current policy

Do not enable Ink/full-TUI by default in Apple Terminal.

The safe default remains:

- Apple Terminal: boxed-input renderer.
- Non-Apple terminals: Ink can remain available when the terminal profile allows it.
- Apple Terminal full Ink is opt-in only with `LYNN_CLI_APPLE_TERMINAL_FULL_TUI=1` and must be treated as experimental.

## What must be fixed before considering Ink as default on Apple Terminal

1. Full Ink must pass Terminal.app + Chinese IME smoke with animation enabled for long runs without producing new Terminal `.ips`/`.crash` reports.
2. Full Ink must handle bracketed paste correctly in PTY (`ESC [200~` / `ESC [201~`) instead of inserting the markers into the prompt text.
3. The full Ink path must avoid Terminal.app layer churn during IME composition. Disabling animation is not enough by itself; longer no-animation runs still produced the malloc crash signature.
4. Border/sweep rendering must be made less hostile to Terminal.app: avoid high-frequency repeated box-drawing writes during IME composition, and test plain-ASCII border variants as an A/B.
5. Release preflight should keep the boxed-input Apple Terminal smoke blocking, and the full-Ink smoke should remain a separate crash-lab gate until the signatures above disappear.

## Useful commands

```bash
npm run build:cli

# Safe default path: should pass.
LYNN_CLI_TERMINAL_IME_TURNS=6 node scripts/cli-terminal-ime-smoke.mjs

# Experimental full Ink path: currently unsafe with animation.
LYNN_CLI_TERMINAL_IME_TURNS=6 node scripts/cli-terminal-ime-smoke.mjs --full-tui

# Diagnostic variant: separates animation from Ink/raw input.
LYNN_CLI_TERMINAL_IME_TURNS=6 node scripts/cli-terminal-ime-smoke.mjs --full-tui --no-animation

# PTY full Ink path: currently exposes bracketed-paste handling issues.
LYNN_CLI_PTY_FULL_TUI=1 node scripts/cli-pty-smoke.mjs
```
