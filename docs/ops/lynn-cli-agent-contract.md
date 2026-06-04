# Lynn CLI · Agent Quick Contract

> Machine-readable invocation spec for orchestrators and Fleet workers.
> Command is `Lynn` (uppercase; `lynn` also resolves on case-insensitive filesystems like macOS — use `Lynn` on Linux/CI).
> v0.80.6. Verified against `cli/` on branch `codex/v0806-cli-tool-trace`.

---

## Install

```bash
# Lynn mirror tarball (npm registry package not yet published)
npm install -g --force https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.7.tgz

# Slow deps in mainland China:
npm install -g --force https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.7.tgz \
  --registry=https://registry.npmmirror.com
```

`--force` lets npm replace an older `Lynn`/`lynn` shim. Requires Node ≥ 20.

**Routing:** fresh CLI installs use Lynn hosted Brain by default (StepFun 3.7 Flash → MiMo → Spark cascade). A local Lynn Brain or GUI is optional. BYOK (`Lynn providers set`) is available when a user wants their own OpenAI-compatible endpoint.

**Long-run cache discipline:** Lynn Code keeps stable prompt layers fixed for
Reasonix-style prefix-cache hits. Machine output may include
`code.runtime.compacted` when older turns are compressed; callers should treat it
as informational and continue parsing later JSONL events.

---

## Non-Interactive Invocation

```bash
Lynn -p "PROMPT" --json                          # one-shot, JSONL out, exits
Lynn exec "TASK" --reasoning auto --json         # exec mode
Lynn code "TASK"                                 # code agent (read/write/bash/grep in cwd)
echo "..." | Lynn -p "PROMPT" --json             # piped stdin
Lynn - < FILE                                    # file as stdin
```

`-p` / `--json` forces non-TTY JSONL mode (also auto-detected when stdout is a pipe).
Brain or a configured BYOK provider must be reachable; `Lynn doctor --offline` checks setup.

---

## BYOK Setup (CLI-only, GUI not running)

```bash
Lynn providers set --preset stepfun --api-key <key>   # step-3.7
Lynn providers set --preset mimo    --api-key <key>   # MiMo
Lynn providers presets                                # list presets
# manual:
Lynn providers set --base-url https://api.x.com/v1 --api-key <key> --model <id>
```

Stored at `~/.lynn/providers/cli.json`, key redacted in terminal output.

---

## Worker Mode (the Fleet adapter)

`Lynn worker run` is the stable bridge between GUI Fleet and coding CLIs. Reads a
task brief (markdown), runs in a worktree, emits Fleet JSONL.

```bash
# step-3.7 worker (via Brain)
Lynn worker run --brief task.md --worktree . --jsonl

# wrap an external agent CLI (Lynn = unified adapter)
Lynn worker run --brief task.md --worktree . --agent codex-cli    --jsonl
Lynn worker run --brief task.md --worktree . --agent claude-code  --jsonl
Lynn worker run --brief task.md --worktree . --agent qwen-cli     --jsonl
Lynn worker run --brief task.md --worktree . --agent kimi-cli     --jsonl
Lynn worker run --brief task.md --worktree . --agent opencode     --jsonl

# dry run (no model)
Lynn worker run --brief task.md --worktree . --mock --jsonl

# custom adapter
Lynn worker run --brief task.md --worktree . \
  --agent custom --agent-command "node ./scripts/my-worker.mjs" --jsonl
```

**Built-in external agent commands** (Lynn prepends guardrails, runs non-interactive):

| `--agent` | underlying command |
|---|---|
| `codex-cli` | `codex exec --cd <wt> --json --dangerously-bypass-approvals-and-sandbox <brief>` |
| `claude-code` | `claude -p <brief> --add-dir <wt> --output-format stream-json --include-partial-messages --dangerously-skip-permissions` |
| `qwen-cli` | `qwen -p <brief> --add-dir <wt> --output-format stream-json --approval-mode yolo --yolo` |
| `kimi-cli` | `kimi --work-dir <wt> --print --output-format stream-json --yolo --afk -p <brief>` |
| `opencode` | `opencode run --format json --cwd <wt> <brief>` |

External workers receive env: `LYNN_WORKER_ID`, `LYNN_WORKER_AGENT`, `LYNN_NO_MODEL_DOWNLOADS=1`.
Lines already in Fleet JSONL are forwarded; plain stdout/stderr wrapped as `worker.progress`.

