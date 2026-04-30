# Orchestrator Time Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured run-duration awareness to the orchestrator's input and templatize the system prompt's hard-coded "24-hour window" so it tracks the run's real duration.

**Architecture:** One new field (`total_duration_seconds`) on the §3.1 `OrchestratorInput`, plumbed from the harness's existing `effectiveDurationSec`. The §3.3 system prompt is converted from a const to a function that reads duration from the input and substitutes a formatted hours value into a single string position. The leak detector's seed check is tightened from substring containment to word-boundary match so duration values can't false-trigger. Subagents are not modified — they remain time-blind by design.

**Tech Stack:** TypeScript (Node.js ≥ 20), tsx for direct execution. No formal test framework; the project uses standalone smoke scripts via tsx (pattern: `harness/game/rfa-smoke.ts`). The smoke script for this change lives at `harness/orchestrator/time-awareness-smoke.ts` and is run with `npx tsx`.

**Spec source:** [docs/superpowers/specs/2026-04-30-orchestrator-time-awareness-design.md](../specs/2026-04-30-orchestrator-time-awareness-design.md)

---

## File Structure

| File | Disposition | Responsibility |
|---|---|---|
| `SPEC.md` | Modify (§3.1, §3.3) | Update input schema + prompt template + fairness-scope note. |
| `harness/types.ts` | Modify (line ~117) | Add `total_duration_seconds: number` to `OrchestratorInput`. |
| `harness/orchestrator/prompt.ts` | Modify (lines 12, 78–82, 184) | Replace const `ORCHESTRATOR_SYSTEM_PROMPT` with `buildSystemPrompt(totalDurationSeconds)`. Add `formatDurationHours` helper. Use it from `buildOrchestratorPrompt`. Tighten `detectLeaks` seed check. |
| `harness/orchestrator/index.ts` | Modify (line 3) | Update re-export from `ORCHESTRATOR_SYSTEM_PROMPT` to `buildSystemPrompt`. |
| `harness/orchestrator/loop.ts` | Modify (LoopOptions, assembleInput) | Accept `totalDurationSeconds` in `LoopOptions`. Populate `total_duration_seconds` in `assembleInput`. |
| `harness/index.ts` | Modify (line ~150) | Pass `effectiveDurationSec` into `OrchestratorLoop` constructor. |
| `harness/orchestrator/time-awareness-smoke.ts` | Create | Standalone smoke that exercises: prompt templating at 3 durations, leak-detector seed/duration collision, `assembleInput` field population. |

No new directories. No new dependencies.

---

## Task 1: Update SPEC.md (§3.1 input schema, §3.3 prompt + fairness)

**Files:**
- Modify: `SPEC.md` lines 186–187 (§3.1 input JSON example)
- Modify: `SPEC.md` line 233 (§3.3 fairness sentence)
- Modify: `SPEC.md` line 240 (§3.3 prompt skeleton "24-hour window")

- [ ] **Step 1: Update §3.1 input schema example**

In `SPEC.md`, locate the JSON block in `### 3.1 Input to Orchestrator Model`. Replace lines 186–188:

```diff
   "cycle_number": 42,
   "elapsed_time_seconds": 10800,
+  "total_duration_seconds": 86400,
   "game_state": {
```

