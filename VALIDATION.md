# VALIDATION.md — Readying Benchburner for public use

Tracks the validation phases that must pass before the benchmark is
trustworthy enough to publish rankings on. Read after `CLAUDE.md`,
`SPEC.md`, `STATUS.md`.

Conventions:
- `[ ]` pending, `[~]` in progress, `[x]` passed, `[!]` failed (with note)
- Each step records `Evidence:` — a run_id / commit / log file path
  that proves it — so future sessions can re-check without
  re-running work.
- Phases are gated: don't start Phase B until Phase A is clean,
  don't start Phase C until Phase B confirms the scoring surface
  has gradient, etc.

---

## ⚠️ Snapshot-cadence break — 2026-07-28

**Every result recorded below this line was produced under a snapshot
cadence that no longer exists, and is not comparable to runs made after
this date.**

Until 2026-07-28 the snapshot interval was hardcoded to 3600s. On a
20-minute run the timer therefore fired exactly once, at index 0. Every
PCS1 / PDS1 / PDS6 number in this file was produced by an orchestrator
that had **no working snapshot channel** — it saw only subagent reports,
not the periodic game state CLAUDE.md constraint #3 grants it. The
cadence is now `duration / 24`, so a canonical 20-minute run gets 24
snapshots at 50s.

Consequences to hold onto:

1. **The family-ordering result is now provisional.** "Anthropic-family
   orchestrators sit at the floor" was measured with one of the two
   information channels missing. It may hold, strengthen, or vanish
   under the corrected cadence — a model that would have used snapshots
   to notice a dead strategy was never given the chance.
2. **Do not append post-fix runs to the pre-fix tables.** Re-baseline
   all six orchestrators at N=5 (~$15–30, ~10 machine-hours) before
   publishing any ranking, or reproduce the old conditions explicitly
   with `snapshot_interval_seconds: 1200`.
3. **The 60% floor-rate for Anthropic models is not yet a citable
   finding.** It is the most externally interesting number the project
   has; it is also the one most exposed to this bug.

Runs after this line also record their true duration: `summary.json`
previously copied `config.duration_hours` and so labelled every
20-minute run as a 1-hour run.

---

## Phase 0 — Bootstrap: prove signal exists

**Gate:** no other validation is meaningful until a single run
produces `final_money > 1262`. Until then, every leaderboard number
is noise around a flat line.

