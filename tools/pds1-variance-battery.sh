#!/usr/bin/env bash
# Characterize within-seed score distribution to calibrate how many
# samples are needed for publishable orchestrator rankings.
#
# Runs Haiku × 3 more (for N=5 at seed 8675309 with prior PCS1 + PDS1
# data), then gpt-oss:20b × 3 (free, tests whether the massive
# variance is provider-side or universal to LLM orchestrators).

set -euo pipefail

LOG="${LOG:-/tmp/pds1-variance.log}"
: > "$LOG"
echo "[pds1-var] $(date) starting variance battery" | tee -a "$LOG"

export PUPPETEER_EXECUTABLE_PATH="${PUPPETEER_EXECUTABLE_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi

# Haiku same-seed repeats (paid)
for i in 1 2 3; do
  echo "=== $(date) haiku seed=8675309 repeat=$i ===" | tee -a "$LOG"
  BENCHBURNER_CONFIG="config/run.pds1-haiku-8675309.yaml" \
    BENCHBURNER_DURATION_SEC=1200 \
    BENCHBURNER_MAX_TOKENS=400000 \
    npx tsx harness/index.ts 2>&1 | tail -15 | tee -a "$LOG" || \
    echo "[pds1-var] haiku run $i exited nonzero" | tee -a "$LOG"
done

# gpt-oss:20b same-seed repeats (free, local)
for i in 1 2 3; do
  echo "=== $(date) gpt-oss:20b seed=8675309 repeat=$i ===" | tee -a "$LOG"
  BENCHBURNER_CONFIG="config/run.pcs1-gpt-oss20b.yaml" \
    BENCHBURNER_DURATION_SEC=1200 \
    BENCHBURNER_MAX_TOKENS=400000 \
    npx tsx harness/index.ts 2>&1 | tail -15 | tee -a "$LOG" || \
    echo "[pds1-var] gpt-oss run $i exited nonzero" | tee -a "$LOG"
done

echo "[pds1-var] $(date) complete" | tee -a "$LOG"
