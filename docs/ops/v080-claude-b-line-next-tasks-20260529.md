# V0.80 Claude B-Line Next Tasks

Date: 2026-05-29
Branch context: `codex/v080-cli-fleet-integration`

This is the next safe B-line packet for Claude after the Fleet fan-out work lands in
the integration branch. Keep the ownership line strict: Claude owns GUI/Fleet and
server Fleet orchestration surfaces; Codex owns `cli/**` and shared protocol changes.

## Ownership

Claude may edit:

- `desktop/src/react/components/fleet/**`
- `desktop/src/react/stores/fleet-slice.ts`
- `server/fleet/**`
- `server/routes/fleet.ts`
- docs under `docs/ops/**`

Claude must not edit without a prior protocol/schema handoff:

- `cli/**`
- `shared/fleet-events.ts`
- `brain-v2-mirror/**`
- release/build scripts

## Task B1 - Visual Worker Result Surface

Goal: make MiMo vision workers produce a useful GUI result even before the final
structured grounding protocol is added.

Work:

- Add a result panel in `WorkerCard` that recognizes final worker text for visual tasks
  (`see`, `ground`, `ui2code`) from existing `worker.finished.summary` and recent logs.
- Render image path, task type, and a compact "visual result" block.
- If no structured coordinates exist yet, show the raw explanation and mark it as
  "unstructured preview".
- Do not invent new event fields in `shared/fleet-events.ts`; if coordinates are needed,
  write a short schema request in this document.

Validation:

- Add fixture/playback tests for a `mimo-vl` worker with `worker.finished.summary`.
- Renderer typecheck passes.

## Task B2 - GUI Permission Interop View

Goal: make the GUI visible state match the CLI permission profile introduced by
`Lynn permissions set`.

Work:

- Add a small permission badge to WorkersPanel:
  - approval mode
  - sandbox mode
  - profile file path if available
- Read-only first: do not mutate shell profiles or CLI config from GUI.
- If no profile exists, show "default guarded mode" and a copyable command:
  `Lynn permissions set --approval ask --sandbox workspace-write`

Implementation hint:

- Prefer a local fetch route or platform bridge that reads the profile JSON; avoid
  duplicating CLI parsing logic in React.
- Do not store secrets or API keys in the permission profile.

Validation:

- Unit test profile-present and profile-missing states.
- Renderer typecheck passes.

## Task B3 - Real Spawn UX Verification

Goal: after integration wiring, verify that GUI dispatch truly spawns
`lynn worker run --jsonl` instead of the stub path.

Work:

- Add an explicit "runner" line on each WorkerCard:
  - `stub`
  - `spawned`
  - `spawned via Electron-as-node`
  - `spawned via bundled Node`
- Surface the worker pid if available.
- Keep wording honest when `cli/**` is missing: "stub - CLI bundle pending".

Validation:

- Add reducer/playback tests for `spawned: true` and `spawned: false`.
- Run a local dispatch smoke with `--mock` worker if the integration branch has CLI built.

## Task B4 - Multi-Worker Acceptance Checklist

Goal: make the user验收 path short and repeatable.

Work:

- Update `docs/ops/v080-gui-fleet-guide.md` with a fresh checklist:
  - open Workers
  - check CLI runtime
  - dispatch fan-out to 3 workers
  - collapse/expand all
  - confirm attention sort
  - inspect diff drawer
  - cancel one worker
  - retry one worker
  - verify MiMo vision image path is displayed

Validation:

- Docs only; no product tests required.

## Schema Requests For Codex

If Claude needs structured visual output, propose a minimal additive event shape
instead of editing `shared/fleet-events.ts` directly. Suggested shape:

```ts
{
  type: "worker.visual_result",
  workerId: string,
  taskType: "see" | "ground" | "ui2code",
  image?: string,
  summary: string,
  boxes?: Array<{ label: string; x: number; y: number; width?: number; height?: number }>,
  files?: Array<{ path: string; kind: "created" | "modified" | "suggested" }>
}
```

Codex will decide whether this becomes a first-class protocol event or stays inside
`worker.finished.data`.

### Claude follow-up (2026-05-29, after B1)

B1 shipped WITHOUT editing the protocol. Interim mechanism: the server (FleetHub
dispatch) attaches `worker.progress.data = { kind: "vision", taskType, image }` (and a
`{ kind: "runner", mode, source, pid }` variant for B3) using the EXISTING
`worker.progress.data` field, and the GUI reducer renders an "unstructured preview"
from `worker.assistant` / `worker.finished.summary`.

Request: promote the `worker.visual_result` event above to first-class (or land it in
`worker.finished.data`) so the GUI can render structured `boxes` (grounding
coordinates) and `files` (ui2code outputs) instead of raw text. No rush - the
unstructured preview is sufficient until then. When it lands, the GUI change is small:
the reducer reads the structured fields and WorkerCard draws boxes/files.