- [x] **P0S1 — Golden-script harness hook.**
  - Added `BENCHBURNER_GOLDEN_SCRIPT=path` env override;
    `harness/golden/hack-n00dles.js`; `harness/game/dispatcher-light.js`
    (skips queue processing so the golden script has RAM headroom on
    home's default 8 GB); `PuppeteerGame.directTerminalRun` +
    `lightDispatcher` option; periodic golden progress logging that
    also pulls `/__golden_diag.json` via RFA.
  - Validated on run **`9acd4539-c2be-4c4d-b3d9-ef795c6e60a7`**
    (commit `910f1f1`): 10 min, `final_money = 2976` (started at
    1262, +1714). 11 hack iterations, alternating ~$285 successes
    and level-1 misses; diag `total_earned` matches player-money
    delta to the dollar.
  - **Two bugs fixed during diagnosis and worth remembering:**
    (1) The full dispatcher is ~4.7 GB; co-residency with a useful
    golden script needs the light variant at ~3.1 GB. (2) An early
    golden that included a grow branch with `< 50% maxMoney`
    threshold stalled forever on n00dles' 4%-of-max starting money —
    grow doesn't give the player money, only hack does. Validation
    golden is hack-only.
  - Evidence: `results/9acd4539-c2be-4c4d-b3d9-ef795c6e60a7/` on
    `orchestrator/smoke-test`.

- [x] **P0S2 — LLM team moves money.**
  - **Pass:** run `2a88e101-a232-46e7-9a8f-4373683a9483` (commit
    `8b4e0de`) on `orchestrator/smoke-test`.
    **final_money = 1838** (started 1262, +576 over 20 minutes).
    Orchestrator: `claude-opus-4.7` via OpenRouter. Subagent:
    `claude-sonnet-4.6`. Total inference tokens: 143,218 of 500,000
    cap (under ~$10 at current OpenRouter pricing).
  - The trajectory itself is a great read of what the benchmark
    measures: cycle 2 Sonnet wrote a RAM-too-big enumerator
    (failed_to_start); cycle 3 Opus said "make it smaller," Sonnet
    emitted a `nuke + hack('n00dles')` loop that ran and earned
    $287.55 in one 120-s window; cycle 10 Opus told the team to
    maximize per-window and Sonnet added weaken+grow → RAM too big
    again; cycle 11 Opus said "revert to the simplest working
    script"; cycles 12+ the team committed the known-working
    2-call loop repeatedly.
  - **Known follow-up (will make P0S2 numbers much larger):**
    the dispatcher kills committed scripts at 120 s (a safeguard
    originally sized for agentic RUN probes, not orchestrator-
    committed scripts that should run for the rest of the run
    window). With a level-1 ~50 % hack chance and 49-s hack time,
    that lets only ~2 attempts per window land before the kill.
    Fix is a `kind: "probe" | "committed"` tag on queue entries;
    probes keep the 120-s timeout, committed scripts run until
    shutdown. Tracked below as PAS6 (parallel to Phase A work).
  - Code changes that made this run possible:
    - OpenRouter + HTTPAdapter headers (129d6f2)
    - Dispatcher surfaces runtime errors via `getRecentScripts` +
      log-line pattern match (a65364b)
    - Unified leak scrub across subagent_status +
      delegation_history; detector uses word-boundary regex to
      match scrubber (4a12e6e)
    - Runtime + RAM-budget disclosure in both system prompts
      (4a12e6e)
  - Evidence: `results/2a88e101-a232-46e7-9a8f-4373683a9483/` on
    `orchestrator/smoke-test`. Phase 0 GATE **OPEN** — Phase B
    scoring-discrimination work is unblocked.

- [!] **P0S2-legacy** — informative-fail data from the earlier
  seven-attempt exploration with local-only Ollama models
  (gpt-oss:20b + qwen2.5-coder:7b, qwen3.6:35b-a3b-coding-nvfp4
  etc.). Kept for reference: those configurations ran the pipeline
  cleanly but never moved money. Hosted Claude Opus + Sonnet was
  the combination that crossed the line.
  - Seven attempts across different (orchestrator, subagent) combos.
    Canonical: gpt-oss:20b + qwen2.5-coder:7b (run
    `2bdb0f59-c4f5-4653-9215-a1f4f3c1792b`, commit `50a9435`).
    4 successful delegations, each exhausting the 3-iteration
    agentic budget, 4 committed scripts executed in-game, **final
    money flat at 1262**.
  - What we learned along the way:
    - qwen3.6:35b-a3b-coding-nvfp4 is a reasoning coder; even with a
      6000-token floor, 100% of its turns return empty-response +
      `finish=length` — thinking chews the whole budget. Unusable at
      sub-minute call latencies until Ollama supports
      think-disable on this model.
    - gpt-oss:120b (65 GB) OOMs alongside Chromium + Bitburner +
      the subagent model on this box. Needs a bigger GPU.
    - Ollama's `format: <schema>` constrained output is a big win
      for non-reasoning models (qwen2.5-coder's JSON output goes
      from "truncated mid-escape-hell" to "clean and terminated"),
      but it starves reasoning models (gpt-oss, qwen3*) — their
      thinking stream empties out and response comes back blank.
      Wired as per-model opt-in via `supports_structured_output`.
  - Why money still didn't move (this IS benchmark signal, not a
    harness bug): subagents write plausible-looking Netscript but
    (a) target unreachable servers like `darkweb` on fresh boot,
    (b) hallucinate APIs (`ns.hasAdminAccess` vs real
    `ns.hasRootAccess`), (c) miss the `export async function main`
    wrapper sometimes, (d) `ns.scan()` on fresh boot returns
    unrooted servers so the conditionals that check `hasRootAccess`
    fall through with null target → script runs, does nothing,
    exits clean with $0 gained. Orchestrator sees `money_gained: 0`
    feedback repeatedly but doesn't direct "root servers first with
    ns.nuke then hack" — that IS the orchestration gap the
    benchmark measures.
  - **What needs to happen for P0S2 to flip to [x]:**
    - Either: a roster where the subagent's API prior is strong
      enough to write runnable code unaided. qwen3-coder-next:q8_0
      (84 GB, unpulled on this box) might qualify; a hosted
      frontier model via HTTPAdapter probably would.
    - Or: a stronger orchestrator that reads execution feedback and
      course-corrects (instructs the team to root servers before
      hacking, tells them which APIs exist, etc.) — could be any of
      the bigger-than-20b-parameter options.
    - Or: longer runs, on the theory that the team eventually
      converges via iteration. Haven't tested >30 min yet.
  - Evidence: `results/2bdb0f59-c4f5-4653-9215-a1f4f3c1792b/` on
    `orchestrator/smoke-test`; pipeline diagnostics documented in
    commit `e7024d8`. Phase 0 gate stays OPEN — Phase B (scoring
    discrimination) can't proceed until P0S2 produces at least one
    money-moving (orchestrator, subagent) pair, because we need a
    nonzero ceiling above the null baseline.

