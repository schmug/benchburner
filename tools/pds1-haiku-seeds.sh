#!/usr/bin/env bash
# VALIDATION.md PDS1: run Haiku-orchestrator + Haiku-subagent at
# three different seeds to test whether Haiku's Phase C win is
# reproducible vs. seed-specific artifact.

set -euo pipefail

LOG="${LOG:-/tmp/pds1-haiku-seeds.log}"
: > "$LOG"
echo "[pds1] $(date) starting seed-variance battery" | tee -a "$LOG"

export PUPPETEER_EXECUTABLE_PATH="${PUPPETEER_EXECUTABLE_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi

for SEED in 8675309 42 1337; do
  echo "=== $(date) seed=$SEED ===" | tee -a "$LOG"
  BENCHBURNER_CONFIG="config/run.pds1-haiku-$SEED.yaml" \
    BENCHBURNER_DURATION_SEC=1200 \
    BENCHBURNER_MAX_TOKENS=400000 \
    npx tsx harness/index.ts 2>&1 | tail -20 | tee -a "$LOG" || \
    echo "[pds1] run exited nonzero — continuing" | tee -a "$LOG"
done

echo "[pds1] $(date) complete" | tee -a "$LOG"
