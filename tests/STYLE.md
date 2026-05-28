# Lynn Test Style Guide

Date: 2026-05-28

This guide keeps test changes consistent when multiple CLI agents are working in parallel.

## Naming

- Use English `describe` and `it` names for new tests.
- Keep behavior in the test name: prefer `falls back to Spark when MiMo is unhealthy` over `fallback test`.
- Name fixtures after the scenario they represent, not the implementation detail.

## Structure

- Put focused tests next to the closest existing suite instead of creating a new top-level file by default.
- For extracted pure helpers, add a small dedicated test file with one scenario per branch.
- Keep arrange / act / assert visually separated when the test does more than one setup step.

## Mocks

- Prefer `vi.spyOn` and restore with `vi.restoreAllMocks()` in `afterEach`.
- Avoid module-global mutable mocks unless the surrounding suite already uses that pattern.
- Mock the smallest boundary that makes the test deterministic. Do not mock the function under test.

## Assertions

- Assert the behavior users or callers observe, then add one narrow structural assertion if it protects a regression.
- Prefer `toEqual(expect.objectContaining(...))` for event payloads that may grow.
- Avoid snapshot tests for chat, provider, or automation output unless the snapshot is deliberately tiny.

## Fixtures

- Keep inline fixtures small. If a fixture needs more than one screen, move it to a named helper.
- Do not store live API responses as fixed truth unless the test is explicitly a parser regression.
- For weather, finance, search, or other time-sensitive data, mock the provider result instead of asserting current-world values.

## Validation Ladder

For a normal PR:

```bash
npm run typecheck
npx vitest run <focused tests> --reporter=dot
```

For central runtime, provider routing, release-facing UI, or cross-platform behavior:

```bash
npm run typecheck
npm run typecheck:runtime
npm run release:gate
```

GitHub macOS and Windows checks must be green before merge.