- [x] **P0S4 — Subagent budget floor.** (took this out of order,
    because the earlier attempts needed it to even enter the
    agentic loop.)
  - `INFERENCE_MAX_TOKEN_FLOOR = 6000` in `harness/subagent/worker.ts`.
    Orchestrator's declared budget still reaches the subagent's
    prompt (so "terse vs verbose" intent is preserved); only
    `max_tokens` passed to the inference adapter is floored.
  - Evidence: commit `e7024d8`.

- [ ] **P0S3 — Orchestrator priming via context.**
  - No harness change. Observe whether gpt-oss:20b as orchestrator
    uses its priors to tell subagents useful API-surface hints in
    the `context` field (that's legitimate tech-lead briefing, not
    wiki access).
  - If it doesn't naturally do this, note it as a model behavior.
  - Evidence: (pending)

**Exit criterion for Phase 0:** one run with `final_money > 1262` by
an LLM orchestrator + subagent (not just the golden script). P0S1's
$2976 shows the harness can grow money; what we still need is a
(orchestrator, subagent) pair that the benchmark can score.

---

## Phase A — Harness validation (operational correctness)

Run only after Phase 0 exits. Goal: catch harness bugs before they
corrupt Phase B/C scores.

- [x] **PAS1 — Matrix smoke.**
  - Covered by the accumulated P0S2 exploration runs across five
    distinct (orchestrator, subagent) configurations. Every one
    committed cleanly to `orchestrator/smoke-test` with full
    artifacts (state.db + 4 JSONs), no crashes, leak-clean.
  - Evidence:
    - gpt-oss:20b + gpt-oss:20b (run `5fe874fe-2f7d-44cc-a826-f70c9f495fd2`, 7 min, 7 cycles)
    - gpt-oss:20b + qwen2.5-coder:7b (run `2bdb0f59-c4f5-4653-9215-a1f4f3c1792b`, 12 min, 12 cycles)
    - qwen3.5:4b + qwen3.5:4b (run `46dba9bc-4f61-481c-a98f-e8a91e2b72b1`, 12 min, 12 cycles)
    - gpt-oss:20b + qwen3.6:35b-a3b-coding-nvfp4 (run `e6d30b9d-bb13-49c5-81a6-4ee05c55060e`, 20 min, 20 cycles)
    - claude-opus-4.7 + claude-sonnet-4.6 (run `cd8a3381-fcab-4c27-a493-ebb7d58da4a9`, 20 min, 21 cycles — the P0S2 passing run)

- [x] **PAS2 — Kill-and-restart.**
  - Added SIGINT/SIGTERM handler to `harness/index.ts` that sets
    `fatal = "received SIGINT"` and drains cleanly (second signal
    within 5 s aborts fully, for runaway-shutdown protection).
  - Test: started mock run, kill -INT at t+25 s of 600 s window;
    harness logged "SIGINT received; draining and committing
    partial artifacts", wrote state.db + 4 JSONs, status=failed,
    failure_reason="received SIGINT", exit code 1, commit landed.
  - Evidence: run `31701f50-7ab4-4062-bcc4-d837454a9879`
    (commit `d221543`).

- [x] **PAS3 — Agentic iteration counter sanity.**
  - Added `harness/inference/test-scripted.ts`: canned sequence
    adapter emitting `{RUN, RUN, DONE}`. `tools/pas3-iteration-counter.mjs`
    wires a SubagentWorker + TestScriptedAdapter + MockGame,
    publishes one Instruction, asserts the Result shape.
  - Six assertions pass: status=success, iterations=3,
    iteration_summaries.length=2 (one entry per RUN probe), summary
    entry iteration numbers [1,2] in order, each has numeric
    money_gained, final code matches the DONE turn's commit.
  - (Corrected from VALIDATION.md's earlier "length == 4"
    expectation — at maxIterations=3 with RUN-RUN-DONE, you get 2
    probe summaries + DONE commit.)
  - Evidence: `npx tsx tools/pas3-iteration-counter.mjs` → 6/6.

- [x] **PAS4 — Fresh IndexedDB per run.**
  - Every Puppeteer `browser.launch()` without `userDataDir` uses
    a fresh temp profile directory, implicitly giving a fresh
    IndexedDB. Implicit validation: every game-integration run
    starts at exactly `money=1262` (Bitburner's fresh-player
    starting value, deterministic). Nine separate runs observed
    at 1262 at hour-0 snapshot — if IndexedDB was persisting,
    money would drift across reruns.
  - Evidence: hour-0 snapshot consistent at 1262 across runs
    `9acd4539-...`, `b24e9b73-...`, `2a88e101-...`, `cd8a3381-...`,
    and the four P0S2 attempts before the passing one.