(`total_duration_seconds` is the run's effective duration in seconds; `config.duration_hours * 3600` unless overridden by the dev-only `BENCHBURNER_DURATION_SEC` env var.)

- [ ] **Step 2: Update §3.3 fairness sentence**

In `SPEC.md` line 233, replace:

> The harness wraps each cycle's input JSON in a system + user prompt. The exact wording should be fixed across all benchmarked models for fairness.

with:

> The harness wraps each cycle's input JSON in a system + user prompt. The exact wording should be fixed across all benchmarked models within a single benchmark cycle for fairness; the only run-dependent substitution is the `{N}-hour window` token in the skeleton below, which is replaced with the run's effective duration in hours (integer for whole-hour runs, up to 2 decimal places with trailing zeros trimmed for fractional-hour runs). Cross-cycle comparisons are only meaningful when `duration_hours` matches.

- [ ] **Step 3: Update §3.3 prompt skeleton literal**

In `SPEC.md` line 240, replace:

```
maximize the team's in-game money in the 24-hour window.
```

with:

```
maximize the team's in-game money in the {N}-hour window.
```

(Only this one line in the skeleton block changes — every other line stays exactly as it is.)

- [ ] **Step 4: Commit**

```bash
git add SPEC.md
git commit -m "spec: add total_duration_seconds to §3.1, templatize §3.3 prompt"
```

---

## Task 2: Add type field, plumb effectiveDurationSec, populate in assembleInput

**Files:**
- Modify: `harness/types.ts:117` (OrchestratorInput interface)
- Modify: `harness/orchestrator/loop.ts` (LoopOptions, constructor field, assembleInput)
- Modify: `harness/index.ts:137-150` (pass effectiveDurationSec into OrchestratorLoop)
- Create: `harness/orchestrator/time-awareness-smoke.ts` (smoke script with first assertion)

- [ ] **Step 1: Write the failing smoke (assertion targets behavior that doesn't exist yet)**

Create `harness/orchestrator/time-awareness-smoke.ts` with the following content. Note this file imports types and helpers that this task will add; it WILL fail to compile until Steps 2–6 land. That's the "failing test" state.

```ts
/**
 * Time-awareness smoke (2026-04-30 design).
 *
 * Standalone, no game boot. Exercises:
 *   (1) OrchestratorLoop.assembleInput populates total_duration_seconds.
 *   (2) buildOrchestratorPrompt substitutes the duration into the §3.3
 *       prompt template at multiple horizons, including fractional hours.
 *   (3) detectLeaks does NOT false-fire when the seed string is a digit
 *       substring of total_duration_seconds (the 8640/86400 collision).
 *
 * Run:  npx tsx harness/orchestrator/time-awareness-smoke.ts
 * Exit: 0 on all assertions passing, 1 on any failure.
 */

import { buildOrchestratorPrompt, detectLeaks, buildSystemPrompt, formatDurationHours } from "./prompt";
import type { OrchestratorInput } from "../types";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`[smoke] FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`[smoke] OK: ${msg}`);
}

function makeInput(totalDurationSeconds: number, elapsedSeconds = 0): OrchestratorInput {
  return {
    cycle_number: 1,
    elapsed_time_seconds: elapsedSeconds,
    total_duration_seconds: totalDurationSeconds,
    game_state: { current_money: 0, bitnode_id: 1, bitnode_complete: false },
    subagent_status: [],
    delegation_history: [],
    available_subagent_models: ["test-model"],
  };
}

function main(): void {
  // ── (1) Type-level: OrchestratorInput accepts total_duration_seconds ──
  const input24h = makeInput(86400);
  assert(input24h.total_duration_seconds === 86400, "OrchestratorInput carries total_duration_seconds=86400");
}

main();
console.log("[smoke] all assertions passed");
```

- [ ] **Step 2: Run the smoke; verify it fails**

```bash
npx tsx harness/orchestrator/time-awareness-smoke.ts
```

Expected: a TypeScript error about `total_duration_seconds` not being a known property of `OrchestratorInput`, OR about `buildSystemPrompt` / `formatDurationHours` not being exported. Either is the "red" state we want.

- [ ] **Step 3: Add the field to the OrchestratorInput type**

In `harness/types.ts`, locate the `OrchestratorInput` interface (around line 117) and add the field directly after `elapsed_time_seconds`:

```ts
export interface OrchestratorInput {
  cycle_number: number;
  elapsed_time_seconds: number;
  total_duration_seconds: number;
  game_state: GameState;
  subagent_status: SubagentStatus[];
  delegation_history: Array<{ instruction: Instruction; result: Result | null }>;
  /** Rolling summary of cycles older than `history_window`, if any. */
  delegation_history_summary?: string;
  available_subagent_models: string[];
}
```

- [ ] **Step 4: Add `totalDurationSeconds` to LoopOptions and store it on the loop**

In `harness/orchestrator/loop.ts`, modify `LoopOptions` (around line 90) to require the new field:

```ts
export interface LoopOptions {
  run_id: string;
  config: RunConfig;
  bus: Bus;
  db: Db;
  game: GameController;
  pool: SubagentPool;
  registry: InferenceRegistry;
  /** Total run duration in seconds (config.duration_hours * 3600 unless
   *  BENCHBURNER_DURATION_SEC override is in effect). Single source of
   *  truth shared with the §3.3 prompt template substitution. */
  totalDurationSeconds: number;
  /** Directory where orchestrator-prompts.log is appended. */
  logDir: string;
  /** Called on fatal conditions (hang, inference model missing). */
  onFatal(reason: string): void;
}
```

In the same file, add a private field on the class (around line 119, alongside `logDir`):

```ts
  private readonly logDir: string;
  private readonly totalDurationSeconds: number;
  private readonly onFatal: (reason: string) => void;
