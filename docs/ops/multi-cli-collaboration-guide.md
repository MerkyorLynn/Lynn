# Lynn 3-5 CLI Collaboration Guide

Date: 2026-05-28

This note captures the working rules that made the May 2026 parallel CLI waves safe enough to merge. It is meant for future Codex / Claude / CodeBuddy / Qwen dispatches, especially TS migration and bounded refactor work.

## When To Use Parallel CLI Work

Use 3-5 CLIs when the work can be split by ownership boundary:

- Good: one module migration, one component extraction, one test harness, one docs pass.
- Good: TS conversion where `tsc` is the shared contract.
- Good: repeated provider/adapter migrations with the same shape.
- Risky: one central file edited by multiple CLIs.
- Risky: feature design where APIs are still unsettled.
- Avoid: production deploys, secret handling, model downloads, and destructive git operations.

For Lynn specifically, local Mac model/BF16/GGUF/dataset/training package downloads remain forbidden. Model artifacts belong only on Spark or other approved remote hosts.

## Roles

Keep one integration owner. Other CLIs produce PR-sized slices.

- Integration owner: owns mainline, merge order, CI decisions, and final release gate.
- CLI workers: own one file group or one module boundary each.
- Reviewer: reads diffs, tests, and failure modes, but does not opportunistically edit claimed central files.

Parallel work is not "five autonomous maintainers." It is closer to a fast PR queue with one senior merge brain.

## Claim Protocol

Before dispatch, create or update a task board in `docs/ops/` or a temporary `tasks.md`.

Each item should include:

```text
#42 [claimed: codex-2] migrate hub/scheduler.js -> hub/scheduler.ts
scope: hub/scheduler.* tests/hub-scheduler.*
forbidden: server/routes/chat.ts, brain-v2-mirror/router.ts
done: tsc + focused tests + commit hash
```

Rules:

- One owner per hot file.
- Central files such as `router.ts`, `chat.ts`, `engine.ts`, and large UI components get exclusive ownership.
- If a worker discovers it must edit another worker's file, it stops and leaves a note instead of crossing the boundary.
- Shared type changes get their own small PR before implementation PRs.

## Task Sizing

Prefer one file group per PR.

Good examples:

- `core/session-list-cache.ts` plus tests.
- `core/session-isolated-runtime.ts` plus tests.
- `brain-v2-mirror/audio-transcribe.ts` type hardening.
- `desktop/src/react/components/chat/TtsControlButton.tsx` extraction.

Bad examples:

- "Refactor all chat rendering."
- "Improve provider routing and UI fallback copy."
- "Migrate the whole server to TS."

Large efforts should become a sequence of small PRs. The merge queue should be boring.

## Type Contracts

Treat shared type files as rendezvous points:

- `brain-v2-mirror/types.ts`
- `desktop/src/react/stores/*-slice.ts`
- `core/types.ts`
- shared protocol/event modules

When a field shape changes, update the contract first and let `tsc` reveal every caller. This prevents silent drift such as provider id mismatches, missing `default_thinking`, or capability flags that only fail in production.

## Testing Rules

Tests are executable specs. Every CLI PR should include at least one of:

- A focused unit test for extracted pure logic.
- A router/adapter test for protocol behavior.
- A store/component test for UI state behavior.
- A release gate run when UI or central runtime behavior changes.

Recommended validation ladder:

```bash
npm run typecheck
npm run typecheck:runtime
npx vitest run <focused tests> --reporter=dot
npm run build:renderer      # UI changes
npm run release:gate        # central runtime, release-facing UI, or before merge train
```

Avoid relying on PR descriptions as the spec. Reviewers should be able to understand expected behavior from the tests.

Use `tests/STYLE.md` as the shared style contract for new test files. This matters more when 3-5 CLIs are producing tests in parallel: behavior names, mock cleanup, fixture shape, and assertion granularity should look like one project rather than five authors.

## No `@ts-nocheck` Without a Ticket

`@ts-nocheck` hides debt in files that look migrated.

Policy:

- New `@ts-nocheck` is blocked unless it wraps a third-party interop shim.
- If unavoidable, add a dated TODO with owner and removal target.
- Follow-up cleanup should be tracked in `docs/ops/` or the task board.

The `audio-transcribe.ts` cleanup is the reference pattern: replace nocheck with explicit input/ref/cache/meta types and keep behavior unchanged.

## Rebase And Merge Cadence

Parallel branches should rebase daily, or sooner when main is moving fast.

Recommended cadence:

1. Worker opens draft PR.
2. Integration owner checks ownership boundaries.
3. Focused tests run locally.
4. GitHub macOS and Windows checks go green.
5. Mark ready and merge.
6. Next worker rebases on latest main before continuing.

Do not stack unrelated changes behind a pending PR. Small PRs keep conflict repair cheap.

## Conflict Playbook

Common conflicts and preferred response:

- Same element / same function: keep the version with better accessibility or stronger types, then rerun focused tests.
- Add/add duplicate feature: choose one implementation, usually the stricter typed version, and drop the other.
- Shared type changed under worker: rebase, let `tsc` enumerate repairs, and keep the PR scoped.
- Test style drift: prefer local existing patterns and add helper functions rather than inventing a new style.

If conflict resolution takes longer than implementing the PR, the task was too broad.

## Suggested Dispatch Template

```text
You are CLI-N. Worktree: /private/tmp/lynn-cli-N-task
Branch: cli-N/task-name

Goal:
- One sentence objective.

Owned files:
- path/**

Forbidden files:
- server/routes/chat.ts
- brain-v2-mirror/router.ts
- core/engine.ts

Required:
- Exact modules/functions to create or edit.
- Tests to add.
- Validation commands.

Done means:
- tsc passes.
- Focused tests pass.
- No local model assets downloaded.
- Commit message includes validation summary.
```

## Practical Throughput Expectation

Five CLIs do not produce 5x senior-engineer throughput. In Lynn's May 2026 work, the realistic gain was closer to 2-2.5x because review, rebase, CI, and architecture decisions remain bottlenecks.

Parallel CLIs are strongest for:

- TS migrations.
- Mechanical adapter updates.
- Test harness expansion.
- Bounded UI component extraction.
- Documentation and release notes.

They are weakest for:

- New product direction.
- Cross-cutting runtime behavior.
- Security-sensitive policy decisions.
- Production deploys.

## Release Hygiene

Before any release cut after parallel work:

- Confirm all worker branches are merged or intentionally abandoned.
- Run `npm run release:gate`.
- Review `git log --oneline main --max-count=20` for accidental stats-only or scratch commits.
- Verify no untracked local model artifacts were introduced.
- Prefer a clean release commit/tag over shipping directly from a busy work branch.
