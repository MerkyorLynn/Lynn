#!/bin/bash
# Rename electron-builder DMG artifacts: arm64→Apple-Silicon, x64→Intel
# Usage: scripts/rename-dmg.sh [dist-dir]
set -euo pipefail

DIST_DIR="${1:-dist}"

cd "$(dirname "$0")/.."

for dmg in "$DIST_DIR"/*.dmg; do
  [ -f "$dmg" ] || continue
  dir="$(dirname "$dmg")"
  base="$(basename "$dmg")"

  if [[ "$base" == *"arm64"* ]]; then
    new="${base//arm64/Apple-Silicon}"
    echo "mv $base → $new"
    mv "$dmg" "$dir/$new"
  elif [[ "$base" == *"x64"* && "$base" != *"Apple-Silicon"* ]]; then
    new="${base//x64/Intel}"
    echo "mv $base → $new"
    mv "$dmg" "$dir/$new"
  fi
done

# Also rename blockmap files
for bm in "$DIST_DIR"/*.dmg.blockmap; do
  [ -f "$bm" ] || continue
  dir="$(dirname "$bm")"
  base="$(basename "$bm")"

  if [[ "$base" == *"arm64"* ]]; then
    new="${base//arm64/Apple-Silicon}"
    echo "mv $base → $new"
    mv "$bm" "$dir/$new"
  elif [[ "$base" == *"x64"* && "$base" != *"Apple-Silicon"* ]]; then
    new="${base//x64/Intel}"
    echo "mv $base → $new"
    mv "$bm" "$dir/$new"
  fi
done

echo "Done."
