# MIGRATION.md — Bringing the harness up on a new machine

This file is the bring-up runbook for moving the Benchburner harness
from one machine to another. Read after `CLAUDE.md`, `SPEC.md`,
`STATUS.md`, `VALIDATION.md`. Optimized for a Claude Code agent on
the destination machine: every step is concrete and verifiable.

## Why migrate

The harness has been validated end-to-end on a laptop (`orchestrator/
smoke-test` branch through phase PCS1 N=5+ and PDS6 N=5). Next
milestone is **PDS7 — 24h stability** (`VALIDATION.md` Phase D),
which needs the host machine to:

- stay on continuously for 25+ hours (laptop sleep / movement
  breaks the run),
- maintain a stable network connection (OpenRouter is hit every
  60s for the orchestrator's polling cycle),
- not be needed for other interactive work for the duration.

A stationary desktop fits that profile.

## Target-machine assumptions

This runbook was written for a machine with:

- **OS**: Linux or macOS (Windows works but adapt paths).
- **GPU** (optional, only for local-orchestrator runs):
  RTX 3080 10GB or similar. *Note: `gpt-oss:20b` is 13.8GB and
  will partial-offload to CPU on 10GB cards — works but slower.*
  PDS7 is configured to use **hosted gpt-5.4** to avoid the GPU
  dependency entirely. Local Ollama is only needed if you want
  to reproduce gpt-oss:20b results.
- **Node.js** 22 LTS (24+ also works; 22 is what the harness was
  built against).
- **Google Chrome** or Chromium installed.
- **Internet access** (OpenRouter calls every 60s).

## Bring-up steps

### 1. Clone the repo

```bash
git clone git@github.com:schmug/benchburner.git
cd benchburner
git checkout orchestrator/smoke-test
```

### 2. Build the pinned Bitburner fork

The Bitburner submodule lives at `bitburner/src` pinned to commit
`a4b0f22a2e5bcf19826c0bb671373c755fc162ad`. The fork patch in
`bitburner/patches/0001-rfa-harness-port.patch` enables the harness
RFA hook and is **applied at setup, not committed** to the
submodule (so the submodule stays clean against upstream).

```bash
git submodule update --init --recursive
cd bitburner/src
git apply ../patches/0001-rfa-harness-port.patch
npm install --ignore-scripts   # bypasses upstream's Node>=24 preinstall check
npx webpack --mode production
cd ../..
```

Verify: `bitburner/src/dist/` exists and contains `main.bundle.js`.

### 3. Install harness deps

```bash
PUPPETEER_SKIP_DOWNLOAD=true npm install
```

`PUPPETEER_SKIP_DOWNLOAD` skips the bundled Chromium download (we
use system Chrome via `PUPPETEER_EXECUTABLE_PATH` instead — both
faster install and works behind firewalls that block Puppeteer's
CDN).

### 4. Set up `.env` (gitignored, must be copied manually)

The `.env` file holds `OPENROUTER_API_KEY` and is **not** in git
(`.gitignore` excludes it). On the source machine:

```bash
scp .env user@destination:/path/to/benchburner/.env
```

Or recreate by hand:

```bash
cat > .env <<EOF
OPENROUTER_API_KEY=sk-or-v1-...
EOF
chmod 600 .env
```

Verify the key is good before launching anything expensive:

```bash
node tools/openrouter-usage.mjs
# Expected output:
#   credits:  used $X / purchased $Y  (remaining $Z)
#   key:      label="..."  usage=$X  limit=$Y  remaining=$Z
```

### 5. Find Chrome's binary path

```bash
# Linux:
which google-chrome || which chromium || which google-chrome-stable

# macOS:
ls "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Windows (PowerShell):
Get-ChildItem "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

Export it:

```bash
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome   # adjust per OS
```

### 6. Smoke test (3 minutes)

Confirms the whole pipeline works on the new host:

```bash
BENCHBURNER_CONFIG=config/run.pds6-gpt-5.4.yaml \
  BENCHBURNER_DURATION_SEC=180 \
  npx tsx harness/index.ts
```

Expect:
- `[harness] game=puppeteer` (not `mock`)
- `[snapshot] hour 0: money=1262`
- 3–5 `[orchestrator] cycle N done` lines
- `[harness] final_money=1262 status=completed`
- A new git commit on `orchestrator/smoke-test` for the run
  artifacts.

If any of those is missing, troubleshoot before launching the 24h
run. Common failure modes:

| symptom | fix |
|---|---|
| `chrome: command not found` | wrong `PUPPETEER_EXECUTABLE_PATH` |
| `Failed to connect to 127.0.0.1:11434` | only matters if running an Ollama-based config; not for `pds7-gpt-5.4` |
| `OpenRouter 401` / `OpenRouter 402` | bad key in `.env`, or account out of credit |
| `RFA: never received connection` | Chrome didn't load Bitburner — likely a sandboxing issue, try `--no-sandbox` |
| `webpack: command not found` | step 2 didn't complete — re-run from `cd bitburner/src` |

## Launching PDS7 (the 24h run)

Once the smoke test passes, kick off PDS7 inside `tmux` so it
survives terminal disconnects:

```bash
tmux new -s pds7

# inside tmux:
BENCHBURNER_CONFIG=config/run.pds7-gpt-5.4.yaml \
  npx tsx harness/index.ts 2>&1 | tee /tmp/pds7.log

# Ctrl-b d to detach.
# Reattach later: tmux attach -t pds7
```

Notes:

- Don't set `BENCHBURNER_DURATION_SEC` — `config/run.pds7-gpt-5.4.yaml`
  has `duration_hours: 24` baked in (=86,400s).
- The harness commits artifacts on shutdown (graceful or SIGINT).
  If the machine reboots mid-run, partial artifacts will be in
  `results/<run_id>/` but `summary.json` may not exist — that's
  the expected `failed` outcome per CLAUDE.md §"Failure Handling".

## What to watch over the run

The cycle log emits roughly every minute:

```
[orchestrator] cycle N done in <ms>ms — actions=<n>, pool=<n>, money=<dollars>
[snapshot] hour <H>: money=<dollars>            # once per hour
[tokens] orch=<n> sub=<n> total=<n>/<cap>       # every few cycles
```

Healthy run signals:

- `cycle_time_ms` stays under ~20s. If it climbs past 60s, the
  orchestrator is starting to lag the polling interval — `hang_
  timeout_seconds: 120` should kick in if a single call truly
  hangs.
- `pool` count stays in 1–5 range. Drift toward 0 means subagents
  are dying faster than they can be respawned (check
  `delegations` table for `error` status results).
- `money` ratchets monotonically up. Snap shots back to floor
  ($1262) on reboot would indicate IndexedDB wasn't fresh — but
  Puppeteer launches a fresh profile every run so this shouldn't
  happen.
- Token meter doesn't approach `BENCHBURNER_MAX_TOKENS` cap
  (default 400000). At 24h × ~150K tokens/hour for gpt-5.4-class
  loops, you'd burn ~3.6M tokens — far past the per-run cap. The
  cap is per-subagent-instruction, not per-run, so this isn't a
  ceiling on the whole run; just monitor that no single
  instruction explodes.

## After PDS7 completes

The run is committed automatically. Pull it back to the source
machine (or any machine running the aggregator):

```bash
git fetch origin orchestrator/smoke-test
git pull --ff-only
```

Update `VALIDATION.md` PDS7 with the run_id, duration, final_money,
and any stability issues observed. Recommended cells to fill:

- Did the run reach hour 24 cleanly, or did it `failed` partway?
- Any RFA disconnects (look in stderr for `RFA: reconnecting`)?
- Memory growth observed in Chrome (`top` / `htop` of the
  Chromium process)?
- Final money vs the 20-min PDS6 distribution. (Naive expectation:
  24h gpt-5.4 should *significantly* outscore the 20-min median
  of $1,838 — if it doesn't, the orchestrator's strategy isn't
  scaling with time, and that itself is a finding.)

## Future repo work (post-PDS7)

`STATUS.md` lists the next priorities; this section just
crosswalks them to the migration context:

1. Migrate `aggregator/build.ts` from mean ± std to median + IQR.
2. Persist orchestrator tokens to `runs` table (PDS2 follow-up).
3. Cross-roster sweep — does the family-rank-order from PDS6
   hold with non-Haiku subagents?
4. Reasoning-model probe — o3, Claude reasoning, DeepSeek-R1.
5. `results-published` branch + Cloudflare Pages wiring (per
   `CLAUDE.md` §"Multi-Branch Run Model" + SPEC §11).

None of these need a 10GB GPU, so the desktop is the right host
for all of them.
