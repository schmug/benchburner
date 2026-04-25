#!/usr/bin/env bash
# Phase C N=5 fill battery. Existing PCS1 data already has Haiku N=5
# (PDS1 variance battery) and gpt-oss:20b N=4. This battery tops up:
#   gpt-oss:20b  +1 run  -> N=5     (~$0)
#   Sonnet       +4 runs -> N=5     (~$4)
#   Opus (v2)    +3 runs -> N=5     (~$10-12)
# All against subagent_roster=[claude-haiku-4.5], seed=8675309,
# duration=20 min. Cheap-first so partial budget exhaustion still
# yields the bottom of the ratchet.
#
# BENCHBURNER_MAX_TOKENS=400000 hard caps any single run; per PDS2 the
# typical Opus run is 132-164K, so this is ~3x headroom but blocks a
# runaway loop from torching the wallet.

set -euo pipefail

DURATION="${DURATION:-1200}"
CAP="${CAP:-400000}"
LOG="${LOG:-/tmp/phase-c-fill.log}"

mkdir -p "$(dirname "$LOG")"
: > "$LOG"
echo "[fill] $(date) starting fill battery: ${DURATION}s/run, cap=${CAP} tokens" | tee -a "$LOG"

# (config_path, count) — cheap-first.
# After session-1 partial: sonnet already at N=4, need only 1 more.
RUNS=(
  "config/run.pcs1-gpt-oss20b.yaml:1"
  "config/run.pcs1-sonnet.yaml:1"
  "config/run.pcs1-opus-v2.yaml:3"
)

export PUPPETEER_EXECUTABLE_PATH="${PUPPETEER_EXECUTABLE_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi

for entry in "${RUNS[@]}"; do
  cfg="${entry%%:*}"
  n="${entry##*:}"
  for i in $(seq 1 "$n"); do
    echo "=== $(date) cfg=$cfg run=$i/$n ===" | tee -a "$LOG"
    BENCHBURNER_CONFIG="$cfg" \
      BENCHBURNER_DURATION_SEC="$DURATION" \
      BENCHBURNER_MAX_TOKENS="$CAP" \
      npx tsx harness/index.ts 2>&1 | tail -25 | tee -a "$LOG" || \
      echo "[fill] run exited nonzero — continuing to next" | tee -a "$LOG"
  done
done

echo "[fill] $(date) fill battery complete" | tee -a "$LOG"
