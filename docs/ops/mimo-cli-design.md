# Lynn MiMo CLI - capability differentiation + execution plan

Date: 2026-05-29
Branch: `claude/mimo-cli-design`
Status: Design (pre-code review gate). Companion to `docs/ops/v0.80-gui-cli-worker-plan.md`.
(Supersedes the earlier vision-only draft.)

> Thesis: the MiMo-default CLI must differentiate on MiMo's capability BREADTH, not by
> out-optimizing a single text path. Reasonix / DeepSeek-TUI already win the
> "optimize one DeepSeek text path" game (prefix cache, reasoning display, tool-storm
> avoidance) - we cannot out-Reasonix them there. We win on what their models cannot
> do at all. Five selling points, all grounded in verified MiMo facts, and mostly
> already wired in brain v2.

## 1. The five selling points

| # | Pillar | MiMo fact (verified 2026-05-29) | CLI feature | Status |
|---|---|---|---|---|
| 1 | **Multimodal vision / GUI** | MiMo-VL OSWorld-G 56.1, beats specialized UI-TARS; brain serves `mimo-v2.5`/`v2-omni` | see / ui2code / visual bug fix / ground / visual diff review | brain done; client = image I/O |
| 2 | **Long-duration endurance** | V2.5-Pro: 1M ctx + 1000+ coherent sequential tool calls | long autonomous runs, repo-wide tasks, heavy-lift fleet worker | client = long-run/checkpoint mgr |
| 3 | **Cache economics** | cache-hit **$0.0036/M** vs miss **$0.435/M** (~**120x**); hierarchical KV cache (~5x reuse, ~80% less compute); cache-write free (limited time) | cache-stable prefix discipline -> near-free input on long runs | client = Pillar-1 discipline (already designed) |
| 4 | **Native web search** | server-side `web_search` tool; brain sets `enable_search:true` | web-grounded coding: current docs/errors/CVEs with no client search tool + no extra round trip | brain done; client = surface sources |
| 5 | **Native UI grounding + structured tool calling** | V2-Omni native structured function-calling + UI grounding, "ready to plug in without adapter layers" | reliable tool use (fewer storms), native structured JSON output, native grounding | model-native; brain tool-storm backstop |

**Pillars 3 and 2 compound:** a long run reuses the same immutable prefix every turn,
so the ~120x cache-hit discount makes 1000-tool-call runs near-free on input. Cache
discipline is the hidden multiplier on endurance, not a standalone feature.

## 2. Why capability-led, not optimization-led

Reasonix / DeepSeek-TUI are single-text-path optimizers. Those levers are either
already in Lynn's brain or reusable here, so they are table stakes, not the wedge:

- **tool-storm**: `brain-v2-mirror/tool-storm.ts` already guards it, model-agnostic;
  MiMo's native structured tool-calling additionally reduces the storm source.
- **cache discipline**: the Pillar-1 design from the earlier cli-mvp doc moves to MiMo
  unchanged and pays off ~120x (vs ~10x on DeepSeek).
- **reasoning display**: `wire-adapter/mimo.ts` already maps `reasoning_effort` to
  MiMo's thinking schema.

We will never out-optimize a CLI hand-tuned for DeepSeek on the single-text-path game.
We win on breadth: see + search + endure + ground + near-free cache - things their
models cannot do at all.

## 3. Pillars in detail

### Pillar 1 - multimodal vision / GUI (headline)
- `see <image>` describe + ground; `ui2code <image>` screenshot/mockup -> component;
  `fix --shot <image>` visual bug -> locate + patch; `ground <image> "<target>"` ->
  normalized `{x,y}` in [0,1] (+ optional selector) as JSONL for automation;
  `review --before --after` visual diff.
- Served by brain's `mimo-v2.5`/`v2-omni` (auto-selected on `image_url` content).

### Pillar 2 - long-duration endurance
- long-run loop: step budget, periodic checkpoints (resume), progress events; reuse
  `context-compact.ts` even within 1M ctx; the Fleet heavy-lift worker.

### Pillar 3 - cache economics (the multiplier)
- keep an immutable prefix (system + tool specs + few-shots) hash-pinned, an
  append-only history (no reorder / whitespace mutation), so MiMo bills cache-hit
  ($0.0036/M) not miss ($0.435/M). Show cache-hit % in the status bar; warn if it
  drops (prefix drift). Compounds with Pillar 2.

