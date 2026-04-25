#!/usr/bin/env bash
# VALIDATION.md PDS6: external-validity sanity. Brings two new
# orchestrators to N=5 against the canonical PCS1 conditions
# (subagent=Haiku, seed=8675309, 20-min duration). Tests whether:
#   - "local wins by median" generalizes beyond gpt-oss:20b
#     (qwen2.5-coder:7b is the only other coder-tuned local
#     model on this box that fits memory + isn't a reasoning
#     model that exhausts its budget thinking)
#   - "hosted underperforms" is Anthropic-specific or universal
#     (gpt-5.4 is OpenRouter's mid-tier OpenAI flagship, $2.5/$15
#     per M tokens — comparable price band to Sonnet)
#
# Cheap-first: free local battery first; if budget pressure
# emerges mid-run, the gpt-5.4 half can be killed without losing
# the qwen-coder data.

set -euo pipefail

DURATION="${DURATION:-1200}"
CAP="${CAP:-400000}"
LOG="${LOG:-/tmp/pds6.log}"

mkdir -p "$(dirname "$LOG")"
: > "$LOG"
echo "[pds6] $(date) starting battery: ${DURATION}s/run, cap=${CAP} tokens" | tee -a "$LOG"

RUNS=(
  "config/run.pds6-qwen-coder.yaml:5"
  "config/run.pds6-gpt-5.4.yaml:5"
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
      echo "[pds6] run exited nonzero — continuing to next" | tee -a "$LOG"
  done
done

echo "[pds6] $(date) battery complete" | tee -a "$LOG"