```

In the constructor (around line 146), assign it:

```ts
    this.logDir = opts.logDir;
    this.totalDurationSeconds = opts.totalDurationSeconds;
    this.onFatal = opts.onFatal;
```

- [ ] **Step 5: Populate `total_duration_seconds` in assembleInput**

In `harness/orchestrator/loop.ts`, locate `assembleInput()` (around line 279) and add the field to the returned object:

```ts
    return {
      cycle_number: this.cycle,
      elapsed_time_seconds: elapsedSeconds,
      total_duration_seconds: this.totalDurationSeconds,
      game_state: this.latestState ?? { current_money: 0, bitnode_id: 1, bitnode_complete: false },
      subagent_status,
      delegation_history: verbatim,
      delegation_history_summary: summary,
      available_subagent_models: [...this.config.subagent_roster],
    };
```

- [ ] **Step 6: Pass effectiveDurationSec from index.ts into the loop**

In `harness/index.ts`, locate the `OrchestratorLoop` construction (around line 137) and add the new field. The variable `effectiveDurationSec` is already in scope from line 45.

```ts
  const loop = new OrchestratorLoop({
    run_id: config.run_id,
    config,
    bus,
    db,
    game,
    pool,
    registry,
    totalDurationSeconds: effectiveDurationSec,
    logDir: runDir,
    onFatal: (reason) => {
      if (!fatal) fatal = reason;
      console.error(`[harness] fatal: ${reason}`);
    },
  });
```

- [ ] **Step 7: Stub `buildSystemPrompt` and `formatDurationHours` exports so the smoke compiles**

To keep the smoke green at the end of this task without splitting one logical typecheck failure across two tasks, add temporary stubs in `harness/orchestrator/prompt.ts`. Task 3 fills them in.

At the end of `harness/orchestrator/prompt.ts`, append:

```ts
export function formatDurationHours(seconds: number): string {
  const hours = seconds / 3600;
  if (Number.isInteger(hours)) return String(hours);
  return hours.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * STUB — Task 3 replaces ORCHESTRATOR_SYSTEM_PROMPT with this and
 * substitutes the duration into the prompt body.
 */
export function buildSystemPrompt(totalDurationSeconds: number): string {
  void totalDurationSeconds;
  return ORCHESTRATOR_SYSTEM_PROMPT;
}
```

- [ ] **Step 8: Typecheck and run the smoke**

```bash
npm run typecheck
npx tsx harness/orchestrator/time-awareness-smoke.ts
```

Expected typecheck: clean.
Expected smoke output: `[smoke] OK: OrchestratorInput carries total_duration_seconds=86400` and `[smoke] all assertions passed`. Exit code 0.

- [ ] **Step 9: Commit**

```bash
git add harness/types.ts harness/orchestrator/loop.ts harness/index.ts harness/orchestrator/prompt.ts harness/orchestrator/time-awareness-smoke.ts
git commit -m "feat(orchestrator): plumb total_duration_seconds into §3.1 input"
```

---

## Task 3: Templatize the §3.3 system prompt on the run's effective duration

**Files:**
- Modify: `harness/orchestrator/prompt.ts` (lines 12–39, 78, 82, plus end-of-file stubs from Task 2)
- Modify: `harness/orchestrator/index.ts:3` (re-export rename)
- Modify: `harness/orchestrator/time-awareness-smoke.ts` (add prompt-templating assertions)

- [ ] **Step 1: Add failing smoke assertions for prompt templating**

Edit `harness/orchestrator/time-awareness-smoke.ts`. Append the following to `main()` after the existing `assert` line:

```ts
  // ── (2) buildSystemPrompt substitutes duration into the §3.3 template ──
  const sys24 = buildSystemPrompt(86400);
  assert(sys24.includes("the 24-hour window"), "24h prompt contains 'the 24-hour window'");
  assert(!sys24.includes("the 1-hour window"), "24h prompt does not contain '1-hour window'");

  const sys1 = buildSystemPrompt(3600);
  assert(sys1.includes("the 1-hour window"), "1h prompt contains 'the 1-hour window'");
  assert(!sys1.includes("the 24-hour window"), "1h prompt does not contain '24-hour window'");

  const sysHalf = buildSystemPrompt(1800);
  assert(sysHalf.includes("the 0.5-hour window"), "30min prompt contains 'the 0.5-hour window'");

  const sys10min = buildSystemPrompt(600);
  assert(sys10min.includes("the 0.17-hour window"), "10min prompt contains 'the 0.17-hour window'");

  // ── (2a) formatDurationHours edge cases ──
  assert(formatDurationHours(86400) === "24", "formatDurationHours(86400)=24");
  assert(formatDurationHours(3600) === "1", "formatDurationHours(3600)=1");
  assert(formatDurationHours(1800) === "0.5", "formatDurationHours(1800)=0.5");
  assert(formatDurationHours(600) === "0.17", "formatDurationHours(600)=0.17");
  assert(formatDurationHours(7200) === "2", "formatDurationHours(7200)=2 (integer hour stays integer)");

  // ── (2b) buildOrchestratorPrompt uses input.total_duration_seconds ──
  const built = buildOrchestratorPrompt(makeInput(3600), 8675309);
  assert(built.system.includes("the 1-hour window"), "buildOrchestratorPrompt routes input.total_duration_seconds into prompt");
  assert(built.leak_check_violations.length === 0, "leak detector clean for benign 1h prompt");
```

- [ ] **Step 2: Run the smoke; verify the new assertions fail**

```bash
npx tsx harness/orchestrator/time-awareness-smoke.ts
```

Expected: failure on the first new assertion (`24h prompt contains 'the 24-hour window'` will pass for the wrong reason — the stub returns the const which still has "24-hour" hardcoded — but `1h prompt contains 'the 1-hour window'` will fail). Either way, at least one of the new assertions reports FAIL.

- [ ] **Step 3: Replace `ORCHESTRATOR_SYSTEM_PROMPT` with `buildSystemPrompt`**

In `harness/orchestrator/prompt.ts`, replace lines 10–39 (the `export const ORCHESTRATOR_SYSTEM_PROMPT = \`...\`;` block) with a function. The body MUST preserve every word and paragraph of the existing prompt; only the literal `24-hour` is templated.

