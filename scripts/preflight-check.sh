#!/bin/bash
# Pre-flight checks before release build
# Usage: scripts/preflight-check.sh
set -euo pipefail

cd "$(dirname "$0")/.."
FAIL=0

echo "=== Pre-flight checks ==="

# 1. git working tree clean
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  git working tree has uncommitted changes:"
  git status --short
  FAIL=1
else
  echo "✓ git working tree clean"
fi

# 2. worktree vs main sync (if in worktree)
WT_ROOT="$(git rev-parse --show-toplevel)"
if [[ "$WT_ROOT" == *".claude/worktrees"* ]]; then
  MAIN="$HOME/Downloads/Lynn"
  echo "--- worktree sync check ---"
  echo "worktree: $WT_ROOT"
  echo "main:     $MAIN"
  if [ -d "$MAIN" ]; then
    DIFFS=$(diff -rq "$WT_ROOT/server" "$MAIN/server" 2>/dev/null | grep -v node_modules || true)
    if [ -n "$DIFFS" ]; then
      echo "⚠️  worktree differs from main repo:"
      echo "$DIFFS"
      FAIL=1
    else
      echo "✓ worktree in sync with main"
    fi
  fi
fi

# 3. APPLE_NOTARY_PROFILE set for macOS build
if [ -z "${APPLE_NOTARY_PROFILE:-}" ]; then
  echo "⚠️  APPLE_NOTARY_PROFILE not set (notarization will be skipped)"
else
  echo "✓ APPLE_NOTARY_PROFILE=$APPLE_NOTARY_PROFILE"
fi

# 4. Check mirror URLs in generate-update-manifest.mjs
if grep -q 'github.com' scripts/generate-update-manifest.mjs 2>/dev/null; then
  echo "⚠️  generate-update-manifest.mjs may contain github.com URLs (should be Tencent mirror)"
  FAIL=1
else
  echo "✓ generate-update-manifest.mjs uses Tencent mirror"
fi

# 5. Verify dist-server exists
if [ ! -d "dist-server" ]; then
  echo "⚠️  dist-server/ missing — run npm run build:server for each platform"
else
  echo "✓ dist-server/ exists"
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== All pre-flight checks passed ✅ ==="
else
  echo "=== Pre-flight checks have warnings ⚠️  ==="
fi
exit $FAIL
