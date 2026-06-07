# Lynn CLI v0.80 Install Snippet

Use this block on the mirror download page and at the top of the GitHub release
notes. It is intentionally short enough for humans to copy and explicit enough
for other coding agents to parse.

## Install

```bash
# 1. Node requirement: Node.js 20 LTS or 22 LTS with npm.
# macOS: brew install node@20
# macOS/Linux: nvm install 20 && nvm use 20
# Windows: winget install OpenJS.NodeJS.LTS

# 2. Install or update Lynn CLI from the CDN.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.81.0.tgz"

# 3. Launch.
Lynn          # interactive chat TUI
Lynn code     # coding-agent TUI
Lynn agents   # copyable headless/Fleet commands for other agents
```

## Headless / Fleet

```bash
# One-shot prompt, no TUI.
Lynn -p "summarize this repository" --json --cwd /path/to/repo

# Headless coding worker inside an isolated worktree.
Lynn code -p "fix tests, run the suite, summarize the diff" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox danger-full-access \
  --save-session

# Exhaustive best mode: 300 steps + decomposition + adversarial verification.
Lynn code --best -p "find the best solution, implement it, run gates" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox danger-full-access \
  --save-session

# GUI Fleet adapter. Emits Fleet JSONL.
Lynn worker run --brief task.md --worktree /path/to/worktree \
  --jsonl \
  --approval yolo \
  --sandbox danger-full-access
```

Rules for agents: use `--json` or `--jsonl`, always pass `--cwd` or
`--worktree`, and use `--approval yolo --sandbox danger-full-access` only inside an
isolated git worktree. Use `--best` / `--exhaustive` for tasks that need the
best completed result instead of the fastest short answer.
