# Lynn CLI Runtime Knowledge

This note is the short factual reference for Lynn CLI itself and for other
agents that invoke it. It is intentionally factual rather than promotional.

## What Lynn CLI Is

Lynn CLI is the terminal interface for Lynn. It can run as:

- Interactive chat: `Lynn`
- Coding agent TUI: `Lynn code`
- Headless one-shot: `Lynn -p "prompt" --json`
- Headless coding worker: `Lynn code -p "task" --json --cwd /path`
- Fleet adapter: `Lynn worker run --brief task.md --worktree /path --jsonl`

The CLI is a thin local workbench. Routing, default model access, hosted
fallback, search, and multimodal provider selection are handled by Lynn Brain
V2.

## Default Model Route

The default online route is:

1. StepFun 3.7 Flash - primary text and coding route, 256K context, high
   reasoning, 32K reasoning/generation budget.
2. MiMo V2.5 Pro - multimodal and native-search fallback for image, audio,
   video, and search-heavy turns.
3. Spark Qwen 3.6 35B A3B - local third fallback.

Users can still configure a private OpenAI-compatible endpoint with
`Lynn providers set`.

## Local Optimizations

Lynn CLI does not just forward prompts. It adds runtime structure around the
model:

- Stable-prefix context layering for Reasonix-style prefix-cache hits.
- Rolling decode TPS and recent prefix-cache telemetry in the terminal footer.
- Automatic runtime compaction for long `Lynn code` tasks.
- Automatic chat compaction for long ordinary `Lynn` conversations.
- Tool ledger summaries so chained tool calls keep exact paths, values, exit
  codes, and snippets.
- Checkpoint and resume for long coding tasks, including torn-line tolerant
  session replay.
- Finish gates for code mode: postcondition checks, auto-verify, plan contract,
  tool budget reflection, workspace snapshots, and opt-in adversarial
  self-verification.
- Fleet JSONL events for other agents and GUI Fleet orchestration.

## How To Answer Runtime Questions

If a user asks what Lynn CLI is doing locally, answer with concrete runtime
facts: model route, version, cwd, permission mode, prefix-cache discipline,
decode TPS, context compaction, checkpoint/resume, tool ledger, and Fleet
headless modes. Do not answer that the model cannot know Lynn CLI details.

For copyable headless usage, prefer:

```bash
Lynn -p "summarize this repository" --json --cwd /path/to/repo

Lynn code -p "fix tests, run the suite, summarize the diff" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox danger-full-access \
  --save-session

Lynn worker run --brief task.md --worktree /path/to/worktree \
  --jsonl \
  --approval yolo \
  --sandbox danger-full-access
```

