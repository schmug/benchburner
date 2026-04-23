# STATUS.md — Milestone 1 handoff

> This file is the handoff summary at the end of the first build
> session. Read after `CLAUDE.md`, `HANDOFF.md`, and `SPEC.md`. It
> records what's implemented, what decisions were made from the
> "Key Decisions" list, what's validated vs. stubbed, how to run a
> smoke test, and what the next milestone should be.

## Update 2026-04-23 — benchmark realignment + agentic subagents

After the first M1 pass, an audit surfaced drift risk: the
implementation was artificially hardening the orchestrator's job
(stripping code from history, treating Netscript API names as leaks)
and starving subagents of normal dev-loop feedback. Four changes
landed to realign the benchmark with "measure orchestration of
coding agents":

1. **Leak policy narrowed** to the four game-naming tokens
   (`bitburner`, `bitnode`, `hacknet`, `augment`) + `seed`. Removed
   `netscript` — SPEC §3.3 explicitly permits it in code. Subagent
   code is again visible to the orchestrator, with only forbidden
   *name* tokens scrubbed from within comments/string literals.
2. **Execution results enriched** with stdout / stderr / exit_reason /
   script_stats. The in-game dispatcher reads `ns.getRunningScript`
   and tails the log. Orchestrator and subagents now see what a
   tech lead and their team would normally see.
3. **Agentic subagents (SPEC §2.5 addendum).** SubagentWorker now
   runs a bounded write-run-observe loop (default 3 iterations). Each
   turn the subagent emits `{decision, code, notes}`; on `RUN` the
   harness executes against the GameController and feeds the
   ExecutionResult back; on `DONE` the code commits. Orchestrator
   sees only the final outcome + a compact per-iteration summary.
4. **Aggregator now reports mean ± std over multiple runs per
   orchestrator.** Ollama is not bit-deterministic; a single run is
   a noisy score. Sample-size / completed-run count visible on the
   leaderboard.

Validated via run `46dba9bc-...` (12 minutes, 12 cycles, status
completed, leak-clean): four subagent delegations, one reached
`DONE` after 3 iterations — and the iteration_summaries show the
subagent did see three distinct `ns.run returned 0` feedback cycles
and committed its best effort anyway. That's exactly the signal the
benchmark exists to measure (how well does each orchestrator route
around a failing subagent).

One dispatcher bug fixed as a side-effect: `money_gained` was
reporting the full `current_money` in the `failed_to_start` branch
because `task.startMoney` wasn't persisted before the early return.
Now set unconditionally when the task transitions from `pending`.

## TL;DR

The **first-milestone acceptance criteria** (SPEC §13) are met
end-to-end against a real, headless Bitburner instance. Canonical pass
is run `fd4d37f3-63f3-4c20-9d59-6a4f583903f5` on the
`orchestrator/smoke-test` branch (commit `0793528`):

- populated SQLite DB — `runs=1, delegations=1, scripts=1, snapshots=1`;
- all four JSON exports present and valid (`summary.json`,
  `delegations.json`, `scripts.json`, `snapshots.json`);
- `summary.json.final_money = 1262` — Bitburner's actual player money
  pulled live via RFA from the running game;
- zero orchestrator-prompt leakage
  (grep `bitburner|bitnode|seed|netscript|augment|hacknet|8675309` →
  empty);
- git commit on `orchestrator/smoke-test`.

A 1-hour run is also useful and will be re-attempted after the
leak-policy hardening (see "Known issues"); an initial 1h attempt
failed at cycle 5 because the orchestrator's own `delegation_history`
echoed a subagent-generated code string containing "NETSCRIPT",
tripping the leak detector. Fixed in commit `9ce2f5c` — raw code is
no longer echoed to the orchestrator; it's kept in storage only.

Everything in the harness is plumbed end-to-end. The pipeline is the
deliverable; growing Bitburner money is the orchestrator's /
subagent's job, and that's what future runs benchmark.