### Pillar 4 - native web search (web-grounded coding)
- the model checks the live web before writing code (latest library API, an error
  string, a CVE) via MiMo's server-side `web_search` (brain's `enable_search:true`).
  No client search tool, no extra round trip. The CLI surfaces "searched / sources".

### Pillar 5 - native UI grounding + structured tool calling
- V2-Omni's native structured function-calling + UI grounding means reliable,
  well-formed tool calls (fewer malformed/looping ones -> less tool-storm at the
  source; `tool-storm.ts` stays the backstop) and a native structured-JSON output mode.

## 4. What brain v2 already provides (reuse map)

| Pillar | Already in brain v2 | File |
|---|---|---|
| 1 multimodal | vision/audio/video on; auto model-switch on `image_url` content | `provider-registry.ts`, `wire-adapter/mimo.ts` |
| 4 search | `enable_search:true` wired | `wire-adapter/mimo.ts` |
| 5 tool-storm | loop guard (model-agnostic) | `tool-storm.ts` |
| 2 long-ctx | turn-end compaction | `context-compact.ts` |
| all | capability gate, MiMo cascade head, retry | `router.ts` |

The CLI is a thin client. Genuinely new client surface (small):
- image capture/encode into `image_url` content parts + grounding-output normalization
- long-run / checkpoint manager (budget, resume, progress)
- cache-stable prefix discipline + cache-hit telemetry (reused Pillar-1 design)
- search-source surfacing in the renderer

## 5. Architecture (thin client)

```
lynn MiMo mode / Fleet worker
  - image capture/encode -> messages[].content [{type:"image_url", ...}]
  - cache-stable prefix (immutable + append-only + hash assert)
  - long-run/checkpoint manager; grounding normalizer; source surfacing
        |  POST /v1/chat/completions  (+ web_search tool, multimodal parts)
        v
brain v2 (already multimodal + search + tool-storm + compaction)
  provider-registry.ts (mimo head, vision/audio/video on)
  wire-adapter/mimo.ts (auto mimo-v2.5-pro <-> mimo-v2.5/omni; enable_search)
  router.ts (capability gate); tool-storm.ts; context-compact.ts
        v
  MiMo OpenAI-compatible API (token-plan-cn.xiaomimimo.com/v1)  [+ Spark APEX fallback]
```

## 6. Command surface (illustrative)

```
lynn-mimo see <image>                      # describe + ground a screenshot
lynn-mimo ui2code <image>                  # screenshot/mockup -> component code
lynn-mimo fix --shot <image>               # visual bug -> locate + patch
lynn-mimo ground <image> "<target>" --json # -> {x,y}/selector for automation
lynn-mimo review --before a.png --after b.png  # visual diff review
lynn-mimo ask "..." --search               # web-grounded answer (native web_search)
lynn-mimo run --long "..." --max-steps 1000 --checkpoint   # endurance run
lynn-mimo run --resume <runId>
# status bar: provider | cache-hit % | ctx K/1M | searched N | grounded
# Fleet: lynn worker run --agent mimo-vl|mimo-pro ... --jsonl
```

## 7. Differentiation matrix

| Capability | MiMo CLI | Codex CLI / clone | DeepSeek-TUI / Reasonix |
|---|---|---|---|
| sees screenshots / grounds GUI | yes (beats UI-TARS) | no | no |
| native web search (no client tool) | yes | no (bolt-on) | no (bolt-on) |
| ~120x cache-hit economics | yes | n/a | ~10x (DeepSeek) |
| 1M ctx + 1000+ tool-call endurance | yes | partial | partial |
| native structured tool calling / less storm | yes | partial | partial |
| reasoning visibility (table stakes) | yes | partial | yes |
| voice (deferred to Jarvis) | later | no | no |

## 8. Execution / landing direction

### Where it lands (this is NOT a from-scratch separate CLI)
The 5 pillars are how the MiMo-default CLI (that the CLI lane is building in `cli/**`)
becomes differentiated. Work splits across existing lanes:

- **brain v2 - mostly DONE**: multimodal routing, `enable_search`, tool-storm,
  compaction. Do not duplicate.