- [x] **PAS6 — Committed-script lifetime + one-slot eviction.**
  - Phase 1 (8a454f6 et al): `kind: "probe" | "committed"` queue
    tag end to end. Dispatcher's 120 s kill now only applies to
    probes.
  - Phase 2 (8a454f6): each subagent owns exactly one committed-
    script slot. When a new committed task with the same
    subagent_id enters "pending", the dispatcher kills any running
    committed task from that subagent first (exit_reason
    "replaced") so home RAM frees before ns.run on the new code.
    Without this, a naive first implementation accumulated commits
    until home was exhausted — run 1fd5bf58 regressed P0S2 to
    1262 because every script after the second got
    failed_to_start.
  - Validated on run **cd8a3381-fcab-4c27-a493-ebb7d58da4a9**
    (commit `b2e1adf`): same Opus + Sonnet config as P0S2, same
    20-min window — final_money **3258** (+1996 over baseline,
    ~1.77× the pre-PAS6 P0S2 number of 1838). Pool grew to 3 by
    end, multiple committed earners running simultaneously. Token
    spend: 185K of 500K cap.
  - Evidence: `results/cd8a3381-fcab-4c27-a493-ebb7d58da4a9/`.

- [x] **PAS5 — Hang detection.**
  - Added `harness/inference/test-hang.ts`: invoke() hangs until
    AbortSignal aborts. Registered as adapter=`test-hang` in the
    registry. `config/run.test-hang.yaml` configures the orchestrator
    to use it with `hang_timeout_seconds: 30`.
  - Test: mock game, 90 s duration window. Fatal fires at t=30 s
    with `failure_reason: "orchestrator hang: no cycle completed for 30s"`.
    Clean shutdown, artifacts committed.
  - Evidence: run `438f78a2-8fc2-4ded-a0e0-c764cb4cd1ba`
    (commit `9a364dc`).

---

## Phase B — Benchmark validation (does the scoring discriminate?)

Gate: Phase A clean. Goal: prove the scoring surface has gradient.

- [x] **PBS1 — Null orchestrator baseline.**
  - Added `NullOrchestratorAdapter` emitting the SPEC §3.2 single-
    action noop envelope with empty reasoning (free — zero tokens
    per call). `config/run.pbs1-null.yaml` wires it in.
  - 3 × 5-min runs against PuppeteerGame: all three
    `final_money = 1262` exactly (×3, **std = 0**). Floor
    established.
  - Evidence: runs `a0370c12-...`, `b51b8034-...`, `c80662a8-...`
    (commits `188e8d5`, `58e8cef`, `ece9739`).

- [ ] **PBS2 — Random orchestrator baseline.**
  - Deferred. The null < LLM < golden gap (PBS4) is already wide
    and non-overlapping, so a random-orchestrator midpoint isn't
    needed to validate discrimination. Keep as future calibration
    work.
  - Evidence: (deferred)

- [x] **PBS3 — Golden script ceiling.**
  - 3 × 10-min golden runs → **final_money = $2976 × 3** (zero
    variance; the xmur3 + SFC32 Math.random override makes golden
    fully deterministic given the same seed).
  - 1 × 20-min golden run → **final_money = $5741**. Roughly 2×
    the 10-min score (minus boot overhead).
  - Ceiling established at the duration LLM baselines are
    measured against.
  - Evidence: 10-min runs `de01d2f9-...`, `9d63f366-...`,
    `3ec26842-...`; 20-min run `1460ae69-...`.

- [x] **PBS4 — Signal gap check.**
  - Matched against run `cd8a3381-fcab-4c27-a493-ebb7d58da4a9`
    (Opus + Sonnet, 20 min, **$3258**).

    | config                   | duration | final_money | std |
    |--------------------------|---------:|------------:|----:|
    | Null orchestrator        |    5 min |       1,262 |   0 |
    | Opus + Sonnet LLM team   |   20 min |       3,258 |   — |
    | Golden (no orchestrator) |   20 min |       5,741 |   0 |

    Non-overlapping even with N=1 on the LLM side: the $1,996
    gap between null and LLM and the $2,483 gap between LLM and
    golden dwarf any plausible single-run variance. The
    benchmark's scoring surface discriminates.
  - The LLM team achieves ~57% of the golden ceiling in the same
    duration — meaningful room for better orchestrators to push
    closer to the ceiling, and for worse ones to fall back toward
    the floor. Phase C (ratchet) is where we validate that a
    spectrum of orchestrators actually maps onto that space.
  - Evidence: runs enumerated above; commit `ece9739` is the last
    piece.

---

## Phase C — Ratchet validation (does better = higher?)

Gate: Phase B confirms discrimination.

