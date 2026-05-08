# Brain v2 Mirror

This directory mirrors the deployable Brain v2 runtime from `/opt/lobster-brain-v2`.

Keep this tree self-contained enough to run `npm test` locally. Do not commit production-only runtime files such as `.env`, `node_modules/`, `*.bak*`, or generated logs under `data/`.

Current entry points:

- `server.js`: HTTP/SSE routes for Brain v2.
- `router.js`: provider/tool orchestration.
- `verifier-middleware.mjs`: asynchronous tool-result verifier.
- `deep-research.mjs`: best-of-N research orchestrator with quality-floor gating.
- `agent-checkpoint.mjs`: trajectory checkpoint evaluator.

Production deployment still runs from `/opt/lobster-brain-v2`; sync intentionally and run the mirror tests before deployment.