Delete the existing `export const ORCHESTRATOR_SYSTEM_PROMPT = \`...\`;` and the temporary stub `buildSystemPrompt` from Task 2. Replace with:

```ts
/**
 * Builds the §3.3 system prompt. The only run-dependent substitution
 * is the duration in `the {N}-hour window` near the top — every other
 * word is fixed across all benchmarked models within a single
 * benchmark cycle (see SPEC §3.3 fairness note).
 */
export function buildSystemPrompt(totalDurationSeconds: number): string {
  const horizon = formatDurationHours(totalDurationSeconds);
  return `You are the orchestrator of a team of subagent coders. You cannot play the game yourself. You cannot edit the code your subagents write. Your job is to decide which subagents to spawn, which to kill, and what instructions to give them. Your team is playing a game. Your goal is to maximize the team's in-game money in the ${horizon}-hour window.

Runtime environment (infrastructure, not strategy): your team's code executes in a sandboxed JavaScript runtime on a host with ~8 GB of memory, of which the harness itself is using about 4.9 GB for its process bookkeeping — leaving approximately 3 GB for the scripts your subagents write. Every ns.* API call has a static RAM cost that counts against that 3 GB at compile time; if a script's declared calls exceed the budget, the runtime refuses to start it and you'll see "ns.run returned 0 — script missing or RAM budget exceeded" in the execution result. Cheap calls include ns.hack, ns.weaken, ns.grow (~0.1-0.2 GB each) and the individual ns.getServerX getters. Expensive calls like ns.getServer (2 GB) and ns.hackAnalyzeChance (1 GB) eat the budget fast. Instruct your team accordingly.

Scripts take the form "export async function main(ns) { ... }" where ns is the API object the environment provides. When you instruct your subagents, tell them what you want the code to DO; do not tell them which language to use — they already know it must be JavaScript targeting this ns-based runtime.

Committed-script lifecycle: each subagent maintains exactly one committed script at a time. When a subagent returns a new final code, that code runs indefinitely (until run-end) and any previous committed script from the same subagent is automatically killed. Short-lived diagnostic scripts that exit quickly are fine; long-running earning scripts stay alive and accumulate money into game_state. So you can use one subagent as a long-running worker and simply replace its script when you want new behavior.

You can only observe what your subagents report back, plus periodic game state snapshots from the backend. You have no other visibility. Execution feedback includes stdout / stderr / exit_reason / money_gained — use them to route around broken subagent output.

