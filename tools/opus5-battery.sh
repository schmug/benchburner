#!/usr/bin/env bash
# Brings claude-opus-5 to N=5 against the canonical PCS1 conditions
# (subagent=Haiku, seed=8675309, 20-min duration), so it drops
# straight into the VALIDATION.md PCS1/PDS6 median+IQR table.
#
# Why: every Anthropic data point in that table is 4.7/4.6/4.5. The
# "Anthropic family sits at the floor" finding is the most publishable
# thing the benchmark has, and it currently says nothing about the
# current generation. N=5 is the minimum for a ranking per
# VALIDATION.md ("Rankings require N>=3 minimum; N>=5 preferred").
#
# Cost: PDS6 ran 10 orchestrator-runs for $2.84 with prompt caching.
# Opus is a pricier band than gpt-5.4, so budget ~$5-10 for N=5 and
# watch the first run before letting the rest go.
#
# FIRST RUN: check the log for
#   "empty content with finish_reason=length"
# If it appears, Opus 5's reasoning trace is eating max_completion_
# tokens (the kimi-k2.6 failure mode) and the whole battery will be
# floor scores that mean nothing. Bump max_completion_tokens in
# config/models.yaml and restart rather than banking the numbers.

set -euo pipefail

CAP="${CAP:-400000}"
N="${N:-5}"
LOG="${LOG:-/tmp/opus5.log}"

mkdir -p "$(dirname "$LOG")"
: > "$LOG"
echo "[opus5] $(date) starting battery: ${N} runs, cap=${CAP} tokens" | tee -a "$LOG"

CFG="config/run.pcs1-opus-5.yaml"

export PUPPETEER_EXECUTABLE_PATH="${PUPPETEER_EXECUTABLE_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi

for i in $(seq 1 "$N"); do
  echo "=== $(date) cfg=$CFG run=$i/$N ===" | tee -a "$LOG"
  # No BENCHBURNER_DURATION_SEC: unlike the older batteries, the 20m
  # duration lives in the config file, so what ran is recoverable from
  # the committed artifact rather than from this script.
  BENCHBURNER_CONFIG="$CFG" \
    BENCHBURNER_MAX_TOKENS="$CAP" \
    npx tsx harness/index.ts 2>&1 | tail -25 | tee -a "$LOG" || \
    echo "[opus5] run exited nonzero — continuing to next" | tee -a "$LOG"
done

echo "[opus5] $(date) battery complete" | tee -a "$LOG"
