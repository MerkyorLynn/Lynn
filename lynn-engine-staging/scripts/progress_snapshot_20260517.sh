#!/bin/bash
# Half-hour progress snapshots for overnight pipeline (Lynn 27B A3B optim)
# Writes appended snapshots to /home/merkyor/reports/overnight_optim_20260517/progress_timeline.md
# Author: Claude autonomous, started 2026-05-17 01:1X

RESULTSDIR=/home/merkyor/reports/overnight_optim_20260517
TIMELINE=$RESULTSDIR/progress_timeline.md
mkdir -p "$RESULTSDIR"

snapshot() {
  local label="$1"
  local now=$(date '+%H:%M:%S')
  {
    echo
    echo "## $label — $(date '+%Y-%m-%d %H:%M:%S')"
    echo
    # Pipeline state
    if pgrep -f "overnight_pipeline_20260517" > /dev/null 2>&1; then
      echo "- **Pipeline**: RUNNING"
    else
      echo "- **Pipeline**: stopped (completed or crashed)"
    fi
    # Active rsync (post-transfer should be 0)
    local n_rsync=$(pgrep -af "rsync.*lynn-27b-w4a8-nvfp4-v2" 2>/dev/null | grep -v grep | wc -l)
    echo "- **Active rsync for v2**: $n_rsync"
    # Production
    local prod=$(docker ps --filter "name=lynn-27b-nvfp4-server" --format "{{.Status}}" 2>/dev/null)
    echo "- **Production server**: $prod"
    # Memory
    local mem=$(free -h | awk 'NR==2 {print "used="$3" avail="$7}')
    echo "- **Spark mem**: $mem"
    echo
    # Latest master log (last 12 lines)
    echo "### Master log tail"
    echo '```'
    tail -12 "$RESULTSDIR/master.log" 2>/dev/null
    echo '```'
    echo
    # v2 status
    echo "### v2 artifact validation"
    if [ -L /home/merkyor/models/lynn-27b-a3b-w4a8-nvfp4-v2 ]; then
      echo "- A3B alias: ✅"
    else
      echo "- A3B alias: not yet created"
    fi
    if [ -f "$RESULTSDIR/sha256_result.txt" ]; then
      echo "- sha256: \`$(tail -1 "$RESULTSDIR/sha256_result.txt")\`"
    fi
    if [ -f "$RESULTSDIR/sp17_result.txt" ]; then
      local sp17=$(grep "SP-17.*gate" "$RESULTSDIR/sp17_result.txt" | tail -1)
      echo "- SP-17: \`$sp17\`"
    fi
    echo
    # TPS grid table
    echo "### TPS grid"
    echo "| Config | Mean TPS | Quality |"
    echo "|---|---|---|"
    for cfg in A_baseline B_native_fp4_lm_head C_linear_attn_native_fp4 D_packed_shared_expert E_packed_prep_native FINAL_A_baseline FINAL_B_native_fp4_lm_head FINAL_C_linear_attn_native_fp4 FINAL_D_packed_shared_expert FINAL_E_packed_prep_native; do
      local tps_file="$RESULTSDIR/${cfg}_tps.json"
      local q_file="$RESULTSDIR/${cfg}_quality.json"
      if [ -f "$tps_file" ]; then
        local tps=$(python3 -c "import json; print(round(json.load(open('$tps_file')).get('mean_tps', 0), 2))" 2>/dev/null || echo "?")
        local q="n/a"
        if [ -f "$q_file" ]; then
          q=$(python3 -c "import json; d=json.load(open('$q_file')); print('PASS' if d.get('all_pass') else 'FAIL')" 2>/dev/null || echo "n/a")
        fi
        echo "| $cfg | $tps | $q |"
      fi
    done
    # Final summary if exists
    if [ -f "$RESULTSDIR/final_summary.md" ]; then
      echo
      echo "### 🟢 final_summary.md present"
    fi
    echo
    echo "---"
  } >> "$TIMELINE"
}

# Header (only once at start)
if [ ! -s "$TIMELINE" ]; then
  cat > "$TIMELINE" << HEADER
# Lynn 27B A3B Spark Overnight Progress Timeline

Half-hour snapshots from $(date '+%H:%M') HKT until ~07:30 HKT.
Pipeline target: TPS >= 70 + v2 transfer + sha256 + A3B alias + SP-17 gate.

HEADER
fi

# Take initial T0 snapshot
snapshot "T0 (start)"

# Run for ~6.5 hours = 13 half-hour intervals after T0
for i in $(seq 1 13); do
  sleep 1800  # 30 minutes
  snapshot "T$i"
done

# Final snapshot
snapshot "T-FINAL"
