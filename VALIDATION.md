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

- [ ] **P0S1 — Golden-script harness hook.**
  - Add `BENCHBURNER_GOLDEN_SCRIPT=path` env override in
    `harness/index.ts`: when set, bypass the orchestrator loop and
    push+run that one script against the pinned Bitburner instance
    for `duration_hours`.
  - Write a hand-tuned `harness/golden/hack-n00dles.js` that roots
    `n00dles` + `foodnstuff` and runs a `ns.hack(...)` loop.
  - 30-minute run. Expected: `final_money > 1262`.
  - **Non-negotiable:** if this fails, the bug is in our game
    integration and no model choice will ever fix it.
  - Evidence: (pending)

- [ ] **P0S2 — Bigger coder subagent.**
  - Pull `qwen3-coder-next:q8_0` (84GB) — box has the memory.
  - Config: `orchestrator: gpt-oss:20b, roster: [qwen3-coder-next:q8_0]`.
  - 30-minute run with agentic loop.
  - Expected: subagent produces runnable Netscript; `final_money` moves.
  - Evidence: (pending)

- [ ] **P0S3 — Orchestrator priming via context.**
  - No harness change. Observe whether gpt-oss:20b as orchestrator
    uses its priors to tell subagents useful API-surface hints in
    the `context` field (that's legitimate tech-lead briefing, not
    wiki access).
  - If it doesn't naturally do this, note it as a model behavior.
  - Evidence: (pending)

- [ ] **P0S4 — Subagent budget floor.**
  - Soft floor in the worker: `effective_budget = max(requested, 600)`.
  - Hygiene, not a benchmark-meaning change. Orchestrators that
    ask for 200 tokens-per-turn starve reasoning subagents.
  - Evidence: (pending)

**Exit criterion for Phase 0:** one run with `final_money > 1262`.

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
