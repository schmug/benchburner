#!/usr/bin/env bash
# VALIDATION.md Phase C ratchet battery.
# Runs each orchestrator config N_PER_MODEL times (default 2) at
# duration_hours: 1 override'd via BENCHBURNER_DURATION_SEC to
# 20 min. Sequential, not parallel — shared Puppeteer + Ollama.
#
# Streams run IDs + final_money to stdout and a persistent log so
# partial progress survives Ctrl-C. Set BENCHBURNER_MAX_TOKENS to
# cap per-run cost.

set -euo pipefail

N_PER_MODEL="${N_PER_MODEL:-2}"
DURATION="${DURATION:-1200}"
CAP="${CAP:-400000}"
LOG="${LOG:-/tmp/phase-c.log}"

mkdir -p "$(dirname "$LOG")"
: > "$LOG"
echo "[phase-c] $(date) starting battery: ${N_PER_MODEL}x per model, ${DURATION}s each, cap=${CAP} tokens" | tee -a "$LOG"

# Order: cheap first so if budget runs out mid-battery we have the
# bottom of the ratchet characterized.
CONFIGS=(
  "config/run.pcs1-gpt-oss20b.yaml"
  "config/run.pcs1-haiku.yaml"
  "config/run.pcs1-sonnet.yaml"
  "config/run.pcs1-opus.yaml"
)

export PUPPETEER_EXECUTABLE_PATH="${PUPPETEER_EXECUTABLE_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi

for cfg in "${CONFIGS[@]}"; do
  for i in $(seq 1 "$N_PER_MODEL"); do
    echo "=== $(date) cfg=$cfg run=$i/$N_PER_MODEL ===" | tee -a "$LOG"
    BENCHBURNER_CONFIG="$cfg" \
      BENCHBURNER_DURATION_SEC="$DURATION" \
      BENCHBURNER_MAX_TOKENS="$CAP" \
      npx tsx harness/index.ts 2>&1 | tail -20 | tee -a "$LOG" || \
      echo "[phase-c] run exited nonzero — continuing to next" | tee -a "$LOG"
  done
done

echo "[phase-c] $(date) battery complete" | tee -a "$LOG"
