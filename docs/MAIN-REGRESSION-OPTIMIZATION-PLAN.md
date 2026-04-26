# Main Regression Optimization Plan

> Updated: 2026-04-24
> Scope: follow-up optimization after the `main` regression run on 2026-04-23.

## Regression Baseline

The clean `main` worktree passed the core regression set:

- `npm test`
- `npm run typecheck`
- `npm run build:renderer`
- `npm run build:main`
- `npm run build:server`

There are no release-blocking red tests from this pass. The remaining items are performance, build hygiene, and dependency maintenance work.

## Commit Split

### Commit 1: Document The Optimization Plan

Status: ready to submit.

Files:

- `/Users/lynn/Downloads/Lynn/docs/MAIN-REGRESSION-OPTIMIZATION-PLAN.md`

Purpose:

- Preserve the regression result and split follow-up work into safe, reviewable commits.
- Keep `main` stabilization separate from `v0.77` experimental work.

Verification:

- No runtime verification required; documentation-only.

Rollback:

- Remove this document.

### Commit 2: Split Renderer Vendor Chunks

Status: ready to implement next.

Files:

- `/Users/lynn/Downloads/Lynn/vite.config.ts`

Problem:

- `build:renderer` succeeds, but several chunks are large:
  - `codemirror-vendor`
  - `rendering-vendor`
  - `mermaid.core`
  - graph-related Mermaid dependencies

Recommended change:

- Refine `manualChunks()` into narrower buckets:
  - React runtime
  - app state
  - CodeMirror core
  - CodeMirror language data
  - Markdown renderer
  - KaTeX
  - DOMPurify
  - Mermaid core
  - graph/layout dependencies used by Mermaid

Acceptance criteria:

- `npm run build:renderer` passes.
- No new runtime import errors.
- The split improves cacheability even if some heavy optional chunks remain above Vite's default warning threshold.

Risk:

- Medium-low. Chunking changes are usually safe, but can affect lazy-loading behavior if a module is accidentally grouped into an eagerly loaded chunk.

Rollback:

- Revert the `manualChunks()` changes in `vite.config.ts`.

### Commit 3: Decide Legacy HTML Script Strategy

Status: design first, code later.

Files likely involved:

- `/Users/lynn/Downloads/Lynn/desktop/src/index.html`
- `/Users/lynn/Downloads/Lynn/desktop/src/settings.html`
- `/Users/lynn/Downloads/Lynn/desktop/src/onboarding.html`
- `/Users/lynn/Downloads/Lynn/desktop/src/browser-viewer.html`
- `/Users/lynn/Downloads/Lynn/desktop/src/lib/i18n.js`
- `/Users/lynn/Downloads/Lynn/desktop/src/lib/theme.js`
- `/Users/lynn/Downloads/Lynn/desktop/src/modules/platform.js`

Problem:

- Vite warns that legacy scripts cannot be bundled because they are not `type="module"`.

Do not rush this change:

- Simply adding `type="module"` can change global variable behavior.
- These scripts may intentionally provide globals for older windows or preload-era code.

Recommended path:

1. Audit whether each legacy script writes to `window`.
2. If globals are still required, keep the scripts external and document the warning as intentional.
3. If globals are not required, migrate one script at a time into module imports.

Acceptance criteria:

- No change to startup behavior in main, settings, onboarding, and browser viewer windows.
- `npm run build:renderer` passes.
- Smoke-test all affected windows.

Risk:

- Medium. HTML boot scripts affect app startup and settings/onboarding windows.

Rollback:

- Restore original script tags and legacy files.

### Commit 4: Server Dependency Aging Audit

Status: investigation first.

Files likely involved:

- `/Users/lynn/Downloads/Lynn/package.json`
- `/Users/lynn/Downloads/Lynn/package-lock.json`

Problem:

- `build:server` passes, but dependency install logs include deprecated packages such as `request`, `uuid@3`, `rimraf@2`, `glob@7`, and `inflight`.

Recommended path:

1. Use `npm ls request uuid rimraf glob inflight` to identify direct owners.
2. Separate direct dependencies from transitive dependencies.
3. Upgrade only direct dependencies in this repo first.
4. For transitive dependencies, document upstream owners and avoid risky forced overrides unless there is a security reason.

Acceptance criteria:

- `npm test` passes.
- `npm run build:server` passes.
- No lockfile churn beyond the intended dependency changes.

Risk:

- Medium-high. Dependency upgrades can affect packaging, native modules, and plugin runtime behavior.

Rollback:

- Revert `package.json` and `package-lock.json`.

## Recommended Order

1. Submit Commit 1 first.
2. Implement Commit 2 as a small build-only change.
3. Leave Commit 3 until there is time to smoke-test all desktop windows.
4. Treat Commit 4 as a dependency-maintenance PR, not a quick cleanup.

## Explicit Non-Goals

- Do not mix these optimizations with `v0.77` TTS / ASR / RAG / Flux work.
- Do not hide warnings by raising Vite's chunk warning limit unless we explicitly decide the current chunk size is acceptable.
- Do not convert legacy scripts to modules without checking global side effects.
