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

- [~] **PCS1 — Ordered-capability roster.**
  - Phase C v2 battery: 4 orchestrators × 1 run × 20 min,
    subagent roster `[claude-haiku-4.5]`, seed 8675309.

    | orchestrator        | final_money | delegations | scripts |
    |---------------------|------------:|------------:|--------:|
    | null                |       1,262 |           0 |       0 |
    | claude-opus-4.7     |       1,550 |           6 |       — |
    | gpt-oss:20b (local) |       2,409 |          12 |      12 |
    | claude-sonnet-4.6   |       3,258 |          17 |      17 |
    | claude-haiku-4.5    |      12,423 |           5 |       5 |
    | (golden reference)  |       5,741 |           — |       — |

  - Discrimination: clear — $11k spread between the top and bottom
    LLM orchestrators.
  - Ordering: **NOT monotonic on model "capability"**. The naive
    expectation (Opus > Sonnet > Haiku > gpt-oss:20b > null)
    inverts on the top two: Haiku wins by a wide margin, Opus
    lands *below* gpt-oss:20b. This is a real and interesting
    benchmark finding, not a harness bug.
  - The correlation that DID hold: **fewer delegations → higher
    score**. PAS6's one-committed-script-per-subagent eviction
    means every `instruct` kills the previous worker; orchestrators
    that issue a handful of durable instructions leave long-running
    earners in place, while orchestrators that over-instruct
    thrash the pool. Haiku's 5 delegations ran longer per
    committed script than Sonnet's 17 or Opus's elaborate cycling.
  - This IS valid benchmark signal: the orchestration strategy
    space the benchmark measures is *not* well-approximated by
    "pick the biggest model." It rewards instruction parsimony on
    this particular BitNode + roster.
  - Known caveats: N=1 per orchestrator, seed held constant.
    Before drawing strong conclusions, we need N≥3 per model and
    seed variance (Phase D / PDS1). The partial check-mark is
    because the discriminative surface is proven but the ratchet
    characterization is preliminary.
  - **UPDATE from PDS1 (below):** within-seed variance turns out
    to be massive — Haiku's same-seed re-run dropped from $12,423
    to $1,262. The ratchet ordering above is noise-dominated, not
    a true capability signal. The $11k "Haiku wins" result was a
    lucky outlier. Until we have N≥3-5 per orchestrator, Phase C
    can't claim a stable ordering. Scoring surface *does*
    discriminate (Phase B gap is real); what it doesn't do at
    N=1 is rank orchestrators reliably.
  - Evidence: `results/a0399577-*/` (gpt-oss:20b, $2409),
    `results/e2b306aa-*/` (Haiku, $12423),
    `results/98bdadd8-*/` (Sonnet, $3258),
    `results/a58bfc26-*/` (Opus, $1550 — retry v3 with
    structured-output forcing on Haiku subagent).

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

- [ ] **PDS2 — Cost / throughput budget.**
  - Record tokens/cycle, cycles/hour, Chromium RSS, GPU memory.
  - Extrapolate to the eventual 24h × N-orchestrator leaderboard
    refresh. Flag hosted-API runs with per-token $.
  - Evidence: (pending)

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

- [ ] **PDS6 — External-validity sanity.**
  - Before open-sourcing: run once against a hosted frontier model
    (Claude 4.7 or GPT-5 via HTTPAdapter). If scores are
    meaningfully different from local small models, benchmark has
    external validity.
  - Evidence: (pending)

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
