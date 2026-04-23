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

- [ ] **PAS1 — Matrix smoke.**
  - 4 runs × 15 min: `{gpt-oss:20b, qwen3.5:4b}` × `{self, qwen2.5-coder:7b}`.
  - All must commit cleanly, DB populated, leak-clean, no crashes.
  - Evidence: (pending)

- [ ] **PAS2 — Kill-and-restart.**
  - `kill -INT` the harness mid-run. Verify shutdown commits
    `status: failed` with valid partial JSONs per CLAUDE.md
    §"Failure Handling".
  - Evidence: (pending)

- [ ] **PAS3 — Agentic iteration counter sanity.**
  - Stub a subagent that emits `RUN` 3× then `DONE`. Verify
    `iteration_summaries.length == 4` and each entry has distinct
    feedback.
  - Evidence: (pending)

- [ ] **PAS4 — Fresh IndexedDB per run.**
  - Two sequential runs must each start from the Bitburner-default
    state. Puppeteer's per-launch profile dir should already
    guarantee this; confirm.
  - Evidence: (pending)

- [ ] **PAS6 — Committed-script lifetime.**
  - Dispatcher's 120 s kill was sized for agentic RUN probes so
    one bad probe doesn't stall the queue. Orchestrator-committed
    scripts (the subagent's final DONE code, auto-submitted after
    the result arrives) inherit the same kill, which caps earn
    time at 2-3 hack attempts per commit. Tag queue entries with
    `kind: "probe" | "committed"`; probes keep the 120 s limit,
    committed scripts run until the harness shuts down.
  - Expected effect: P0S2's 1838 becomes substantially larger
    when the same team is given full run duration for
    money-earning code.
  - Evidence: (pending)

- [ ] **PAS5 — Hang detection.**
  - Inject a sleep-forever inference adapter. Verify run fails at
    `hang_timeout_seconds` (default 600) with
    `failure_reason: orchestrator hang`.
  - Evidence: (pending)

---

## Phase B — Benchmark validation (does the scoring discriminate?)

Gate: Phase A clean. Goal: prove the scoring surface has gradient.

- [ ] **PBS1 — Null orchestrator baseline.**
  - Implement `FakeNullAdapter` that emits
    `{actions: [{action_type: "noop"}], reasoning: ""}`. Selectable
    by model id `null`.
  - 3 × 30-min runs. Expected: `mean(final_money) ≈ 1262, std ≈ 0`.
  - Sets "no orchestration" floor.
  - Evidence: (pending)

- [ ] **PBS2 — Random orchestrator baseline.**
  - Adapter that emits random legal actions from a small canned
    task pool.
  - 3 × 30-min runs. Expected: slightly above null, high variance.
  - Evidence: (pending)

- [ ] **PBS3 — Golden script ceiling.**
  - Rerun P0S1 5× for 30 min.
  - Expected: clearly above any LLM-orchestrator score; sets the
    "what's achievable without an orchestrator" ceiling.
  - Evidence: (pending)

- [ ] **PBS4 — Signal gap check.**
  - Confirm: null < best-LLM-orchestrator < golden with
    non-overlapping confidence intervals. If violated, the
    benchmark isn't yet discriminating.
  - Evidence: (pending)

---

## Phase C — Ratchet validation (does better = higher?)

Gate: Phase B confirms discrimination.

- [ ] **PCS1 — Ordered-capability roster.**
  - Pick 3 orchestrator models where we expect an ordering (e.g.,
    qwen3.5:4b < gpt-oss:20b < qwen3-coder-next:q8_0).
  - 5 × 1-hour runs per orchestrator, same roster, same seed.
  - Expected: mean scores preserve the ordering with non-overlapping
    CIs on at least two adjacent pairs.
  - Evidence: (pending)

- [ ] **PCS2 — Diagnose if ratchet fails.**
  - Classify cause: model nondeterminism (too noisy), roster ceiling
    (subagents too weak), or true absence of ordering.
  - Evidence: (pending)

---

## Phase D — Additional validations (you didn't list, should happen)

- [ ] **PDS1 — Seed stability.**
  - 3 seeds × 5 runs each with the same config. Within-seed variance
    should be smaller than across-seed variance. If equal, our
    `Math.random` override isn't reaching all RNG sources.
  - Evidence: (pending)

- [ ] **PDS2 — Cost / throughput budget.**
  - Record tokens/cycle, cycles/hour, Chromium RSS, GPU memory.
  - Extrapolate to the eventual 24h × N-orchestrator leaderboard
    refresh. Flag hosted-API runs with per-token $.
  - Evidence: (pending)

- [ ] **PDS3 — Fairness audit.**
  - 10 synthetic model outputs in GPT / Claude / Qwen / reasoning /
    terse dialects. Confirm `extractFirstJsonObject` parse rates
    are uniform across dialects.
  - Evidence: (pending)

- [ ] **PDS4 — Failure-mode taxonomy.**
  - Catalog the exit_reasons seen in real runs
    (`failed_to_start`, `errored`, `exited`, `timed_out`,
    `harness_error`) and confirm each is distinguishable to the
    orchestrator via iteration_summaries / game_state_snapshot.
  - Evidence: (pending)

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
