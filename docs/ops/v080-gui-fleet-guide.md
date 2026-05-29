# Lynn v0.80 - GUI CLI Worker Fleet (operator guide)

Status: B-line (GUI + server fleet) implemented on branch `claude/v080-gui-fleet`.
Companion to the plan in `docs/ops/v0.80-gui-cli-worker-plan.md`.

## Positioning (one line)

Lynn v0.80 is not "a chat CLI". It is a GUI command deck that dispatches and
supervises several code CLIs (codex / claude / qwen / lynn-cli ...) running in
parallel, each isolated in its own git worktree. The CLI makes Lynn scriptable in
a terminal; the GUI makes "five CLIs at once" a controlled engineering workflow.

## What the Workers panel gives you

- **Dispatch form** - author a brief (owned files, forbidden files, test commands,
  branch, worktree, which agent) and start a worker.
- **Worker board** - one card per worker: live status, a code-change summary
  ("N files changed +X -Y"), a per-file list with verbs (creating / editing / ...)
  and +/- counts, the file being written shown in-progress, tests, and a log tail.
- **Diff drawer** - click any changed file to read its `git diff` (read-only).
- **Claims / conflict banner** - two workers touching the same central file or the
  same changed path are flagged; out-of-scope (forbidden-file) edits turn the card
  red and block merge. This is derived from real git, not the worker's self-report.
- **Recovery per card** - Cancel, Retry (re-dispatch the brief), Open worktree,
  Copy logs.
- **CLI runtime status line** - the Node runtime the GUI uses to run workers
  (reused bundled Node, or Electron-as-node). Zero terminal setup, zero download.

## How a worker runs (no terminal config)

The GUI never assumes `lynn` is on the user's PATH. It resolves a runtime via the
CliEnvManager (`desktop/cli-env-manager.cjs`): the real bundled Node on mac/linux,
Electron-as-node otherwise (always available). `getWorkerSpawnCommand()` returns the
exact `{ command, args, env }` used to spawn `lynn worker run --jsonl` from the
bundled CLI. (Wiring the live spawn is step 4, after the CLI lane merges into
integration; until then dispatch streams a stub event sequence so the board is
demoable.)

## Acceptance checklist (operator POV)

Open the app, then:

- [ ] Sidebar -> "Workers" opens the fleet panel.
- [ ] The CLI runtime line shows a Node version + source (bundled / electron).
- [ ] "Play mock worker" streams a worker started -> ... -> done; the board shows
      its diff summary, per-file +/-, tests, and the out-of-scope file in red with
      the card blocked.
- [ ] Click a changed file -> the diff drawer expands (mock shows a "no diff yet"
      message; a real worktree shows the file diff).
- [ ] "Dispatch worker" -> fill a brief -> a worker appears via the live WS path.
- [ ] (After step 4 / integration) dispatch a real `lynn-cli` worker and watch real
      events stream in.
- [ ] Cancel a running worker -> card goes to "cancelled".
- [ ] Retry a finished / failed worker -> a fresh worker is dispatched.
- [ ] Copy logs copies the worker log; Open worktree opens the folder (real workers).

## README positioning snippet (for the README lane to lift)

> Lynn v0.80 turns the desktop app into a command deck for parallel coding CLIs.
> Dispatch codex / claude / qwen / lynn-cli workers into isolated git worktrees,
> watch their diffs and tests live, catch out-of-scope edits and conflicts, and
> cancel / retry from one board -- while the CLI itself stays scriptable from any
> terminal. It is multi-CLI orchestration, not another chat box.

## Code map (B-line)

- GUI panel: `desktop/src/react/components/fleet/` (WorkersPanel, WorkerCard,
  TaskBriefForm, fleet-reducer, fleet-conflicts, playback, fixtures)
- Store slice: `desktop/src/react/stores/fleet-slice.ts`
- Server hub: `server/fleet/` (fleet-hub, worktree-manager, worker-manager,
  forbidden-guard, registry) + `server/routes/fleet.ts`
- CLI runtime: `desktop/cli-env-manager.cjs` (IPC `cli:status`)
- Protocol (CLI lane, read-only here): `shared/fleet-events.ts`
