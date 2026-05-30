# Lynn CLI · Agent Quick Contract

> Machine-readable invocation spec for orchestrators and fleet agents.
> Human docs: [README](README.md) · `lynnc --contract` prints this file.

---

## Install

```bash
npm i -g @lynn/cli          # persistent
npx lynnc --version         # ad-hoc, no install
```

Requires: brain v2 running on `127.0.0.1:8790` (default).
Override: `BRAIN_V2_URL=http://host:port lynnc ...`

---

## Non-Interactive Invocation

```bash
# One-shot, exits when done
lynnc -p "PROMPT" [FLAGS]

# Code-agent mode (read/write/bash/grep in CWD)
lynnc code -p "TASK" [FLAGS]

# Resume session
lynnc -p "PROMPT" --session SESSION_ID [FLAGS]
```

**Always pass `--no-interactive` from a non-TTY context** (CI, subprocess, pipe).
Brain v2 must be running before invocation; lynnc does not start it.

---

## Flags (agent-relevant)

| Flag | Short | Effect |
|---|---|---|
| `--no-interactive` | | Force non-TTY mode, never pause for input |
| `--yes` | `-y` | Auto-approve all tool calls without prompting |
| `--allow TOOLS` | | Comma-separated tool allowlist: `bash,read_file,write_file,grep,glob,web_search` |
| `--deny TOOLS` | | Comma-separated tool denylist |
| `--json` | | Force JSONL output (default when stdout is not a TTY) |
| `--workspace PATH` | `-w` | Set working directory for file tools |
| `--session ID` | `-s` | Resume or label a named session |
| `--timeout SECS` | `-t` | Abort after N seconds (default: 600) |
| `--max-turns N` | | Max tool-call iterations (default: 50) |
| `--reasoning-effort LEVEL` | | `low` / `medium` / `high` (default: `high`) |
| `--model ID` | | Override brain v2 provider (e.g. `step-3.7-flash`) |
| `--contract` | | Print this contract to stdout and exit 0 |

---

## Output: JSONL Event Stream

When `--json` is active (or stdout is not a TTY), lynnc emits newline-delimited JSON:

```jsonl
{"type":"session","id":"sess_abc123","model":"step-3.7-flash"}
{"type":"thinking","delta":"Let me read the file first..."}
{"type":"content","delta":"Here is the fix:\n"}
{"type":"content","delta":"```typescript\n..."}
{"type":"tool_call","id":"tc_1","name":"read_file","args":{"path":"src/auth.ts"}}
{"type":"tool_result","id":"tc_1","content":"export function login...","error":null}
{"type":"tool_call","id":"tc_2","name":"write_file","args":{"path":"src/auth.ts","content":"..."}}
{"type":"tool_result","id":"tc_2","content":"written","error":null}
{"type":"content","delta":"Done. Changed line 42 to use bcrypt."}
{"type":"finish","reason":"stop","usage":{"input":1820,"output":312}}
```

**Event types:**

| type | When | Key fields |
|---|---|---|
| `session` | First event | `id`, `model` |
| `thinking` | Reasoning in progress | `delta` (partial) |
| `content` | Answer streaming | `delta` (partial) |
| `tool_call` | Tool about to execute | `id`, `name`, `args` |
| `tool_result` | Tool completed | `id`, `content`, `error` |
| `pre_search` | Web search triggered | `query`, `hit` (bool), `cached` |
| `error` | Hard failure | `message`, `code` |
| `finish` | Stream ended | `reason`: `stop`\|`length`\|`error`, `usage` |

Concatenate all `content.delta` fields for the final answer text.
Concatenate all `thinking.delta` fields for the reasoning trace.

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Task completed successfully |
| `1` | Startup error (brain v2 unreachable, bad flags, install issue) |
| `2` | Task error (model returned error, max-turns exceeded, timeout) |
| `3` | Tool permission denied (blocked by --deny or missing --yes) |
| `130` | Interrupted (SIGINT / Ctrl+C) |

---

## Fleet Worker Patterns

### Orchestrator dispatches single task

```bash
lynnc code \
  -p "Fix the failing test in src/__tests__/auth.test.ts" \
  --yes \
  --workspace /repo \
  --session worker-auth-fix \
  --json \
  2>&1 | tee worker-auth-fix.jsonl
echo "exit: $?"
```

### Parallel workers (N tasks, N processes)

```bash
# tasks.txt: one task per line
cat tasks.txt | parallel -j4 \
  lynnc code -p {} --yes --workspace /repo --json \
  '>' results/{#}.jsonl
```

### Pipe task from orchestrator stdout

```bash
# Orchestrator writes task JSON to stdout; worker reads it
orchestrator-agent | while IFS= read -r line; do
  task=$(echo "$line" | jq -r '.task')
  lynnc code -p "$task" --yes --json >> fleet.jsonl
done
```

### Check result in orchestrator

```bash
# Parse finish event from worker output
result=$(grep '"type":"finish"' worker.jsonl | tail -1)
reason=$(echo "$result" | jq -r '.reason')
answer=$(grep '"type":"content"' worker.jsonl | jq -r '.delta' | tr -d '\n')

if [ "$reason" = "stop" ]; then
  echo "SUCCESS: $answer"
else
  echo "FAIL: reason=$reason"
  exit 2
fi
```

---

## Permissions Model

lynnc has two permission layers:

**1. Tool allowlist/denylist (flag-level)**
```bash
--yes                          # approve everything
--allow bash,write_file        # only allow these tools, prompt for others
--deny bash                    # block bash, allow everything else
```

**2. brain v2 tool-storm guard (server-level)**
Repeated identical tool calls within a sliding window are suppressed automatically.
No agent action needed; it's transparent.

**Safe defaults for fleet workers:**
```bash
# Read-only worker (analysis, review)
lynnc code -p "TASK" --allow "read_file,grep,glob,web_search" --no-interactive --json

# Read-write worker (implement, fix)
lynnc code -p "TASK" --yes --no-interactive --json

# Read-write + shell worker (implement, test, verify)
lynnc code -p "TASK" --allow "read_file,write_file,bash,grep,glob" --yes --no-interactive --json
```

---

## Session Sharing (GUI ↔ CLI)

lynnc and the Lynn GUI share the same session store.

```bash
# Start in CLI
lynnc -p "Begin refactoring auth module" --session auth-refactor

# Continue in GUI: select session "auth-refactor"
# Continue in CLI:
lynnc -p "Now add the JWT refresh logic" --session auth-refactor
```

---

## Quick Health Check

```bash
lynnc --version                         # prints version, checks brain v2
lynnc -p "ping" --json --timeout 10     # end-to-end smoke test
# expect: {"type":"finish","reason":"stop",...} on last line, exit 0
```

---

## Environment Variables

```bash
BRAIN_V2_URL=http://127.0.0.1:8790   # brain v2 endpoint (default)
BRAIN_V2_CHAIN_TOOL_HINT=1           # enable chain-tool anchor (recommended for fleet)
LYNNC_SESSION_DIR=~/.lynn/sessions   # session store path
LYNNC_LOG_LEVEL=error                # silent in fleet (error|warn|info|debug)
```

---

*Contract version: 0.1 · Lynn CLI MVP · 2026-05-30*
*Print with: `lynnc --contract`*
