# Lynn MiMo CLI - vision-grounded, long-endurance coding agent (design)

Date: 2026-05-29
Branch: `claude/mimo-cli-design`
Status: Design (pre-code review gate). Companion to `docs/ops/v0.80-gui-cli-worker-plan.md`.

> One line: the MiMo-default CLI should differentiate on what MiMo can do that
> DeepSeek / Codex cannot - SEE (MiMo vision lineage; MiMo-VL beats specialized
> UI-TARS at GUI grounding) and ENDURE (MiMo-V2.5-Pro: 1M context, 1000+ coherent
> tool calls). Cloning a blind text Codex CLI wastes MiMo's only categorical moats.

## 1. Why this, not a Codex clone

A text-only code agent throws away the two capabilities where MiMo is actually
distinctive. DeepSeek-TUI / Reasonix / a Codex clone are all blind text agents;
vision is a gap they cannot close with their own models. That is the wedge.

MiMo facts that drive the design (verified 2026-05-29; sources at end):

| Capability | What it gives the CLI |
|---|---|
| MiMo-VL-7B-RL GUI grounding: OSWorld-G 56.1, beats purpose-built UI-TARS | the model can see a screen and locate UI elements precisely |
| MiMo-VL: native-resolution ViT + reasoning backbone; top open-VLM Elo (7B-72B) | screenshot / design / doc understanding + visual reasoning |
| MiMo-V2.5-Pro: 1.02T MoE (42B active), 1M ctx, 1000+ sequential tool calls coherent | long autonomous runs without losing the plot |
| MiMo-V2.5 / v2-omni: native vision+audio+video, 1M ctx, OpenAI-compatible API, MIT | cheap, open, multimodal frontier backbone Lynn already routes to |
| MiMo-7B lineage: reasoning-first + MTP (~90% accept) | fast reasoning; viable for a local/edge VL-7B option |

Reasoning-trace visibility is **table stakes** (Reasonix already does it). We include
it but do not pretend it is the differentiator - the user's point that "a Codex
clone is not differentiated enough" is exactly right.

## 2. Goal & Non-goals

Goal: a MiMo-default CLI (and Fleet worker) that (A) sees and grounds GUIs/images
and (B) sustains long autonomous runs - two things a blind, turn-limited Codex clone
cannot do.

Non-goals:
- Not a feature-for-feature Codex clone (parity is table stakes, not the point).
- Voice (MiMo TTS/ASR) is deferred to the V0.79 Jarvis lane, not this CLI.
- Not a new model, not an inference engine. Thin client to brain v2's MiMo provider.

## 3. What Brain v2 ALREADY provides (reuse, not rewrite)

The multimodal path is **already shipped** in brain v2 (2026-05-27), so the CLI's
vision pipeline is almost pure forwarding:

- `brain-v2-mirror/provider-registry.ts`: the `mimo` provider (endpoint
  `https://token-plan-cn.xiaomimimo.com/v1`, OpenAI-compatible `/v1`) has
  vision/audio/video enabled and is the cascade head (built-in web search + thinking).
- `brain-v2-mirror/wire-adapter/mimo.ts`: `hasMultimodalContent()` detects OpenAI
  content parts - `image_url`/`input_image`, `input_audio`/`audio_url`,
  `video_url`/`input_video` - and `pickModel()` auto-switches: multimodal ->
  `mimo-v2.5` (or `MIMO_MULTIMODAL_MODEL`, e.g. `mimo-v2-omni`); text ->
  `mimo-v2.5-pro` (chat-optimized). Video URL <= 300MB, fps 0.1-10.
- `brain-v2-mirror/router.ts`: a vision/audio/video capability gate already filters
  providers and returns a friendly error if none support the requested modality.

So the CLI does **not** implement multimodal routing or model selection. It puts an
`image_url` content part into the `messages` and sends it to brain v2; brain
auto-routes to `mimo-v2.5`. The genuinely new client surface is small:

- image capture/encode into an `image_url` content part (file / clipboard / screenshot).
- grounding-output normalization (model text -> coords/selectors).
- a long-run / checkpoint manager (budget, resume, progress).

Other reuse: `shared/fleet-events.ts` (worker protocol - a MiMo worker emits the same
events, so the GUI Fleet board shows it with zero new wiring), `desktop/cli-env-manager.cjs`
(runtime), the session store, and the existing reasoning-visibility plumbing.

## 4. Wedge A (primary) - vision / GUI grounding

Concrete features, each leaning on MiMo's vision grounding:

- **screenshot -> code**: a UI screenshot / design frame -> component code.
- **visual bug fix**: a screenshot of a broken UI -> locate the element -> patch.
- **ground**: an image + a target description -> normalized `{x,y}` in [0,1] (+ an
  optional selector), emitted as JSONL for a GUI-automation step to consume. This is
  exactly what OSWorld-G measures.
- **visual diff review**: before/after screenshots -> what changed / regressions.
- **doc/chart/error understanding**: screenshots of logs, dashboards, dialogs.

Served via brain's `mimo-v2.5`/`mimo-v2-omni` (the deployed multimodal path).
`MiMo-VL-7B` stays an option for a cheap/local/edge vision tier later.

## 5. Wedge B (secondary) - long endurance

MiMo-V2.5-Pro sustains 1M context + 1000+ sequential tool calls coherently. Exploit
it for long autonomous work a turn-limited agent abandons:

