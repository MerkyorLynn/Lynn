# @lynn/cli

Terminal and worker-runner interface for Lynn v0.80.

This package is intentionally thin. When the Lynn client GUI is running, model routing uses
the local Lynn server / Brain chain and defaults to StepFun 3.7 Flash (256K context, high reasoning, 32K reasoning/generation budget),
then MiMo V2.5 Pro, then Spark Qwen 3.6 35B A3B. When the client GUI is not
running, the CLI can fall back to a user-owned OpenAI-compatible BYOK endpoint.
The CLI handles terminal UX, worker JSONL, and local file/shell orchestration.

## Quick start

Prerequisite: Node.js 20 LTS or 22 LTS with npm.

```bash
# macOS, Homebrew:
brew install node@20

# macOS / Linux, nvm:
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 20
nvm use 20

# Windows, PowerShell:
winget install OpenJS.NodeJS.LTS
```

Install from the Lynn Tencent mirror:

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.3.tgz"
```

The package installs the `Lynn` command. If you installed an older preview that
also created a lowercase `lynn` shim, current builds clean the old Lynn-owned
shim during global install before creating the `Lynn` command.

Start here after installing:

```bash
Lynn                 # interactive chat TUI
Lynn code            # coding-agent TUI
Lynn agents          # copyable headless / Fleet commands for other agents
```

If npm dependency downloads are slow in mainland China, keep the Lynn tarball URL
as-is and add a registry mirror for third-party dependencies:

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.3.tgz" \
  --registry=https://registry.npmmirror.com
```

Release maintainers can smoke-test the exact CDN tarball before inviting
external testers:

```bash
LYNN_CLI_TARBALL_URL="https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.3.tgz" \
  npm run test:cli-install:remote
```

```bash
Lynn version
Lynn doctor --offline
Lynn "summarize this repo"
Lynn -p "summarize this repo" --json
Lynn exec "review the current diff" --reasoning auto --show-reasoning auto
Lynn code "review the current diff"
Lynn code -p "review the current diff" --json
Lynn chat
cat README.md | Lynn "summarize this file"
Lynn - < README.md
```

`Lynn` is the primary command. The npm package intentionally avoids installing a
separate lowercase `lynn` binary because macOS default filesystems are
case-insensitive and npm cannot safely create both shims in the same prefix.

## Runtime routing and CLI-only BYOK fallback

`Lynn`, `Lynn chat`, and `Lynn code` can start directly after `npm install -g`.
They try routes in this order:

1. Hosted Lynn Brain router (`https://api.merkyorlynn.com/api/v2`) when reachable.
2. Local Lynn Brain router, if you explicitly set `LYNN_BRAIN_URL` or the hosted route is unavailable and local is online.
3. CLI-only BYOK fallback, if you configured one with `Lynn providers set`.
4. Mock mode only when you explicitly pass `--mock-brain`.

The default StepFun -> MiMo -> Spark routing lives in Lynn Brain and is usable from a
fresh CLI install through the hosted route. You can still configure your own
OpenAI-compatible endpoint when you want a private or company-owned route:

```bash
Lynn providers set
```

The interactive setup asks for three standard OpenAI-compatible fields:

1. API URL - copy the base URL from your provider docs. It usually ends with
   `/v1`, for example `https://api.openai.com/v1`.
2. API Key - create or copy it from your provider console.
3. Model name - copy the exact model id from the provider's model list.

For scripts, pass the same fields as flags:

```bash
Lynn providers set \
  --base-url https://api.example.com/v1 \
  --api-key <api-key> \
  --model model-id
```

Common presets fill the API URL and model name while still requiring your own
key:

```bash
Lynn providers set --preset mimo --api-key <token-plan-key>
Lynn providers set --preset stepfun --api-key <stepfun-key>
Lynn providers presets
```

The profile is stored in `~/.lynn/providers/cli.json` with the key redacted in
terminal output. `Lynn -p`, `Lynn chat`, `Lynn code`, and built-in Lynn workers
try the local Brain first; if it is offline, they use this BYOK provider.

For full default Brain routing, web search, and GUI Fleet orchestration, keep the
local Brain online with `Lynn brain start` or the Lynn client GUI. Provider
management for the default Brain route remains in the Lynn client GUI.

## Headless code mode for other agents

External agents and CI jobs should call `Lynn code` in JSONL mode. Both forms
below are equivalent; `-p/--prompt/--print` exists so agents can pass the task as
a flag without relying on positional parsing:

```bash
Lynn code "review the current diff" --json --cwd /path/to/repo
Lynn code -p "review the current diff" --json --cwd /path/to/repo
Lynn code --prompt "fix the failing tests" --json --cwd /path/to/repo
```