## What's implemented

### Harness (`harness/`)

| module                           | status    | notes |
|----------------------------------|-----------|-------|
| `types.ts`                       | ✅ full   | SPEC §2/§3/§4/§6/§8/§10 shapes in one place |
| `bus/` (in-memory pub/sub)       | ✅ full   | typed channels: instructions, results, executions, snapshots |
| `inference/` (Ollama + HTTP)     | ✅ full   | `InferenceRegistry` keyed off `config/models.yaml`; lazy api-key resolution |
| `storage/` (SQLite + JSON)       | ✅ full   | better-sqlite3 WAL mode; prepared statements; `exportRunArtifacts()` dumps the four SPEC §4.5 JSONs |
| `config/` (YAML loader)          | ✅ full   | HANDOFF defaults applied automatically; `run_id: auto` → UUID at load |
| `game/mock.ts`                   | ✅ full   | dev-only deterministic fake; satisfies `GameController` |
| `game/rfa.ts`                    | ✅ full   | WebSocket JSON-RPC server — Bitburner is the *client*, we're the server |
| `game/seed-inject.js`            | ✅ full   | xmur3 + SFC32 `Math.random` override via `evaluateOnNewDocument`; plants `__BENCHBURNER_RFA_PORT` |
| `game/dispatcher.js` (in-game)   | ✅ full   | pushed at boot, runs forever, polls `/__queue.json`, runs tasks, writes `/__results/<id>.json`; also dumps `/__state.json` every tick |
| `game/puppeteer.ts`              | ✅ full   | Chromium via system Chrome + local static server for `bitburner/src/` + RFA wire-up + terminal-automated dispatcher launch |
| `subagent/pool.ts` + `worker.ts` | ✅ full   | semaphore-bounded async worker, AbortController timeout, code-fence stripping |
| `orchestrator/prompt.ts`         | ✅ full   | SPEC §3.3 system prompt + leak detector + field-rename scrubber + history-token scrubber |
| `orchestrator/history.ts`        | ✅ full   | last-N verbatim + rolling summary; summary generation is wired into the loop |
| `orchestrator/loop.ts`           | ✅ full   | polling timer, JSON parser (bare / fenced / first-balanced-object), action dispatch, storage bridging, hang detection |
| `snapshot/timer.ts`              | ✅ full   | hour-0 immediate, setTimeout-chain keyed to start (no drift) |
| `index.ts`                       | ✅ full   | full boot + shutdown + JSON export + git commit |

### Bitburner integration

- Pinned to upstream `a4b0f22a2e5bcf19826c0bb671373c755fc162ad` (v2.8.1).
- Single patch at `bitburner/patches/0001-rfa-harness-port.patch`:
  - Reads `globalThis.__BENCHBURNER_RFA_PORT` at boot; if set,
    enables RFA auto-connect to that port with a 2-second
    reconnection delay.
  - Skips `iTutorialStart()` when the port is set, so the terminal is
    usable immediately (otherwise the first-boot tutorial intercepts
    keystrokes).
- Build on Node 22 with `--ignore-scripts` (bypasses upstream's Node≥24
  preinstall check; the actual webpack build runs clean).

### Aggregator (`aggregator/`)

- `build.ts` reads `results/*/summary.json`, sorts (completed ahead of
  failed; then by `final_money desc`), anonymizes entries where
  `attribution: "anonymous"`, writes `pages/leaderboard.json` +
  `pages/index.html`. Shape matches SPEC §8 so the frontend design
  task (Claude Design) can consume it unchanged.

### CI (`.github/workflows/`)

- `run.yml` — manual-dispatch job on a `[self-hosted, benchburner]`
  runner. Applies patches, builds Bitburner, installs harness deps
  with `PUPPETEER_SKIP_DOWNLOAD=true`, runs the harness, pushes
  artifacts.