- **`cli/**` (CLI lane / Codex)**: human-facing commands + flags for the 5 pillars,
  cache-stable prefix discipline, long-run/checkpoint, image I/O, source rendering.
- **fleet (B-line / me)**: `mimo-vl` / `mimo-pro` worker kinds + an optional screenshot
  input in the GUI dispatch form, reusing the fleet JSONL protocol.
- **`shared/`**: any new content-part / event types (CLI lane owns `shared/`).

So this doc is the differentiation SPEC; landing = small client additions on top of
brain (done) + the existing CLI + the fleet, coordinated across lanes - not a rewrite.

### Phased plan

- **P0 contracts (~0.5d, verify)**: grounding output format from `mimo-v2.5` (native
  coords vs prompt-and-parse); cache-hit telemetry fields in MiMo `usage`; `web_search`
  source shape in the SSE.
- **P1 vision + cache (headline MVP)**: `see` / `ground` / `ui2code`; cache-stable
  prefix + cache-hit % in the status bar; the `mimo-vl` Fleet worker.
  Gate: image -> grounded coords (JSONL); cache-hit % shown; worker streams on the board.
- **P2 web-grounded + visual fix/review**: surface `enable_search` sources; `fix --shot`;
  `review --before/--after`; screenshot/clipboard capture.
- **P3 endurance**: long-run loop, checkpoint/resume, budget; `mimo-pro` worker;
  validate cache x endurance (cache-hit stays high across a 100+ step run).
- **P4 polish**: model-tier hints (v2.5 vs omni vs pro), local MiMo-VL-7B vision tier,
  structured-JSON output mode.

### Cross-lane coordination
- propose shared content-part / event additions to the CLI lane (owns `shared/`).
- the Fleet worker + GUI screenshot brief is B-line (me).
- brain routing is done - reuse, do not re-implement.

## 9. Decision log + open questions

Decided (user, 2026-05-29): five pillars (multimodal, endurance, cache, search,
grounding+structured-calling); voice deferred to the Jarvis lane; capability-led not
optimization-led; lands on the existing CLI + brain + fleet, not a new binary.

Open:
- Q1 grounding output: does `mimo-v2.5` return coordinates natively, or prompt + parse?
- Q2 cache-hit telemetry: which `usage` fields does the MiMo API return for cache hits?
- Q3 screenshot capture: rely on user-passed image, or add an OS capture tool?
- Q4 endurance checkpoint format + location; reuse vs the Fleet task runtime.
- Q5 is the MiMo CLI a `lynn` mode/profile or a separate `lynn-mimo` entry point?

## 10. Sources

- [MiMo-VL Technical Report (arXiv 2506.03569)](https://arxiv.org/abs/2506.03569) - OSWorld-G 56.1 > UI-TARS; OlympiadBench 59.4.
- [XiaomiMiMo/MiMo-VL-7B-RL (HF)](https://huggingface.co/XiaomiMiMo/MiMo-VL-7B-RL)
- [MiMo-V2.5 (official)](https://mimo.xiaomi.com/mimo-v2-5/) - native vision/audio/video, 1M ctx, agentic.
- [MiMo-V2.5-Pro pricing/benchmarks (OpenRouter)](https://openrouter.ai/xiaomi/mimo-v2.5-pro)
- [Xiaomi MiMo pricing - cache-hit $0.0036/M (official)](https://platform.xiaomimimo.com/docs/en-US/pricing)
- [Xiaomi MiMo API up to 99% price cut (HN)](https://news.ycombinator.com/item?id=48282814)
- [MiMo OpenAI-compatible API + web_search (official docs)](https://platform.xiaomimimo.com/docs/en-US/api/chat/openai-api)
- [mimo-v2-omni - native tool calling + UI grounding (CometAPI)](https://www.cometapi.com/models/XiaomiMiMo/mimo-v2-omni/)
- [MiMo-7B Technical Report (GitHub)](https://github.com/XiaomiMiMo/MiMo) - reasoning-first, MTP ~90% accept.
- In-repo (verified): `brain-v2-mirror/provider-registry.ts`, `wire-adapter/mimo.ts`, `router.ts`, `tool-storm.ts`, `context-compact.ts`.
