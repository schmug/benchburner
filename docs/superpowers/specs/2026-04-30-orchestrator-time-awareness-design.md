# Orchestrator time awareness — design

**Date:** 2026-04-30
**Status:** Proposed
**Touches:** [SPEC.md §3.1](../../../SPEC.md), [SPEC.md §3.3](../../../SPEC.md), [harness/orchestrator/prompt.ts](../../../harness/orchestrator/prompt.ts), [harness/orchestrator/loop.ts](../../../harness/orchestrator/loop.ts), [harness/types.ts](../../../harness/types.ts)

## Problem

The orchestrator currently learns about its run horizon two ways:

1. The system prompt literal `"the 24-hour window"` ([prompt.ts:12](../../../harness/orchestrator/prompt.ts:12)).
2. The `elapsed_time_seconds` field in its per-cycle input ([loop.ts:298](../../../harness/orchestrator/loop.ts:298)).

This is broken in two ways:

- **The literal "24-hour" is a lie for short runs.** [`BENCHBURNER_DURATION_SEC`](../../../harness/index.ts:36) and [`config.duration_hours`](../../../harness/types.ts:250) let runs be configured to anything (e.g. the [§13 smoke test](../../../SPEC.md:503) at 1h). The orchestrator is still told 24h regardless. Strategy tuned to a 24h horizon doesn't generalize to a 1h budget.
- **No structured deadline.** To know how much time remains, the model must (a) attend to the literal "24-hour" string, (b) convert to seconds, (c) subtract `elapsed_time_seconds`. Mental math is not orchestration skill; it's an arithmetic confound.

## Why this is OK to fix (measurement integrity check)

[CLAUDE.md](../../../CLAUDE.md) is explicit: *"Measure orchestration, not gameplay. If a design choice makes the orchestrator more powerful at the expense of isolating management skill, reject it."*

Adversarial review concluded the change does not violate that principle. The SPEC already commits to telling the orchestrator about the deadline (§3.3 names "the 24-hour window"). We've already chosen "known deadline" over "inferred horizon." Moving the same fact from a hardcoded prompt string to a structured field, with an honest number, doesn't expand orchestrator power — it removes an arithmetic confound and a smoke-test lie.

What it *would* violate, and what we therefore explicitly reject below, is leaking time to subagents.

## Decision

Add `total_duration_seconds` to the [§3.1 orchestrator input](../../../SPEC.md:184). Templatize the [§3.3 prompt](../../../SPEC.md:236) on `duration_hours`. Subagents stay time-blind. Hourly-snapshot `hour` index stays where it is, not promoted into the orchestrator input.

### What changes

#### 1. Input schema (SPEC §3.1)

Add one field to `OrchestratorInput`:

```diff
 {
   "cycle_number": 42,
   "elapsed_time_seconds": 10800,
+  "total_duration_seconds": 86400,
   "game_state": { ... },
   ...
 }
```

`time_remaining_seconds` is **not** added — it's redundant once both `elapsed` and `total` are present, and the simpler API is "facts only, derive your own."

#### 2. System prompt (SPEC §3.3)

Replace the literal `"the 24-hour window"` with the templated form:

```diff
- Your goal is to maximize the team's in-game money in the 24-hour window.
+ Your goal is to maximize the team's in-game money in the {N}-hour window.
```

**Single source of truth: both the prompt substitution and the new `total_duration_seconds` input field are derived from the same `effectiveDurationSec`** (the value computed at [index.ts:45](../../../harness/index.ts:45), which honors `BENCHBURNER_DURATION_SEC` when set, else `config.duration_hours * 3600`). Sourcing the prompt from `config.duration_hours` directly would re-introduce the very lie this change exists to fix — when an env override shortens a run, the prompt would still say 24.

**Formatting** of `N` for the prompt:
- For whole-hour durations (≥1h, integer): print as integer (`"24-hour"`, `"1-hour"`).
- For fractional hours (e.g., 10-minute smoke run): print with up to 2 decimals, trailing zeros trimmed (`"0.17-hour"`).

Exact formatter is an implementation detail; the invariant is that prompt and field always describe the same horizon.

**Numeric salience is preserved** — models that don't introspect the JSON still see a concrete horizon. This is a smaller behavioral delta than rephrasing into "see your input fields."

#### 3. Subagent input (SPEC §2.1)

**No change.** Subagents do not get time information. Rationale: in real engineering teams, the *manager* communicates horizon downward via task framing. Leaking time directly to subagents would hand orchestrators a free pacing channel they didn't have to build via instruction context. Keeping it asymmetric strengthens what the benchmark measures.

#### 4. Snapshot `hour` field