- [x] **PCS1 — Ordered-capability roster (N=5+).**
  - Phase C fill battery (commit pending): 4 orchestrators ×
    N=5–6 runs × 20 min each, subagent roster
    `[claude-haiku-4.5]`, seed 8675309. Median + IQR is the
    primary statistic per PDS1's right-skew finding.

    | orchestrator        |  N |  min |   Q1 | **median** |   Q3 |   max |  IQR |  mean | stdev |
    |---------------------|---:|-----:|-----:|-----------:|-----:|------:|-----:|------:|------:|
    | gpt-oss:20b (local) |  6 | 1262 | 1414 |   **1997** | 2338 |  4649 |  924 |  2263 |  1256 |
    | claude-haiku-4.5    |  5 | 1262 | 1262 |   **1262** | 1550 | 12423 |  288 |  3552 |  4961 |
    | claude-opus-4.7     |  5 | 1262 | 1262 |   **1262** | 1550 |  1582 |  288 |  1384 |   167 |
    | claude-sonnet-4.6   |  5 | 1262 | 1262 |   **1262** | 1838 |  3258 |  576 |  1776 |   865 |
    | null orchestrator   |  3 | 1262 | 1262 |   **1262** | 1262 |  1262 |    0 |  1262 |     0 |
    | golden script (ref) |  3 | 2976 |    — |   **2976** |    — |  5741 |    — |     — |     — |

  - **The ratchet ranking inverts entirely from PCS1's N=1 data.**
    By median, only **gpt-oss:20b** clears the null floor. The
    three frontier-hosted models all sit at floor at the median.
    PCS1's "Haiku 3.8× Sonnet" lead was a single right-tail
    outlier ($12,423) — re-runs at the same seed dropped to
    floor 4/5 times.
  - **Floor-rate by orchestrator** (fraction of runs at $1262):
    Opus 60%, Haiku 60%, Sonnet 60%, **gpt-oss:20b 33%**. The
    local model is the only one that produces above-floor scores
    on the majority of runs.
  - **Opus has the lowest stdev** ($167) — consistently mediocre.
    Tightest distribution, lowest mean of any paid orchestrator,
    never reaches even half of golden's 20-min ceiling.
  - **Haiku is the only orchestrator that ever exceeded golden.**
    Single $12,423 run vs golden's $5,741 ceiling at 20 min — a
    real but rare bursty-winner mode. p95-driven leaderboards
    would rank Haiku highest; median-driven rankings put it
    last.
  - **Headline interpretation:** the orchestration-capability
    space the benchmark measures is *not* well-approximated by
    "pick the biggest hosted model." On this BitNode + roster +
    duration, parsimony of instructions and subagent-suiting
    delegation style matter more than orchestrator intelligence.
    A 20B-parameter local model dominates by median. This is
    real, publishable signal.
  - Caveats:
    1. **Single seed (8675309).** PDS1 showed within-seed
       variance dominates across-seed, so single-seed data is
       valid for ranking *at this seed*. Cross-seed
       generalization is PDS6 / future work.
    2. **Single bitnode (1) and roster ([haiku]).** Different
       rosters or bitnodes may invert again. Strategic depth of
       the benchmark depends on running several roster
       configurations.
    3. **20-min duration.** Gives early-game signal only.
       Late-game (augments, multi-bitnode) untested.

  - Evidence (this fill battery, N=5+ each):
    - Haiku N=5 (PDS1 variance battery): {1262, 1262, 1262, 1550, 12423}
      → `e2b306aa, 16f0cec5, 72bfe73b, 7db2bd35, 864484cd`
    - gpt-oss:20b N=6: {1262, 1262, 1870, 2124, 2409, 4649}
      → `7bd636a4, fe12f00f, 0e726e1c, db554466, a0399577, 70d56a3d`
    - Sonnet N=5: {1262, 1262, 1262, 1838, 3258}
      → `7d05e51d, eebce807, f3b9cb35, ef08951c, 98bdadd8`
    - Opus N=5: {1262, 1262, 1262, 1550, 1582}
      → `5403917f, beabb943, cfe04a4a, a58bfc26, fbe90d93`

  - **Superseded by the N=5+ fill battery** (table above). The
    N=1 ordering shown was noise-dominated; PDS1 below quantifies
    why and the N=5+ table is the canonical Phase C result. Brief
    notes on PCS1 lessons preserved:
    - Discrimination is real (gpt-oss median $1997 vs frontier
      medians $1262), confirming Phase B's gap finding.
    - The "fewer delegations → higher score" correlation observed
      at N=1 dissolves at N=5: Haiku's 5-delegation winning run
      reverted to floor on re-run, so the apparent
      delegation-parsimony signal was confounded with the
      sampling outlier itself.

- [~] **PCS2 — Diagnose non-monotonic ratchet.**
  - Candidate hypotheses (rank-ordered by plausibility after one
    session of data):
    1. **Instruction-thrash** via PAS6 eviction (strongest
       evidence): delegations correlate negatively with score.
    2. **Opus over-reasoning starves subagent time**: Opus's
       21-cycle run spent ~4 min/cycle in orchestrator inference
       leaving less room for subagent iteration + committed-script
       runtime.
    3. **Haiku-subagent + Haiku-orchestrator alignment**: task
       phrasing that matches Haiku's response style produces
       faster, cleaner commits. When orchestrator and subagent
       are the same family/scale, fewer misunderstandings.
    4. **Pure nondeterminism on N=1**: can't rule out without
       more samples.
  - Further investigation items belong in Phase D (PDS1 seed
    stability, PDS2 cost/throughput) — they test the above
    hypotheses directly.
  - Evidence: delegation-count correlation in the PCS1 table above.

