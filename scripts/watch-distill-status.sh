#!/usr/bin/env bash
set -euo pipefail
ROOT=${ROOT:-/Users/lynn/Downloads/Lynn}
OUT="$ROOT/output/distill-watch"
mkdir -p "$OUT"
TS=$(date +%Y%m%d-%H%M%S)
LOG="$OUT/watch-$TS.md"
REMOTE=${REMOTE:-a100}
{
  echo "# Lynn Distill Watch $TS"
  echo
  echo "Local: $(date)"
  echo
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE" 'set -euo pipefail
    echo "Remote: $(hostname) $(date)"
    echo
    echo "## Reports"
    mkdir -p /mnt/data3/reports
    ls -lt /mnt/data3/reports 2>/dev/null | head -20 || true
    echo
    echo "## Decision JSON snapshots"
    for f in /mnt/data3/reports/pro_rate_decision_*.json /mnt/data3/reports/quality_check_v3.json /mnt/data3/reports/p0_base_choice.json /mnt/data3/reports/smoke_gate_v3.json; do
      [ -f "$f" ] || continue
      echo "### $f"
      python3 -m json.tool "$f" 2>/dev/null | sed -n "1,120p" || sed -n "1,120p" "$f"
      echo
    done
    echo "## API collection"
    for f in /mnt/data3/distill/_ckpt_flash.jsonl /mnt/data3/distill/_ckpt_pro.jsonl; do
      [ -f "$f" ] && printf "%s %s lines\n" "$f" "$(wc -l < "$f")" || true
    done
    echo
    echo "## API logs tail"
    for f in /mnt/data3/distill/run_flash.log /mnt/data3/distill/run_pro.log; do
      [ -f "$f" ] || continue
      echo "### $f"
      tail -20 "$f"
      echo
    done
    echo "## P0 ORPO"
    [ -f /mnt/data3/saves/stage6.log ] && { grep -i "loss" /mnt/data3/saves/stage6.log | tail -8 || true; tail -5 /mnt/data3/saves/stage6.log || true; }
    echo
    echo "## GPU"
    nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader || true
    echo
    echo "## Processes"
    ps -ef | grep -E "distill_collect|torchrun|llamafactory-cli" | grep -v grep | head -20 || true
  '
} > "$LOG"
ln -sf "$LOG" "$OUT/latest.md"
echo "$LOG"