**No change.** The hourly snapshot ([types.ts:100](../../../harness/types.ts:100)) carries an `hour: number` field that is currently dropped by [`acceptIncomingState`](../../../harness/orchestrator/loop.ts:476). It stays dropped. `elapsed_time_seconds` plus `total_duration_seconds` already encodes everything `hour` would tell the orchestrator; promoting `hour` into the input would be redundant.

### Fairness departure (explicit)

[SPEC §3.3](../../../SPEC.md:236) currently says *"the exact wording should be fixed across all benchmarked models for fairness."* Templatizing on `duration_hours` means wording differs across runs with different durations.

This must be made explicit in the SPEC: **fairness is per-cycle, not per-lifetime.** All orchestrators in a given benchmark cycle run with the same `duration_hours` and therefore see the same prompt — fairness preserved. Runs with different `duration_hours` (e.g. a 1h smoke test vs. a 24h benchmark cycle) were never score-comparable anyway; the prompt change just makes that visible.

The SPEC §3.3 sentence is updated to: *"the exact wording should be fixed across all models within a single benchmark cycle for fairness; cross-cycle comparisons are only meaningful when `duration_hours` matches."*

### Leak detector fix (required to land with this change)

[`detectLeaks`](../../../harness/orchestrator/prompt.ts:184) currently does substring containment for the seed:

```ts
if (seedStr.length >= 3 && text.includes(seedStr))
```

With `total_duration_seconds=86400` rendered into the prompt, any seed that is a digit-substring of `86400` (e.g. `8640`, `6400`, `8400`) would falsely trip the detector and fail the run via [loop.ts:215 `onFatal`](../../../harness/orchestrator/loop.ts:215).

Fix: change the seed check to a word-boundary match, mirroring the forbidden-token detector immediately above it (lines 180–183). Same intent — a seed embedded as a substring of an unrelated number isn't a real leak.

```ts
const seedStr = String(seed);
if (seedStr.length >= 3) {
  const re = new RegExp(`\\b${seedStr}\\b`);
  if (re.test(text)) hits.push(`seed:${seedStr}`);
}
```

This generalizes the existing fix made for forbidden tokens (`getAugmentations` not tripping `augment`).

## Components touched

| Unit | Change |
|---|---|
| [SPEC.md §3.1](../../../SPEC.md) | Add `total_duration_seconds` field to input schema. |
| [SPEC.md §3.3](../../../SPEC.md) | Templatize prompt wording. Add fairness-scope note. |
| [harness/types.ts](../../../harness/types.ts) | Add `total_duration_seconds: number` to `OrchestratorInput`. |
| [harness/orchestrator/loop.ts](../../../harness/orchestrator/loop.ts) | Populate the field in `assembleInput()`. Source: `config.duration_hours * 3600`, or the `BENCHBURNER_DURATION_SEC` override when present (already plumbed via `effectiveDurationSec` at [index.ts:45](../../../harness/index.ts:45) — needs to flow through to the loop). |
| [harness/orchestrator/prompt.ts](../../../harness/orchestrator/prompt.ts) | Convert `ORCHESTRATOR_SYSTEM_PROMPT` from a const string to a function `buildSystemPrompt(durationHours: number)`. Substitute the number. Update `buildOrchestratorPrompt` accordingly. Fix `detectLeaks` seed check to word-boundary. |
| [harness/index.ts](../../../harness/index.ts) | Pass `effectiveDurationSec` (or its hour-equivalent) into the loop so the prompt builder and `assembleInput` agree on duration. |

## Tests to add / update

- **`prompt.test.ts`** — verify rendered system prompt substitutes `duration_hours` (test at 24, 1, and a non-integer-hour smoke value).
- **`prompt.test.ts`** — leak detector: seed `8640` against a prompt containing `86400` should NOT trigger; seed `8640` against a prompt with bare `8640` SHOULD trigger.
- **`loop.test.ts`** — `assembleInput()` populates `total_duration_seconds` from the configured duration, and respects `BENCHBURNER_DURATION_SEC` override.
- **Existing tests** that pin the literal "24-hour" prompt string are updated to use the templated form.

## Out of scope

- Telling subagents about time. (Discussed and rejected above.)
- Promoting snapshot `hour` to the orchestrator input. (Redundant.)
- Adding `time_remaining_seconds` as a derived convenience field. (Redundant.)
- Adding noise / soft-deadline ambiguity to better simulate real-world managers. (May revisit if all top models converge on identical end-game behavior; not a problem yet.)

## Open questions

None expected to require design re-litigation. Implementation-level details (exact function signature for `buildSystemPrompt`, where in the index→loop→prompt chain duration is plumbed) belong in the implementation plan, not here.