Respond ONLY with a JSON object matching this schema:
{
  "actions": [
    {
      "action_type": "spawn" | "kill" | "instruct" | "noop",
      "subagent_id": "string (required for kill/instruct; you choose a new id for spawn)",
      "model_choice": "string (required for spawn; must be from available_subagent_models)",
      "instruction": {
        "task": "string",
        "context": "string",
        "constraints": { "token_budget": number, "max_script_size_lines": number }
      }
    }
  ],
  "reasoning": "string (free-form)"
}

No prose outside the JSON.`;
}
```

`formatDurationHours` (already added in Task 2 Step 7) stays where it is.

- [ ] **Step 4: Update `buildOrchestratorPrompt` to call `buildSystemPrompt` from input**

In `harness/orchestrator/prompt.ts`, replace the body of `buildOrchestratorPrompt` (lines 74–86) so it sources the system prompt from the input's duration instead of the deleted const:

```ts
export function buildOrchestratorPrompt(input: OrchestratorInput, seed: number): BuildPromptResult {
  const scrubbed = scrubInput(input);
  const user = JSON.stringify(scrubbed, null, 2);
  const system = buildSystemPrompt(input.total_duration_seconds);

  const full = system + "\n" + user;
  const violations = detectLeaks(full, seed);

  return {
    system,
    user,
    leak_check_violations: violations,
  };
}
```

- [ ] **Step 5: Update the re-export in `harness/orchestrator/index.ts`**

Change line 3 from:

```ts
export { buildOrchestratorPrompt, detectLeaks, ORCHESTRATOR_SYSTEM_PROMPT, FORBIDDEN_TOKENS } from "./prompt";
```

to:

```ts
export { buildOrchestratorPrompt, buildSystemPrompt, detectLeaks, FORBIDDEN_TOKENS, formatDurationHours } from "./prompt";
```

- [ ] **Step 6: Typecheck and run the smoke**

```bash
npm run typecheck
npx tsx harness/orchestrator/time-awareness-smoke.ts
```

Expected typecheck: clean.
Expected smoke: all assertions through the end of section (2b) report `OK`, and the final `[smoke] all assertions passed` line prints. Exit code 0.

- [ ] **Step 7: Commit**

```bash
git add harness/orchestrator/prompt.ts harness/orchestrator/index.ts harness/orchestrator/time-awareness-smoke.ts
git commit -m "feat(orchestrator): templatize §3.3 prompt on run duration"
```

---

## Task 4: Tighten detectLeaks seed check to word-boundary

**Files:**
- Modify: `harness/orchestrator/prompt.ts:184-187` (`detectLeaks` seed check)
- Modify: `harness/orchestrator/time-awareness-smoke.ts` (add leak-detector assertions)

- [ ] **Step 1: Write failing smoke assertions for the seed/duration collision**

Edit `harness/orchestrator/time-awareness-smoke.ts`. Append the following to `main()` after the existing assertions:

```ts
  // ── (3) detectLeaks: seed digit-substring of duration must NOT fire ──
  // 86400 contains "8640" as a substring. Pre-fix detector trips here.
  const promptWith86400 = "the 24-hour window total_duration_seconds: 86400";
  assert(
    detectLeaks(promptWith86400, 8640).length === 0,
    "seed 8640 not flagged as leaking when 86400 appears (word-boundary required)",
  );

  // 3600 contains "360" as a substring; same shape.
  const promptWith3600 = "the 1-hour window total_duration_seconds: 3600";
  assert(
    detectLeaks(promptWith3600, 360).length === 0,
    "seed 360 not flagged when 3600 appears",
  );

  // Real seed leak (word-boundary match): bare seed in prose.
  const promptWithBareSeed = "the 24-hour window debug seed=8640 ok";
  const violations = detectLeaks(promptWithBareSeed, 8640);
  assert(
    violations.includes("seed:8640"),
    "bare seed token 8640 IS flagged",
  );

  // Seed embedded inside another digit string of the same length: still
  // a substring, so word-boundary blocks it. Defensible — false positives
  // were the regression risk.
  const promptWithSeedInsideNumber = "value=186402 ok";
  assert(
    detectLeaks(promptWithSeedInsideNumber, 8640).length === 0,
    "seed 8640 not flagged when embedded inside 186402",
  );

  // Short seeds (< 3 digits) remain exempt — pre-existing policy.
  const promptWithShortSeed = "value=42 here";
  assert(
    detectLeaks(promptWithShortSeed, 42).length === 0,
    "short seed (<3 chars) still exempt from leak check",
  );
```

