# Lynn Live Compaction Spine

Lynn now contains an opt-in local compaction spine adapted from
`dsh-live-compact` 1.1.5. It is deliberately separate from the existing
model-backed compaction and session relay paths.

Enable it for a GUI/bridge runtime with:

```bash
LYNN_LIVE_COMPACTION=1 Lynn
```

Enable the CLI adapter for a coding run with the same environment variable:

```bash
LYNN_LIVE_COMPACTION=1 Lynn code
```

The default is disabled. The shared GUI/bridge path writes an append-only
`live_compaction` entry to the session JSONL and keeps the original tool result
in a per-session `.live-compact` directory. Tool results go through a
session-scoped serial capture queue, so the answer event does not wait for a
historical scan. Before a patch is committed, Lynn re-reads the branch,
rechecks the checkpoint floor, verifies the selected raw backups, and applies a
leaf/digest CAS. A changed branch or unavailable backup leaves the original
messages in place. The model receives a verified local pointer and a bounded
excerpt; the original JSONL message is never rewritten. The CLI uses the same
planner and async raw-store queue because its coding loop has a separate
in-memory message protocol. Its raw backups are persistent, while the patch
projection is rebuilt inside the active run; CLI session JSONL adoption of the
shared `live_compaction` entry is a later step.

The spine only considers complete assistant tool-call rounds. It requires every
tool call to have exactly one matching result, preserves the newest three
completed rounds, never crosses a user boundary, and skips an entire patch if
any raw backup or SHA256 verification fails. Failed tool results keep their
complete diagnostic surface instead of becoming pointer-only. Empty official
summaries are rejected so the original session remains available. It does not
call a model, change the official compaction threshold, or count toward session
relay compactions.

Useful overrides are available through `LYNN_LIVE_COMPACTION_*` variables for
the minimum context, preserved rounds, pointer threshold, chunk bounds, and
large-context stop line. Keep the default values unless a measured workload
justifies a change.