- `aggregate.yml` — daily cron rebuilds the leaderboard. Multi-branch
  fan-out is a TODO; today it aggregates whatever is checked out.

## Decisions (from HANDOFF §"Key Decisions" and SPEC §12)

### RNG seed injection

**Chosen: Puppeteer `evaluateOnNewDocument` override of `Math.random`
with a seeded SFC32 PRNG.** Same algorithm family Bitburner itself
ships in `src/Casino/RNG.ts`. Seeded with xmur3-hashed string of
`config.game.seed`. `Object.defineProperty` with
`configurable: false, writable: false` so later code can't rebind
Math.random. Zero fork changes for the RNG itself.

**Why not a fork patch:** the 284 `Math.random` callsites across
Bitburner would have to be rerouted. Overriding the global is one
line of injected JS and achieves the same determinism.

### Subagent concurrency

**Chosen: async tasks in the main Node process, semaphore-bounded to
`max_concurrent` (default 5).** Inference is I/O-bound against Ollama
or HTTP endpoints, so worker threads buy nothing. The semaphore is a
promise-queue pattern inside `subagent/worker.ts`.

### Delegation history compression

**Chosen: last N cycles verbatim (default 10) + a rolling summary
generated by the orchestrator model itself.** The summary generation
piggybacks on normal cycle calls rather than adding a separate
inference path. Token pressure on long runs stays bounded.

### Game-to-harness communication

**Chosen: WebSocket RFA where Bitburner is the client.** Enabled via
the one fork patch (see above). File operations go through
`pushFile` / `getFile` / `deleteFile` / `getSaveFile`. Script
execution is done through an in-game dispatcher
(`harness/game/dispatcher.js`) the harness pushes at boot and kicks
off via Puppeteer-typed `run /__dispatcher.js` in the terminal.
State is exported two ways: (a) hourly `getSaveFile()` for a full
snapshot, (b) every-tick `/__state.json` written by the dispatcher
for the harness's `readState()` polling loop.

**Why not `getSaveFile()` only:** the full save is large and slow
to parse. The dispatcher's `/__state.json` has just the fields we
need, and it's the natural piggyback on an already-running script.

**Why not no dispatcher at all:** RFA has no "run script" verb. The
dispatcher closes that gap.

### Error budget

**Chosen: no auto-retry within a 24h window.** A subagent error
surfaces as `Result { status: "error" }` and the orchestrator decides
whether to reissue. A cycle-wide failure (no decision for
`hang_timeout_seconds`, default 600) fails the run and commits
partial artifacts — CLAUDE.md §"Failure Handling" rules.

## Open status — 1-hour run re-attempt

The first 1-hour attempt (`e1ece6c6-...`) terminated at cycle 5 due
to the code-echo leak described above. That run was committed with
`status: "failed"` per CLAUDE.md §"Failure Handling" so the artifact
record is honest about partial failure.

Re-attempting a 1-hour run post-fix is the next step; for M1 the
6-minute post-fix run `fd4d37f3-...` is sufficient validation that
the pipeline is stable across many cycles including graceful
handling of a malformed-JSON response from the orchestrator model.

## Known issues (deferred past M1)

1. **Subagent sometimes returns empty Netscript.** qwen3.5:4b (the
   only reasonable local model on this machine) runs its `<think>`
   mode under Ollama and sometimes leaves `response` empty or with no
   extractable code fence. The worker captures `code: ""` and logs a
   success result with zero-length code; the orchestrator loop then
   skips script submission. Run `fd4d37f3-...` did produce one
   non-empty script but the code hallucinated APIs that don't exist
   in Netscript (`this.runCommand(...)`), which is why `scripts=1`
   but Bitburner-side money growth stays at 0 — the dispatcher tried
   to run the file, it errored out inside the game, money unchanged.
   This is precisely the signal the benchmark will measure on real
   rosters; here it just means qwen3.5:4b is a poor subagent coder.
   Spec examples (`qwen2.5-coder:7b`, `llama-3-70b`) would produce
   valid Netscript; none are pulled in this sandbox.