- [ ] **Step 2: Run the smoke; verify the new assertions fail**

```bash
npx tsx harness/orchestrator/time-awareness-smoke.ts
```

Expected: failure on the first new assertion — the pre-fix `text.includes(seedStr)` matches `8640` inside `86400` and reports a leak.

- [ ] **Step 3: Tighten the seed check in `detectLeaks`**

In `harness/orchestrator/prompt.ts`, locate `detectLeaks` (around line 171) and replace lines 184–187:

```ts
  const seedStr = String(seed);
  if (seedStr.length >= 3) {
    // Word-boundary match mirrors the forbidden-token loop above:
    // a seed embedded as a digit-substring of an unrelated number
    // (e.g. 8640 inside total_duration_seconds=86400) is not a real
    // leak. Without this, the new total_duration_seconds field would
    // false-trigger the detector for entire classes of seed values
    // and fail runs at SPEC §3.3 leak audit.
    const re = new RegExp(`\\b${seedStr}\\b`);
    if (re.test(text)) hits.push(`seed:${seedStr}`);
  }
```

- [ ] **Step 4: Typecheck and run the smoke**

```bash
npm run typecheck
npx tsx harness/orchestrator/time-awareness-smoke.ts
```

Expected typecheck: clean.
Expected smoke: every assertion reports `OK`, including all leak-detector cases. Final `[smoke] all assertions passed` prints. Exit code 0.

- [ ] **Step 5: Commit**

```bash
git add harness/orchestrator/prompt.ts harness/orchestrator/time-awareness-smoke.ts
git commit -m "fix(orchestrator): word-boundary seed check in detectLeaks"
```

---

## Task 5: Final verification — typecheck, full smoke, no other regressions

**Files:** none modified by default; only changes if Steps 2–4 surface a regression.

- [ ] **Step 1: Run the full typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 2: Run the time-awareness smoke**

```bash
npx tsx harness/orchestrator/time-awareness-smoke.ts
```

Expected: every assertion `OK`, final line `[smoke] all assertions passed`, exit code 0.

- [ ] **Step 3: Confirm no other consumers reference `ORCHESTRATOR_SYSTEM_PROMPT`**

```bash
grep -rn "ORCHESTRATOR_SYSTEM_PROMPT" --include="*.ts" --include="*.md" .  | grep -v node_modules | grep -v dist | grep -v bitburner
```

Expected: zero matches in source. (The string lives only in the now-deleted const; if anything still references it, that's a regression introduced by this plan and must be fixed before the task is marked complete.)

If any matches appear in `.ts` files, update them to call `buildSystemPrompt(...)` with the appropriate duration. If any appear in `.md` files outside `docs/superpowers/specs/`, update or remove the reference and re-run from Step 1.

- [ ] **Step 4: Confirm no other tests/scripts pin the literal "24-hour window"**

```bash
grep -rn "24-hour window" --include="*.ts" --include="*.md" .  | grep -v node_modules | grep -v dist | grep -v bitburner | grep -v docs/superpowers
```

Expected: zero matches in source/tests. (The phrase remains in the design doc and the spec — those are intended.)

If any matches appear in `.ts` source or test files, replace with `buildSystemPrompt(...).includes(...)`-style reads or remove. Re-run from Step 1.

- [ ] **Step 5: If any changes were made in Steps 3 or 4, commit them**

```bash
git status
# If anything is modified:
git add <files>
git commit -m "fix: remove stale references to ORCHESTRATOR_SYSTEM_PROMPT / hardcoded 24-hour"
```

If nothing changed, skip this step.

---

## Out of scope (do not implement)

- `time_remaining_seconds` derived field on `OrchestratorInput`. Redundant once `total_duration_seconds` and `elapsed_time_seconds` are both present.
- Time information for subagents (`Instruction` shape unchanged). The orchestrator's job is to communicate horizon downward via `instruction.context`.
- Promoting the snapshot `hour` index into `OrchestratorInput`. Already encoded by `elapsed_time_seconds` + `total_duration_seconds`.
- Any change to `README.md` or `SPEC.md`'s ASCII diagram references to "24-hour Run Harness" — those describe the default benchmark cycle, not the prompt.
- Adding a formal test framework. The project's existing pattern is standalone smoke scripts via `tsx`; this plan follows it.
