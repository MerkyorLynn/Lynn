# Lynn CLI v0.80.x Codex-Style Night Run - 2026-06-06

This note records the current CLI night-run work aimed at bringing Lynn closer to Codex CLI expectations: traceable tool output, clear approval semantics, stable long-task mechanics, and headless/Fleet readiness.

## Scope

The run focused on the CLI path only. Existing unrelated worktree changes were left untouched.

## Delivered

### Traceable Tool Cards

- Brain tool cards now surface traceable source hints when tool details contain citations.
- Tool completion can show compact source metadata such as:
  - `sources: /tool 1 · 2 links · platform.stepfun.com`
  - `/tool 1 web_search · done · 4.5s — 2 sources: platform.stepfun.com`
- The detailed source body remains behind `/tool N` so search/fetch output does not flood the main chat.

### `/tool` And `/tools` Split

- `/tool` now means recent tool run details.
- `/tool N` expands one tool run.
- `/tools` now lists local coding tools such as `read_file`, `bash`, and `apply_patch`.
- This matches the user-facing help text and avoids the previous command ambiguity.

### ASK / YOLO Permission Gate

Current behavior verified by tests:

- Human `ask / workspace-write` remains guarded.
- Interactive `approve all` allows subsequent dangerous tools in the same session without repeated prompts.
- For approved bash commands in ask mode, Lynn promotes the effective sandbox to `danger-full-access` for that confirmed command/session path, matching the user's expected "I approved this" behavior.
- Headless/Fleet `--approval yolo` infers `danger-full-access` when `--sandbox` is omitted.
- Explicit `--sandbox` remains respected when the caller intentionally passes one.

### Stress Gate Isolation

`cli/scripts/stress-cli.mjs` now disables CLI update checks for all stress subprocesses with `LYNN_CLI_UPDATE_CHECK=0`.

This prevents release/stress gates from being blocked by online `latest` prompts and makes the gate about the CLI behavior under test, not update availability.

## Gates Run

All commands were run from `/Users/lynn/Downloads/Lynn`.

```bash
npm --prefix cli test -- brain-render chat
npm --prefix cli test -- permissions bash-sandbox code-tools code-agent-loop-media
npm --prefix cli test -- code-agent-loop code-agent-loop-tools code-agent-loop-resume code-rewind chat-rewind code-working-checkpoint worker-run agents prompt self-update
npm --prefix cli run typecheck
npm --prefix cli run build
node cli/bin/lynn.mjs version
node cli/bin/lynn.mjs -p "你好" --mock-brain --reasoning off
npm --prefix cli run stress:cli
```

Observed results:

- CLI vitest target sets passed.
- Typecheck passed.
- Build passed.
- Built binary reported `@lynn/cli 0.80.7`.
- Mock `-p` path returned `模拟回复:你好`.
- Stress gate passed:
  - 40 serial `-p` runs
  - 8 parallel `-p` runs
  - `code -p` local checks
  - non-version smoke
  - Apple Terminal stable PTY
  - Apple Terminal mock conversation

## Current Evidence Level

Strong evidence:

- Tool traceability and `/tool`/`/tools` behavior are covered by targeted tests.
- Approval/YOLO semantics are covered by existing permission, bash, code-tool, and interactive allow-all tests.
- Rewind/checkpoint/headless/Fleet paths were exercised through their current test suites.
- The packaged CLI entrypoint was rebuilt and exercised through smoke/stress.

Known limits:

- `/tool N` is still typed, not clickable. This is acceptable for terminal UX but not equivalent to GUI expand/collapse.
- Source quality depends on Brain returning citation-bearing details. CLI can only surface what Brain sends.
- Apple Terminal full Ink remains crash-lab-only. The production-safe path remains boxed/native terminal input.
- This run did not publish a new tarball or update GUI packages.

## Commit

- `bc6a9e86 fix(cli): improve tool traceability and stress gate`

