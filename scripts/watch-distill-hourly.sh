#!/usr/bin/env bash
set -euo pipefail
ROOT=${ROOT:-/Users/lynn/Downloads/Lynn}
OUT="$ROOT/output/distill-watch"
mkdir -p "$OUT"
PID_FILE="$OUT/hourly.pid"
LOG_FILE="$OUT/hourly.log"
if [ "${1:-}" = "stop" ]; then
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID"
      echo "stopped $PID"
    fi
    rm -f "$PID_FILE"
  else
    echo "no pid file"
  fi
  exit 0
fi
if [ "${1:-}" = "status" ]; then
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "running pid $(cat "$PID_FILE")"
  else
    echo "not running"
  fi
  exit 0
fi
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "already running pid $(cat "$PID_FILE")"
  exit 0
fi
(
  set +e
  while true; do
    echo "[$(date)] watch tick" >> "$LOG_FILE"
    "$ROOT/scripts/watch-distill-status.sh" >> "$LOG_FILE" 2>&1
    sleep 3600
  done
) &
PID=$!
echo "$PID" > "$PID_FILE"
echo "started $PID"