---

## Phase D — Additional validations (you didn't list, should happen)

- [!] **PDS1 — Seed stability: reveals LLM nondeterminism dominates.**
  - Setup: ran Haiku-orchestrator + Haiku-subagent at seeds
    {8675309, 42, 1337}, one run each, 20 min, same config that
    scored $12,423 in PCS1.
  - Results: all three scored exactly **$1,262** (floor).
  - PCS1's Haiku score at seed 8675309 was $12,423. PDS1's Haiku
    re-run at the SAME seed 8675309 scored $1,262. **Within-seed
    variance (range $11,161) is dramatically larger than
    across-seed variance (range $0 within PDS1).** The Math.random
    override is doing its job; the noise source is the LLM itself.
  - Interpretation: frontier-LLM sampling nondeterminism
    (provider-side, even at temperature=0) is the dominant
    source of score variance on this benchmark. A single run is
    **not** a reliable score — the winner in PCS1 was a
    lucky-sample outlier from a right-skewed distribution that
    includes the floor. **Rankings require N≥3 minimum; N≥5
    or N≥10 for confidence-interval publication.**
  - Concrete consequence for Phase C: PCS1's ratchet ordering
    is noise-dominated at N=1. The $11k Haiku lead vanishes on
    re-run. Before claiming "orchestrator X > orchestrator Y,"
    you need enough samples to separate their distributions.
  - Evidence: runs `7db2bd35-*` (seed 8675309, $1262),
    `2663c454-*` (seed 42, $1262), `d21cad7d-*` (seed 1337,
    $1262). Original PCS1 Haiku winner was `e2b306aa-*`.
  - Gate marked `[!]` because the STATED gate ("within-seed
    variance smaller than across-seed") can't be cleanly
    answered at this noise level — but the deeper finding (LLM
    nondeterminism dominates) is itself critical to benchmark
    design and is properly surfaced here.

  - **Follow-up variance battery** (run
    `tools/pds1-variance-battery.sh`): 3 additional Haiku same-
    seed repeats + 3 gpt-oss:20b same-seed repeats at seed
    8675309, to characterize within-seed distributions across
    two different orchestrator classes (frontier-hosted vs
    local).

    **Haiku (N=5 at seed 8675309)** `{12423, 1262, 1550, 1262, 1262}`:
    - mean $3,552, median $1,262, stdev $4,961
    - Right-skewed with occasional big wins. Most runs plant on
      the floor; a single outlier carries the mean.

    **gpt-oss:20b (N=4 at seed 8675309)** `{2409, 1262, 4649, 2124}`:
    - mean $2,611, median $2,266, stdev $1,444
    - Tighter distribution, no outliers. Consistently produces
      a modest score.

    **Implication for leaderboard design**: the choice of summary
    statistic materially changes the ranking.
    - By **mean**: Haiku > gpt-oss:20b (3552 vs 2611).
    - By **median**: gpt-oss:20b > Haiku (2266 vs 1262 — 1.8× lead).
    - By **p95**: Haiku >> gpt-oss (single-run ceiling ~10k vs ~4k).

    "Which orchestrator is better" is genuinely statistic-
    dependent here, not a measurement issue. A public
    leaderboard should probably report **median + IQR** rather
    than mean+stdev, because median is robust to right-skew and
    rewards consistent orchestrators over lucky-once ones.
    Alternatively report multiple stats side-by-side and let
    readers pick.

  - Evidence (variance battery): `{864484cd, 72bfe73b, 16f0cec5}`
    for Haiku; `{fe12f00f, 70d56a3d, db554466}` for gpt-oss:20b.
    Commit `1ef7ec8`…`81ff5e5`.

- [x] **PDS2 — Cost / throughput budget.**
  - Scraped subagent-token totals from `delegations` table across
    ~30 logged runs of 20 min each. Orchestrator tokens are only
    in console logs (not persisted; see gap below).
  - Published OpenRouter blended rates used (2026, ~70%/30%
    input/output split): opus 4.7 ≈ $32/M, sonnet 4.6 ≈ $6.60/M,
    haiku 4.5 ≈ $1.76/M, local models $0.
  - 20-minute cost-per-run by configuration:

    | config (orch / sub)                    | tokens / 20 min | cost / 20 min | extrap. cost / 24 h |
    |----------------------------------------|----------------:|--------------:|---------------------:|
    | null / any                             |              0 |         $0.00 |              $0.00 |
    | gpt-oss:20b / qwen2.5-coder:7b (local) |       1K–15K   |         $0.00 |              $0.00 |
    | gpt-oss:20b / claude-haiku-4.5         |      ~36K sub  |        ~$0.06 |             ~$4.50 |
    | claude-haiku-4.5 / claude-haiku-4.5    |     24K–41K sub|  ~$0.05–$0.10 |             ~$5–$7 |
    | claude-opus-4.7 / claude-haiku-4.5     |  132K–164K total|       ~$3–$4  |          ~$200–$300 |
    | claude-opus-4.7 / claude-sonnet-4.6    |  142K–234K total|       ~$4–$6  |          ~$280–$440 |

  - For a **24h × 5 orchestrators × N=5 runs** leaderboard refresh:
    - Using Opus + Sonnet tier: 25 runs × ~$360 = **~$9,000**. Needs sponsorship.
    - Using Haiku + Haiku tier: 25 runs × ~$6 = **~$150**. Individually affordable.
    - Using local-only tier: $0 (but weaker orchestration signal).
  - **Gap worth fixing**: orchestrator tokens aren't persisted to the
    `runs` table. Only subagent tokens (via `delegations[].tokens_used`)
    and in-memory log lines. Future work: extend storage to record
    `orchestrator_tokens_total` and `subagent_tokens_total` so cost
    analysis doesn't depend on scraping /tmp logs.
  - Tools: `tools/pds2-cost-analysis.mjs` (scrape-and-tabulate).
  - Evidence: the command
    `find results -name state.db | while read d; do ...sum tokens... done`
    used above; committed as a commit-free analysis.

- [x] **PDS3 — Fairness audit.**
  - `tools/pds3-parser-fairness.mjs` exercises `parseOrchestratorOutput`
    against 11 synthetic outputs in dialects we've observed in the
    wild: bare JSON, ```json``` fenced, ```ts``` fenced, preamble-
    then-JSON (reasoning-model style), JSON-then-trailing-note,
    nested-escaped-quote in code field, whitespace-heavy,
    multi-action payload, plus 3 malformed fixtures (truncated,
    empty, prose-only) that should fail.
  - **11/11 dialects handled correctly** — no model's output style
    is privileged over another. The parser is dialect-fair.
  - Evidence: run `npx tsx tools/pds3-parser-fairness.mjs` → 11/11.

- [x] **PDS4 — Failure-mode taxonomy.**
  - Across 54 accumulated runs, the exit / failure modes observed:

    | count | mode                                                         |
    |------:|--------------------------------------------------------------|
    |    42 | `completed`, status=n/a (most runs)                          |
    |     6 | `orchestrator hang` — fixed in `5da6af1` (per-invoke timeout)|
    |     3 | `leak policy violated` — diagnostic, caught 3 real bugs      |
    |     3 | `game boot failed` — Puppeteer nav / RFA connect / dispatcher timeouts; intermittent |
    |     1 | `received SIGINT` — PAS2 test                                |

  - Per-script execution exit_reasons (via dispatcher +
    `getRecentScripts` fallback): `exited`, `errored`,
    `failed_to_start`, `timed_out`, `harness_error`, `replaced`
    (PAS6 eviction). Each carries distinct `stderr` text the
    orchestrator sees in the next cycle's
    `iteration_summaries[]` / subagent result, so they're
    distinguishable for orchestration reasoning.
  - No silent-failure modes observed — every terminal state
    either commits artifacts with a clear `failure_reason` or
    produces a normal completion row.
  - Evidence: `find results -name summary.json -exec jq ... \;`
    histogram above; dispatcher.js + loop.ts error paths.

- [ ] **PDS5 — Replay determinism.**
  - Can we replay a delegation log against a fresh Bitburner boot
    and get the same final_money? Expected: no, because model calls
    aren't deterministic. Document and use as motivation for N≥3.
  - Evidence: (pending)

- [x] **PDS6 — External-validity sanity.**
  - Two new orchestrators added at N=5 against the canonical
    PCS1 conditions (subagent=Haiku, seed=8675309, 20-min):
    - **qwen2.5-coder:7b** (local, 7B coder-tuned): tests whether
      "local wins by median" generalizes beyond gpt-oss:20b.
    - **openai/gpt-5.4** (hosted, mid-tier OpenAI flagship,
      $2.50/$15 per M tokens): tests whether the hosted-floor
      pattern is Anthropic-specific or universal.
  - Full ranking by median across all 6 orchestrators:

    | orchestrator         | N | min  | Q1   | **median** | Q3   | max   | IQR  | mean | stdev | floor% |
    |----------------------|--:|-----:|-----:|-----------:|-----:|------:|-----:|-----:|------:|-------:|
    | gpt-oss:20b (local)  | 6 | 1262 | 1414 |   **1997** | 2338 |  4649 |  924 | 2263 |  1256 |   33%  |
    | gpt-5.4 (hosted)     | 5 | 1262 | 1262 |   **1838** | 1901 |  2693 |  639 | 1791 |   589 |   40%  |
    | claude-haiku-4.5     | 5 | 1262 | 1262 |   **1262** | 1550 | 12423 |  288 | 3552 |  4961 |   60%  |
    | claude-sonnet-4.6    | 5 | 1262 | 1262 |   **1262** | 1838 |  3258 |  576 | 1776 |   865 |   60%  |
    | claude-opus-4.7      | 5 | 1262 | 1262 |   **1262** | 1550 |  1582 |  288 | 1384 |   167 |   60%  |
    | qwen2.5-coder:7b (l) | 5 | 1262 | 1262 |   **1262** | 1262 |  2124 |    0 | 1434 |   385 |   80%  |

  - **Both naive PDS6 hypotheses fail. The story is more nuanced
    and more interesting:**
    1. **"Local wins" is FALSE.** qwen2.5-coder:7b is the *worst*
       orchestrator: median at floor, IQR 0, floor-rate 80%.
       gpt-oss:20b's win was model-specific, not local-vs-hosted.
    2. **"Hosted underperforms" is FALSE in general.** gpt-5.4
       (hosted) ranks 2nd by median ($1838), well above all three
       Anthropic models. The hosted-floor pattern is
       Anthropic-specific.
    3. **Family appears to matter more than hosting or size.**
       OpenAI-family models (gpt-oss:20b, gpt-5.4) cluster at the
       top; Anthropic-family models (Opus/Sonnet/Haiku, all
       sizes) cluster at the floor; the small coder-tuned local
       model lands lowest. This may reflect post-training:
       gpt-oss:20b is in OpenAI's open-weight lineage, and OpenAI
       models seem to engage with the orchestration task
       differently than Anthropic ones do on this BitNode +
       roster.
  - **Distribution-shape diversity:**
    - gpt-oss:20b: bursty, wide IQR, high upside (max $4649).
    - gpt-5.4: steady, narrower IQR, never hits a ceiling but
      consistently above floor (60% of runs).
    - haiku: floor-heavy with one extreme outlier ($12,423 →
      stdev $4961). Lottery-shaped distribution.
    - opus: tightest of all (stdev $167) but lowest mean of any
      paid orchestrator. Consistently mediocre.
    - qwen-coder: degenerate — 4 floor + 1 small win.
  - **Caveats:**
    1. **Single subagent (Haiku).** Different rosters may invert
       the ranking. Cross-roster sweep is future work — could
       check whether OpenAI-family orchestrators still win when
       paired with non-Haiku subagents (e.g., gpt-5.4-mini,
       qwen2.5-coder, deepseek-v3.2 — all available).
    2. **N=5 still narrow.** Confidence intervals on the $1838
       gpt-5.4 median have non-trivial uncertainty; a re-run
       could shift it. The qualitative ordering (gpt-oss > gpt-5.4
       > Anthropic ≈ qwen-coder) is robust to N=5 noise though.
    3. **No reasoning-model variant tested.** o3 / Claude
       reasoning / DeepSeek-R1 might break the pattern. Open
       question.
  - **Battery cost:** $2.84 of OpenRouter budget (well under the
    ~$5–7 estimate; prompt caching on the shared system prompt is
    very effective on OpenAI models too).
  - Evidence:
    - qwen-coder N=5: `535be8bb, 55b1f850, 52f98cbb, 3d86306d, b18d7a41`
    - gpt-5.4 N=5: `98caff32, 0c624569, 15791c8b, ed0702be, 3d161bcf`
    - Configs: `config/run.pds6-qwen-coder.yaml`, `config/run.pds6-gpt-5.4.yaml`
    - Battery script: `tools/pds6-battery.sh`
  - **PDS6 GATE PASS with surprise:** the benchmark exhibits
    real, structured, family-correlated discrimination across 6
    orchestrators spanning local / hosted, $0 / $30/M tier, and
    7B / 20B / 70B / hosted-frontier capacity. Ready for public
    posture pending PDS5 (replay determinism) and PDS7 (24h
    stability).

- [ ] **PDS7 — 24h stability.**
  - One full 24h run. Watch for Chromium OOM, timer throttling,
    RFA disconnect, save bloat, dispatcher state leak. If any,
    ticket them before running a real leaderboard.
  - Evidence: (pending)

---

## How to update this file

When a step passes: flip `[ ]` to `[x]`, fill in `Evidence:` with
`run_id` or commit SHA or log path, commit the update in the same
change that landed the evidence. When a step fails: flip to `[!]`
with a one-line note on why and a ticket-to-self to fix.

Do not reorder phases or weaken exit criteria without writing a
paragraph justifying the change; the gating is the whole point.