- repo-wide refactors / migrations, large test-fix loops, multi-file features.
- a long-run loop with a step budget, periodic checkpoints (resume a long run),
  progress events, and context discipline (compaction even within 1M -
  `brain-v2-mirror/context-compact.ts` already exists).
- as a Fleet worker: the heavy-lift lane that grinds a big brief while the GUI
  watches diffs/tests (reuses the fleet JSONL protocol verbatim).

Endurance is real but not unique (Claude/DeepSeek also run long), so it rides
shotgun; vision is the headline.

## 6. Architecture (thin client)

```
lynn-mimo CLI / Fleet worker
  - image capture/encode  ->  messages[].content [{type:"image_url", ...}]
  - long-run/checkpoint manager (budget, resume, progress)
  - grounding-output normalizer ({x,y}/selector, JSONL)
        |  POST /v1/chat/completions (multimodal content parts)
        v
brain v2 (already multimodal)
  - provider-registry.ts: mimo provider, vision/audio/video on, cascade head
  - wire-adapter/mimo.ts: auto-switch mimo-v2.5-pro <-> mimo-v2.5 / v2-omni
  - router.ts: capability gate; context-compact.ts: long-ctx compaction
        |
        v
  MiMo OpenAI-compatible API (token-plan-cn.xiaomimimo.com/v1)  [+ Spark APEX fallback]
```

## 7. Command surface (illustrative)

```
lynn-mimo see <image>                      # describe + ground a screenshot
lynn-mimo ui2code <image>                  # screenshot/mockup -> component code
lynn-mimo fix --shot <image>               # visual bug -> locate + patch
lynn-mimo ground <image> "<target>" --json # -> {x,y}/selector for automation
lynn-mimo review --before a.png --after b.png  # visual diff review
lynn-mimo run --long "<task>" --max-steps 1000 --checkpoint  # endurance run
lynn-mimo run --resume <runId>             # resume a long run
# REPL: paste/drop an image; --image <path>
# Fleet: lynn worker run --agent mimo-vl ... --jsonl   (vision worker)
```

## 8. Differentiation matrix

| | MiMo CLI | Codex CLI / clone | DeepSeek-TUI / Reasonix |
|---|---|---|---|
| sees screenshots / grounds GUI | yes (beats UI-TARS) | no | no |
| screenshot -> code, visual bug fix | yes | no | no |
| 1M ctx + 1000+ tool-call endurance | yes (V2.5-Pro) | partial | partial |
| reasoning visibility | yes (table stakes) | partial | yes |
| voice (deferred to Jarvis) | later | no | no |

## 9. Fleet integration

- new worker kinds `mimo-vl` / `mimo-pro` in the worker registry.
- the GUI dispatch form gains an optional screenshot input (a vision brief).
- the long-endurance worker is the Fleet's heavy-lift lane.

## 10. Roadmap (phased)

- **P1 vision MVP**: `see` / `ground` / `ui2code` against brain v2's MiMo multimodal;
  JSONL grounding output; the `mimo-vl` Fleet worker.
- **P2**: visual bug fix + visual diff review; screenshot capture / clipboard input.
- **P3 endurance**: long-run loop, checkpoint/resume, budget; `mimo-pro` worker.
- **P4 polish**: model-tier auto-select hints, optional local MiMo-VL-7B vision tier.

## 11. Decision log + open questions

Decided (user, 2026-05-29): vision-primary + endurance-secondary; voice deferred to
the Jarvis lane. Multimodal routing is already done in brain v2 (no client routing).

Open:
- Q1 grounding output: does brain's `mimo-v2.5` return coordinates natively, or does
  the CLI prompt for `{x,y}`/selectors and parse? (verify against MiMo image-
  understanding docs.)
- Q2 screenshot capture: rely on the user passing an image, or add an OS capture tool
  (screenshot / window grab)? capture is an OS/main-process concern (like open-folder).
- Q3 image encoding: data-URI base64 vs uploaded URL (MiMo video needs a URL, <=300MB).
- Q4 endurance checkpoint format + location (`~/.lynn/runs/<id>/`), and reuse vs the
  Fleet's task runtime.
- Q5 model tier policy: when to force `mimo-v2-omni` vs default `mimo-v2.5`.

## Sources

- [XiaomiMiMo/MiMo-7B-RL (HF)](https://huggingface.co/XiaomiMiMo/MiMo-7B-RL) - reasoning-first 7B, MTP.
- [MiMo-7B Technical Report (GitHub)](https://github.com/XiaomiMiMo/MiMo) - ~90% MTP accept rate.
- [MiMo-VL Technical Report (arXiv 2506.03569)](https://arxiv.org/abs/2506.03569) - OSWorld-G 56.1, beats UI-TARS; OlympiadBench 59.4.
- [XiaomiMiMo/MiMo-VL-7B-RL (HF)](https://huggingface.co/XiaomiMiMo/MiMo-VL-7B-RL) - native-resolution ViT + MiMo backbone.
- [MiMo-V2.5 (official)](https://mimo.xiaomi.com/mimo-v2-5/) - native vision/audio/video, 1M ctx, agentic.
- [Xiaomi MiMo API platform](https://platform.xiaomimomo.com) - OpenAI-compatible endpoint, multimodal docs.
- [Xiaomi MiMo (Wikipedia)](https://en.wikipedia.org/wiki/Xiaomi_MiMo) - family overview, MIT license.
- In-repo (verified): `brain-v2-mirror/provider-registry.ts`, `brain-v2-mirror/wire-adapter/mimo.ts`, `brain-v2-mirror/router.ts`.