Agent quick contract:

```bash
# Requires Node.js 20 LTS or 22 LTS with npm.

# Install/update.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.80.3.tgz"

# Human launch commands.
Lynn
Lynn code
Lynn agents

# One-shot prompt, no TUI.
Lynn -p "summarize this repository" --json --cwd /path/to/repo

# Headless coding worker, no per-tool prompts inside an isolated worktree.
Lynn code -p "fix tests, run the suite, summarize the diff" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox workspace-write \
  --save-session

# Fleet JSONL adapter.
Lynn worker run --brief task.md --worktree /path/to/worktree \
  --jsonl \
  --approval yolo \
  --sandbox workspace-write
```

For write-capable background work, make the permission mode explicit:

```bash
Lynn code -p "fix the failing tests, run the test suite, and report the diff" \
  --json \
  --cwd /path/to/repo \
  --approval yolo \
  --sandbox workspace-write \
  --max-steps 20 \
  --save-session
```

JSONL output is line-delimited. Important event types:

- `code.task.started` - task accepted with repository context.
- `reasoning.delta` - hidden or visible model reasoning stream.
- `code.tool.requested` / `code.tool.result` - local tool calls and outputs.
- `code.tool.ledger` - compact source-of-truth ledger for chained tool work.
- `session.checkpoint` / `session.saved` - resumable session path.
- `code.task.finished` - final status, usage, and optional resume command.

Recommended agent defaults:

- Use `--json`; never parse human TUI output.
- Use `--cwd` so the worktree is explicit.
- Use `--save-session` for tasks that may exceed one turn.
- Use `--long --max-steps 1000` only for deliberate endurance runs.
- Use `--approval yolo --sandbox workspace-write` only inside an isolated
  worktree. Keep `ask` or `read-only` for shared checkouts.

See `docs/ops/lynn-code-headless-agent-contract.md` for the full contract.

## Worker mode

`Lynn worker run` is the stable adapter between Lynn client GUI Fleet and coding CLIs.
It reads a task brief, emits Fleet JSONL events, and can wrap external agents.

```bash
Lynn worker run --brief task.md --worktree . --mock --jsonl
Lynn worker run --brief task.md --worktree . --agent codex-cli --jsonl
Lynn worker run --brief task.md --worktree . --agent claude-code --jsonl
Lynn worker run --brief task.md --worktree . --agent opencode --jsonl
Lynn worker run --brief task.md --worktree . --agent qwen-cli --jsonl
Lynn worker run --brief task.md --worktree . --agent kimi-cli --jsonl
```

For one-off adapters, pass `--agent-command`:

```bash
Lynn worker run --brief task.md --worktree . \
  --agent custom \
  --agent-command "node ./scripts/my-worker.mjs" \
  --jsonl
```

External workers receive `LYNN_WORKER_ID`, `LYNN_WORKER_AGENT`, and
`LYNN_NO_MODEL_DOWNLOADS=1`. Lines that already match Fleet JSONL are forwarded;
plain stdout/stderr lines are wrapped as `worker.progress` events.

Built-in worker adapters are non-interactive by default and receive the full
task brief with Lynn's guardrails prepended. The current templates are:

| Agent | Command shape |
| --- | --- |
| `codex-cli` | `codex exec --cd <worktree> --json --dangerously-bypass-approvals-and-sandbox <brief>` |
| `claude-code` | `claude -p <brief> --add-dir <worktree> --output-format stream-json --include-partial-messages --dangerously-skip-permissions` |
| `claude-internal` | `claude-internal -p <brief> --add-dir <worktree> --output-format stream-json --include-partial-messages --permission-mode bypassPermissions` |
| `qwen-cli` | `qwen -p <brief> --add-dir <worktree> --output-format stream-json --include-partial-messages --approval-mode yolo --yolo` |
| `kimi-cli` | `kimi --work-dir <worktree> --print --output-format stream-json --yolo --afk -p <brief>` |
| `opencode` | `opencode run --format json --cwd <worktree> <brief>` |

Fleet still validates claimed ownership, forbidden globs, and resulting diffs on
the Lynn side; worker CLI flags only prevent the external agent from stalling on
interactive approval prompts.

## Code tools

`Lynn code --tool bash` and `write_file` require `--approval yolo`. Bash commands
default to a 120 second timeout and cap captured stdout/stderr to keep stuck
commands from blocking Fleet workers:

```bash
Lynn code --tool bash --command "npm test" --approval yolo --timeout-ms 300000 --json
```
