# Lynn Code Headless Agent Contract

Status: v0.81.0 integration contract.

This document is for other agents, CI jobs, and GUI Fleet workers that need to
call Lynn Code without an interactive terminal.

## One Sentence

Use `Lynn code -p "<task>" --json --cwd <worktree>` to run a coding task
non-interactively and consume line-delimited JSON events.

## Agent Quick Contract

This is the short contract another coding agent should read first:

```bash
# Prerequisite: Node.js 20 LTS or 22 LTS with npm.
# macOS: brew install node@20
# macOS/Linux: nvm install 20 && nvm use 20
# Windows: winget install OpenJS.NodeJS.LTS

# Install or update Lynn CLI.
npm install -g --force https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.81.0.tgz

# Verify the binary without needing a model backend.
Lynn version
Lynn doctor --offline

# Human launch commands.
Lynn
Lynn code
Lynn agents

# One-shot prompt. JSONL on stdout, exits when complete.
Lynn -p "summarize this repository" --json --cwd /path/to/repo

# Headless coding agent. Use this inside an isolated worktree.
Lynn code -p "fix the failing tests, run tests, summarize the diff" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox danger-full-access \
  --save-session

# Exhaustive best-effort task with resumable checkpoints.
Lynn code --best -p "find the best solution, implement it, run gates" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox danger-full-access \
  --save-session

# GUI Fleet worker adapter. Emits Fleet JSONL, not human prose.
Lynn worker run --brief task.md --worktree /path/to/worktree \
  --jsonl \
  --approval yolo \
  --sandbox danger-full-access

# Wrap a different CLI under Lynn Fleet.
Lynn worker run --brief task.md --worktree /path/to/worktree \
  --agent custom \
  --agent-command "your-cli --json" \
  --jsonl
```

Rules for agents:

- Use `--json` or `--jsonl`; never parse the human terminal TUI.
- Always pass `--cwd` / `--worktree`.
- Use `--approval yolo --sandbox danger-full-access` only in an isolated git
  worktree.
- Read `code.task.finished.resumeCommand` if max steps are reached.
- Ignore unknown event types; key off `type`.
- Treat `code.tool.ledger` as source-of-truth for chained tool values.

## Supported Entry Points

All three forms below run the same code agent path:

```bash
Lynn code "review the current diff" --json --cwd /path/to/repo
Lynn code -p "review the current diff" --json --cwd /path/to/repo
Lynn code --prompt "review the current diff" --json --cwd /path/to/repo
```

`-p`, `--prompt`, and `--print` are accepted so callers can pass the task as a
flag, which is easier for process wrappers than positional text.

## Recommended Invocation

For read-only review:

```bash
Lynn code -p "review the current diff and list risks" \
  --json \
  --cwd /path/to/worktree \
  --approval ask \
  --sandbox read-only
```

For an isolated worker that may edit files and run commands:

```bash
Lynn code -p "fix the failing tests, run the suite, and summarize the diff" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox danger-full-access \
  --max-steps 20 \
  --save-session
```

For exhaustive best-effort work:

```bash
Lynn code --best -p "find the best solution, implement it, run gates" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox danger-full-access \
  --save-session
```

`--best` is equivalent to `--exhaustive`:it keeps StepFun 3.7 Flash as the fast
head route, raises the budget to 300 steps, enables ultra task decomposition,
atomic workers, adversarial verification, automatic checkpoints, and runtime
compaction. The harness never chooses the final answer for the model; it only
decomposes, dispatches, verifies, repairs, and prevents tool storms.

## Output

Output is JSONL: one JSON object per line on stdout. Callers should ignore
unknown event types and key off `type`.

Common events:

| Event | Meaning |
| --- | --- |
| `code.task.started` | Lynn accepted the task and captured repository context. |
| `reasoning.delta` | Model reasoning. Hidden reasoning is marked with `hidden:true`. |
| `assistant.delta` | Assistant content. In final JSON mode this may be emitted once with the final text. |
| `code.tool.requested` | The model requested a local tool. |
| `code.tool.result` | A local tool finished. |
| `code.tool.ledger` | Compact source-of-truth ledger for chained tool work. |
| `code.runtime.compacted` | Older runtime turns were compacted while preserving the goal, current plan, and recent tool results. |
| `session.checkpoint` | A resumable session line was written. |
| `session.resumed` | A previous session was loaded. |
| `session.saved` | Final session path. |
| `code.task.finished` | Final status, usage summary, session path, and optional resume command. |

Example:

```jsonl
{"type":"code.task.started","ts":"2026-05-30T00:00:00.000Z","task":"review","context":{"cwd":"/repo"}}
{"type":"assistant.delta","ts":"2026-05-30T00:00:02.000Z","text":"..."}
{"type":"code.task.finished","ts":"2026-05-30T00:00:03.000Z","ok":true,"contentReturned":true}
```

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Task completed. |
| `1` | Tool failure, provider failure, invalid invocation, or explicit denial. |
| `2` | Max step budget reached. Check `resumeCommand` in `code.task.finished`. |

## Permissions

Lynn does not silently grant write access. Callers must choose the permission
profile:

- `--approval ask --sandbox read-only`: safest review mode.
- `--approval ask --sandbox workspace-write`: interactive human mode.
- `--approval yolo --sandbox danger-full-access`: autonomous worker mode inside an
  isolated worktree.
- `--sandbox danger-full-access`: only for trusted local debugging.

For GUI Fleet, use isolated git worktrees and let Fleet validate ownership,
forbidden globs, tests, and the final diff before merge.

## Model Routing

By default, `Lynn code` talks to the local Lynn Brain router:

1. StepFun 3.7 Flash with 256K context, high reasoning, and a 32K reasoning/generation budget.
2. MiMo V2.5 Pro / Omni fallback, including multimodal turns.
3. Spark Qwen 3.6 35B A3B local fallback.

If the local Lynn Brain server is offline, start it with `Lynn brain start` or
open the Lynn client GUI. For machines that should run without the client/Brain,
configure CLI-only BYOK:

```bash
Lynn providers set --base-url https://api.example.com/v1 --api-key <key> --model <model-id>
```

## Resume

Use `--save-session` for background work. If a task stops at the max step budget,
the final `code.task.finished` event includes `resumeCommand`.

Manual resume:

```bash
Lynn code --resume /path/to/session.jsonl --long -p "continue the task" --json
```

Lynn repairs incomplete tool frames on resume by preserving completed tool
results and inserting explicit missing-result markers for interrupted calls.
During long runs it may also compact older runtime turns before the next model
request; the `code.runtime.compacted` event is informational and means the active
goal, current plan, and recent tool results were kept.

## Input Media

For multimodal coding tasks, pass files explicitly:

```bash
Lynn code -p "explain this UI bug and propose a fix" \
  --image screenshot.png \
  --json \
  --cwd /path/to/repo
```

`--image` and `--images` support image paths; pasted or prompted attachment
paths in the interactive TUI can include image, audio, and video files.

## Contract Rules For Agents

1. Always pass `--json` for machine calls.
2. Always pass `--cwd`.
3. Do not parse the Ink or human TUI.
4. Do not rely on event order except that `code.task.finished` is terminal.
5. Ignore unknown JSONL event types.
6. Treat `code.tool.ledger` as source-of-truth for chained tool values.
7. Use `--save-session` for long or important tasks.
8. Use `--approval yolo` only in an isolated worktree.