**Safety lives on the Lynn side, not the worker flags.** Fleet validates claimed
ownership, forbidden globs, and the resulting diff. The `--yolo` /
`--dangerously-*` flags on wrapped CLIs only stop them stalling on interactive
approval — they do not relax Lynn's boundary checks.

---

## Fleet JSONL Event Stream

Newline-delimited JSON. Every event carries `workerId` and `agent`.

```jsonl
{"type":"worker.started","workerId":"w1","agent":"step-3.7","cwd":".","worktree":".","branch":"fleet/w1","approval":"yolo","sandbox":"workspace-write"}
{"type":"reasoning.delta","workerId":"w1","agent":"step-3.7","text":"...","hidden":true}
{"type":"assistant.delta","workerId":"w1","agent":"step-3.7","text":"Here is the fix..."}
{"type":"tool.started","workerId":"w1","agent":"step-3.7","name":"write_file"}
{"type":"tool.finished","workerId":"w1","agent":"step-3.7","name":"write_file","ok":true}
{"type":"shell.started","workerId":"w1","agent":"step-3.7","command":"npm test"}
{"type":"shell.output","workerId":"w1","agent":"step-3.7","text":"..."}
{"type":"shell.finished","workerId":"w1","agent":"step-3.7","command":"npm test","exitCode":0,"ok":true}
{"type":"test.started","workerId":"w1","agent":"step-3.7","command":"npm test"}
{"type":"test.finished","workerId":"w1","agent":"step-3.7","ok":true,"summary":"...","ms":4210}
{"type":"git.diff","workerId":"w1","agent":"step-3.7","...":"..."}
{"type":"gate.finished","workerId":"w1","agent":"step-3.7","ok":true}
{"type":"worker.progress","workerId":"w1","agent":"codex-cli","text":"raw stdout line"}
{"type":"worker.violation","workerId":"w1","agent":"step-3.7","...":"ownership/glob breach"}
{"type":"worker.error","workerId":"w1","agent":"step-3.7","code":"worker_exit_nonzero","message":"...","recoverable":true}
{"type":"worker.finished","workerId":"w1","agent":"step-3.7","ok":true,"exitCode":0,"summary":"...","commit":"a1b2c3d"}
```

**Event types:**

| type | meaning | key fields |
|---|---|---|
| `reasoning.delta` | thinking trace (hidden) | `text`, `hidden:true` |
| `assistant.delta` | answer streaming | `text` |
| `tool.started` / `tool.finished` | model tool call | `name`, `ok` |
| `shell.started` / `shell.output` / `shell.finished` | shell command | `command`, `exitCode`, `ok` |
| `test.started` / `test.finished` | test run | `command`, `ok`, `summary`, `ms` |
| `git.diff` | resulting diff | diff payload |
| `gate.finished` | Lynn-side validation gate | `ok` |
| `worker.started` | worker lifecycle begin | `workerId`, `cwd`, `worktree`, `branch` (opt `pid`, `command`, `approval`, `sandbox`) |
| `worker.progress` | wrapped external agent raw output | `text` |
| `worker.violation` | ownership / forbidden-glob breach | breach detail |
| `worker.error` | worker failure | `code`, `message`, `recoverable` |
| `worker.finished` | worker lifecycle end (terminal) | `ok`, `exitCode`, `summary` (opt `commit`) |

**Orchestrator parse pattern:**
- Answer = concat `assistant.delta.text`
- Success signal = `gate.finished.ok === true` (or final `shell/test.finished.ok`)
- Hard fail = any `worker.violation`, or `worker.error` with `recoverable:false`
- Non-zero worker exit → `worker.error` `code:"worker_exit_nonzero"`
- Lifecycle bookends = `worker.started` (begin) … `worker.finished` (terminal; carries final `ok` / `exitCode` / optional `commit`)

---

## Code Tools (direct, outside worker mode)

```bash
Lynn code --tool bash --command "npm test" --approval yolo --sandbox danger-full-access --timeout-ms 300000 --json
Lynn code --tool write_file ... --approval yolo
```

`bash` and `write_file` require approval. For autonomous workers, use
`--approval yolo --sandbox danger-full-access` inside an isolated worktree. Bash
defaults to 120s timeout, stdout/stderr capped to keep stuck commands from
blocking Fleet workers.

---

## Health Check

```bash
Lynn version
Lynn doctor --offline                    # local setup check, no network
Lynn -p "ping" --json                    # end-to-end smoke
```

---

*Contract v0.3 · Lynn CLI v0.80.6 · verified against cli/ source 2026-06-01*
