#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/Users/lynn/Downloads/Lynn}
OUT="$ROOT/output/night-watch"
DISTILL_WATCH="$ROOT/scripts/watch-distill-status.sh"
PID_FILE="$OUT/night-watch.pid"
CAFFEINE_PID_FILE="$OUT/caffeinate.pid"
LOOP_LOG="$OUT/night-watch.log"
mkdir -p "$OUT"

run_once() {
  local ts log alert tmp_alert
  ts=$(date +%Y%m%d-%H%M%S)
  log="$OUT/watch-$ts.md"
  alert="$OUT/ALERT-$ts.md"
  tmp_alert=$(mktemp)

  {
    echo "# Lynn Night Watch $ts"
    echo
    echo "Local: $(date)"
    echo

    echo "## A100 Distillation"
    if [ -x "$DISTILL_WATCH" ]; then
      if "$DISTILL_WATCH"; then
        echo
        echo "Distill watch latest:"
        readlink "$ROOT/output/distill-watch/latest.md" 2>/dev/null || true
      else
        echo "A100 distill watch failed."
        echo "- A100 distill watch failed at $ts" >> "$tmp_alert"
      fi
    else
      echo "Missing $DISTILL_WATCH"
      echo "- Missing distill watch script at $ts" >> "$tmp_alert"
    fi
    echo

    echo "## R6000 Lynn Engine"
    if ssh -o BatchMode=yes -o ConnectTimeout=15 r6000 'export PATH=/root/miniconda3/bin:/usr/local/cuda-12.8/bin:$PATH
      set +e
      echo "Remote: $(hostname) $(date)"
      echo
      echo "### Disk"
      df -h / /root/autodl-tmp 2>/dev/null || true
      echo
      echo "### GPU"
      nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null || true
      echo
      echo "### tmux"
      tmux ls 2>/dev/null || true
      echo
      echo "### p1p2 tail"
      tmux capture-pane -pt p1p2 -S -120 2>/dev/null || true
      echo
      echo "### lynn-engine git status"
      cd /root/autodl-tmp/lynn-engine 2>/dev/null && git status --short || true
      echo
      echo "### Phase 3.2 daily JSON"
      python3 -c "import json, pathlib; p=pathlib.Path(\"/root/autodl-tmp/results/lynn_engine_daily_2026-05-10.json\"); print(json.dumps(json.load(open(p)), ensure_ascii=False, indent=2) if p.exists() else \"MISSING\")" 2>/dev/null || true
      echo
      echo "### Phase 3.2 multi-prompt gate decision"
      python3 - <<'"'"'PY'"'"'
import json
from pathlib import Path
p = Path("/root/autodl-tmp/results/lynn_engine_daily_2026-05-10.json")
if not p.exists():
    print("MULTI_PROMPT_GATE_MISSING")
else:
    data = json.load(open(p))
    gate = data.get("multi_prompt_gate") or {}
    rates = gate.get("exact_match_rate") or {}
    mismatches = gate.get("mismatches_count") or {}
    bad = {k: v for k, v in rates.items() if float(v) < 1.0}
    print(json.dumps({"exact_match_rate": rates, "mismatches_count": mismatches}, ensure_ascii=False))
    if bad:
        print("MULTI_PROMPT_GATE_FAIL " + json.dumps(bad, ensure_ascii=False))
    else:
        print("MULTI_PROMPT_GATE_PASS")
PY
      echo
      echo "### Lynn engine default implementation"
      cd /root/autodl-tmp/lynn-engine 2>/dev/null && grep -n "LYNN_MOE_IMPL.*os.environ.get\\|os.environ.get('LYNN_MOE_IMPL'\\|os.environ.get(\\\"LYNN_MOE_IMPL\\\"" engine/full_forward.py 2>/dev/null || true
      echo
      echo "### Phase 3.2 raw bench JSON"
      cat /root/autodl-tmp/results/phase32_bench_2026-05-10.json 2>/dev/null || true
    '; then
      :
    else
      echo "R6000 SSH/watch failed."
      echo "- R6000 SSH/watch failed at $ts" >> "$tmp_alert"
    fi
    echo

    echo "## Local Watch Processes"
    pgrep -fl "watch-nightly|watch-distill|caffeinate" || true
  } > "$log" 2>&1

  ln -sf "$log" "$OUT/latest.md"

  if grep -q '"verdict": "FAIL\|"verdict": "FAIL_' "$log"; then
    echo "- R6000 engine gate reports FAIL at $ts" >> "$tmp_alert"
  fi
  if grep -q '^MISSING$' "$log"; then
    echo "- Some expected report file is missing at $ts" >> "$tmp_alert"
  fi
  if grep -Eqi 'MULTI_PROMPT_GATE_FAIL|exact.*false|mismatch|traceback|attributeerror|keyerror|runtimeerror|oom' "$log"; then
    echo "- R6000 engine/watch log contains failure keywords at $ts" >> "$tmp_alert"
  fi

  if [ -s "$tmp_alert" ]; then
    {
      echo "# Lynn Night Watch Alert $ts"
      echo
      cat "$tmp_alert"
      echo
      echo "See: $log"
    } > "$alert"
    ln -sf "$alert" "$OUT/latest-alert.md"
  fi
  rm -f "$tmp_alert"
  echo "$log"
}

start_loop() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "already running pid $(cat "$PID_FILE")"
    return 0
  fi

  nohup bash -c '
    set +e
    script="$1"
    loop_log="$2"
    interval="$3"
    while true; do
      echo "[$(date)] night watch tick" >> "$loop_log"
      "$script" run-once >> "$loop_log" 2>&1
      sleep "$interval"
    done
  ' _ "$0" "$LOOP_LOG" "${WATCH_INTERVAL_SECONDS:-3600}" >/dev/null 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  if command -v caffeinate >/dev/null 2>&1; then
    caffeinate -dimsu -w "$pid" &
    echo "$!" > "$CAFFEINE_PID_FILE"
  fi

  echo "started $pid"
}

stop_loop() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      echo "stopped $pid"
    fi
    rm -f "$PID_FILE"
  fi
  if [ -f "$CAFFEINE_PID_FILE" ]; then
    local cpid
    cpid=$(cat "$CAFFEINE_PID_FILE")
    if kill -0 "$cpid" 2>/dev/null; then
      kill "$cpid"
      echo "stopped caffeinate $cpid"
    fi
    rm -f "$CAFFEINE_PID_FILE"
  fi
}

case "${1:-start}" in
  run-once) run_once ;;
  start) start_loop ;;
  stop) stop_loop ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running pid $(cat "$PID_FILE")"
      [ -f "$CAFFEINE_PID_FILE" ] && echo "caffeinate pid $(cat "$CAFFEINE_PID_FILE")"
      readlink "$OUT/latest.md" 2>/dev/null || true
    else
      echo "not running"
    fi
    ;;
  *)
    echo "usage: $0 [start|stop|status|run-once]" >&2
    exit 2
    ;;
esac