2. **Background timer throttling in headless Chromium**. Mitigated
   for M1 with `--disable-background-timer-throttling` +
   `--disable-renderer-backgrounding`. Revalidate at 24h scale.
3. **Aggregator multi-branch fan-out** is TODO; today it only reads
   the checked-out branch's `results/`.
4. **Chromium binary.** In this environment Puppeteer can't download
   its bundled Chromium (egress blocked). We use the system Google
   Chrome via `PUPPETEER_EXECUTABLE_PATH`. CI runners will need
   `google-chrome-stable` pre-installed.
5. **Bitburner preinstall check** fails on Node <24 even though the
   actual build runs fine on Node 22. The CI workflow bypasses it
   with `--ignore-scripts`; upgrade to Node 24 when the self-hosted
   runner supports it.

## Smoke test recipe (reproduces the current validated pass)

```sh
# Prereqs
#   - Node 22+
#   - Ollama running: ollama serve
#   - ollama pull qwen3.5:4b        (or substitute any installed model
#                                     and update config/run.yaml +
#                                     config/models.yaml accordingly)
#   - Google Chrome installed at /Applications/Google Chrome.app

# One-time setup
git submodule update --init --recursive
cd bitburner/src
git apply ../patches/0001-rfa-harness-port.patch
npm install --ignore-scripts
npx webpack --mode production
cd ../..
PUPPETEER_SKIP_DOWNLOAD=true npm install

# Run the smoke test (starts on whatever branch you're on; set to
# orchestrator/smoke-test for the canonical location)
git checkout -b orchestrator/smoke-test 2>/dev/null || git checkout orchestrator/smoke-test

cp config/run.example.yaml config/run.yaml
# edit as desired: orchestrator.model, subagent_roster, game.seed

# Short validation (3 minutes)
PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  BENCHBURNER_DURATION_SEC=180 npx tsx harness/index.ts

# Full 1-hour
PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  BENCHBURNER_DURATION_SEC=3600 npx tsx harness/index.ts

# Verify (SPEC §13)
ls results/<run_id>/
sqlite3 results/<run_id>/state.db 'select count(*) from delegations;'
jq .final_money results/<run_id>/summary.json
grep -Ei 'bitburner|bitnode|seed|netscript|augment|hacknet' results/<run_id>/orchestrator-prompts.log  # must be empty
git log --oneline orchestrator/smoke-test -1
```

Dev-only shortcut — skip Bitburner entirely to test pipeline
plumbing with the deterministic mock:

```sh
BENCHBURNER_USE_MOCK=1 BENCHBURNER_DURATION_SEC=120 npx tsx harness/index.ts
```

## Next milestone (suggested)

1. **Pull a real coder model** (qwen2.5-coder:7b, or HTTPAdapter to a
   hosted endpoint) and run a 24h test on `orchestrator/qwen2.5-coder`.
   This is what finally validates the "money goes up" assumption —
   today the pipeline is proven but the orchestrator hasn't had a
   subagent that can actually produce valid Netscript.
2. **Wire the aggregator's multi-branch fan-out** and point
   Cloudflare Pages at the `results-published` branch.
3. **Validate headless Chromium stability at 24h scale** (timer
   throttling, memory leak, RFA reconnect correctness).
4. **Second orchestrator model** for a real leaderboard comparison.
5. **Harden the dispatcher**: today a bad subagent script that
   exhausts home RAM can stall the queue until its 120s timeout.
   Add pre-flight RAM check + server-side kill.

## Handoff pointer

Run artifacts + the state of `orchestrator/smoke-test` are the
record. The 1-hour run currently in flight will append one more
commit; its `summary.json` is the first entry a future aggregator
multi-branch fan-out would ingest.
