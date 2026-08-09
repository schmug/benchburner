# Script Lifecycle and Per-Subagent Attribution — Design

**Date:** 2026-08-09
**Status:** Approved, ready for implementation plan

## What this benchmark measures

**How well an orchestrator instructs subagents at coding.** Not team
management in the abstract — specifically, whether a model can turn a
goal into instructions that cause *other* models to produce working
code, and whether it can tell a good outcome from a bad one and adjust.

That framing decides what matters here. If the measured skill is
instruction quality, the orchestrator's feedback channel is not a
convenience — it is the instrument. An orchestrator that cannot observe
whether its instruction produced running, earning code is not being
measured on instruction quality at all. It is being scored on a guess.

## Problem

Every benchmarked run plants on the starting-money floor ($1,262) except
one, and that exception turns out not to be an orchestration result.

### Evidence 1 — the feedback loop cannot close in a short run

Measured on run `6ab9c0a3` (Opus 5 orchestrator, Sonnet 5 subagents,
480-second window). Subagent round trips, dispatch → result:

| cycle | subagent | round trip |
|---|---|---|
| 2 | scout | 200s |
| 2 | earner1 | 259s |
| 3 | earner2 | never returned |
| 5 | earner3 | 35s |

A *full* loop is longer than a round trip: instruct → subagent writes
code → harness commits → script runs → orchestrator observes the outcome
on its next cycle. Call it ~300s. At the canonical 20-minute duration
that is **about four closed loops**, the first arriving after a quarter
of the run has already elapsed.

CLAUDE.md already concedes the consequence — "a 20-minute window cannot
observe re-planning at all" — but frames it as a reason to also run
endurance tests, rather than as a limit on what the canonical number can
mean.

### Evidence 2 — given a long run, the loop went unused

Run `09521fa2` (claude-sonnet-4.6, 23.9 hours, `final_money` $2,022,061)
is the only run that ever escaped the floor. What it actually did:

- **one** subagent, `worker-1`, for all **1,430** delegations
- an instruction every **60 seconds** — every cycle, for 24 hours
- only **16 distinct code bodies** across all 1,430 results
- the identical four-line script
  `export async function main(ns) { while (true) { await ns.hack('foodnstuff'); } }`
  committed **1,020 times**, from 2026-04-29T15:29Z to 2026-04-30T08:35Z

Because committing replaces a subagent's running script, the
orchestrator killed and restarted its own earning script roughly once a
minute for seventeen hours. The $2M came from a four-line script and a
long clock, *despite* the orchestration rather than because of it.

The behaviour was rational given what the orchestrator could see:
nothing. It had no signal that `worker-1`'s script was alive or earning,
so every cycle it re-issued. This is the failure mode the design must
remove.

### Root causes

Three lifecycle defects and one missing channel.

1. **`instruct` silently destroys a working script.** `onResult` ends
   with an unconditional "on success, submit the script to the game" →
   `executeScript`. Committing evicts the subagent's prior committed
   script. The orchestrator therefore cannot give an instruction without
   risking its income, and has no way to express "keep what is running".

2. **`kill` does not kill the script.** `handleKill` calls
   `pool.kill(subagent_id)` and `subagentTracks.delete(subagent_id)` and
   touches the game not at all. The committed script keeps running, keeps
   consuming the RAM budget, and keeps earning — while the orchestrator
   deletes the only record it had of it. An orphan.

   Together with (1), both lifecycle verbs are backwards: `instruct`
   kills a script you wanted to keep, `kill` spares one you wanted to
   stop.

3. **No per-subagent earning signal.** `/__state.json` carries only
   `current_money`, `bitnode_id`, `bitnode_complete`,
   `augments_installed`, `last_heartbeat_ms`, `timestamp`. Nothing about
   running scripts. `ExecutionResult.money_gained` (`dispatcher.js:210`)
   is a *global* player delta, `endMoney - startMoney`, so it cannot
   attribute earnings to a subagent when several scripts run at once.

   The per-script figure already exists: `dispatcher.js:172` emits
   `online_money_made` from `ns.getRunningScript(pid)`. It is simply
   never written into the state export, and never surfaced.

A related fix already landed on this branch: committed-script *outcomes*
(`exit_reason`, `stderr`) now reach the orchestrator via
`SubagentStatus.last_execution`. That answers *did it start*. It does not
answer *is it still earning*, which is what (3) covers.

## Non-goals

- **Loop latency.** Shortening the ~250s subagent round trip is the other
  half of the problem and is deliberately out of scope. This design makes
  the loop *usable*; a later change makes it *faster*.
- **Accept/reject.** CLAUDE.md constraint 2 says the orchestrator
  "accepts or rejects whole results"; it currently cannot do either,
  since every successful result auto-commits. Implementing a real
  accept/reject adds a full cycle of latency to a loop that already
  closes only ~4 times per run. Revisit once latency is addressed.
- **Changing what the orchestrator knows about the game.** The
  knowledge-vs-fairness question (whether to name the game, or give every
  orchestrator an identical mechanics briefing) is a separate decision.
- **Re-baselining published runs.** Noted below, not performed here.

## Design

### 1. Explicit replace

`OrchestratorAction` gains `replace?: boolean`, **defaulting to
`false`**. When a subagent's result is committed, its prior committed
script is killed only if the originating action carried `replace: true`.

**It lives on the action, not on `Instruction`.** `Instruction` is the
message the *subagent* receives, and script lifecycle is a directive to
the harness — the subagent does not need it to write the code. Keeping
it off `Instruction` also keeps SPEC §2.1's subagent contract unchanged.
If the distinction ever matters to the code being written (RAM sharing,
port conflicts), the orchestrator can say so in `context`, which is the
channel intended for exactly that.

**Ordering is load-bearing: kill only after the replacement is
confirmed running.** Killing first and then failing to start the new
script loses the income *and* gains nothing — reproducing the very
failure this design exists to remove. With `replace: true` the sequence
is submit → run → confirm started → only then evict the predecessor. If
the new script cannot start, the old one keeps running and the
orchestrator sees `failed_to_start`.

**Probe runs are unaffected.** The write-run-observe iterations inside a
subagent are ephemeral (`kind: "probe"`) and never occupy the committed
slot, so `replace` does not apply to them.

The default is `false` because the two failure modes are asymmetric:

- **Accumulating scripts** exhaust the ~3 GB budget, the runtime refuses
  to start the new one, and the orchestrator sees `failed_to_start` with
  "RAM budget exceeded" — a loud, attributable, already-visible failure.
- **Killing an earner** produces no event at all. Income simply stops.
  That is the failure that ran for seventeen hours undetected.

Prefer the loud failure. A confused orchestrator now hits a wall it can
see instead of quietly dismantling its own income.

### 2. `kill` kills the script

`handleKill` additionally stops the subagent's committed script in the
game before dropping the track, so no orphan can outlive its owner.

No separate "retire the worker, keep its script" verb. An idle subagent
costs nothing until instructed, so that case is simply *not instructing
it* — the strategy remains available without new surface area.

### 3. Per-subagent live earnings

Extend the dispatcher's state write to enumerate running committed
scripts. For each: `subagent_id`, `online_money_made`, `ram`,
`uptime_seconds`. The dispatcher already holds the pid→task map and
already calls `ns.getRunningScript`, so this is a write-side change, not
new instrumentation.

Surface it per subagent on `SubagentStatus`, beside `last_execution`:

```ts
/** Live state of this subagent's committed script, refreshed each snapshot. */
export interface LiveScript {
  running: boolean;
  money_made: number;      // this script's own earnings, not a global delta
  ram: number;
  uptime_seconds: number;
}
```

`last_execution` answers *did my instruction produce a script that
started*. `LiveScript` answers *is it still earning*. Instruction quality
is not observable without both.

### 4. Prompt

The §3.3 system prompt gains, in the existing committed-script-lifecycle
paragraph:

- that a new script runs **alongside** the subagent's current one unless
  the instruction sets `replace: true`, and that the RAM budget is shared
- that `kill` stops the subagent's script as well
- that per-subagent earnings are visible, so "which of my instructions
  actually worked" is answerable

Wording stays fixed across models, per §3.3 fairness.

## Schema changes

| File | Change |
|---|---|
| `harness/types.ts` | `OrchestratorAction.replace?: boolean`; new `LiveScript`; `SubagentStatus.live_script?: LiveScript \| null` |
| `harness/orchestrator/loop.ts` | Honour `replace` when committing; kill the script in `handleKill`; thread `live_script` into `assembleInput` |
| `harness/orchestrator/prompt.ts` | Lifecycle paragraph; **scrub `live_script` if it gains free text** (see below) |
| `harness/game/dispatcher.js` | Write running-script stats into `/__state.json`; support killing a subagent's committed script |
| `harness/game/puppeteer.ts` | `killScript(subagent_id)` on the game controller |
| `harness/types.ts` (`GameController`) | Add `killScript` |
| `SPEC.md` | §2.1 instruction schema, §3.1 input schema, §3.3 prompt |

**Leak-policy note.** `scrubInput` builds `SubagentStatus` with a spread,
so any field added to it reaches the model **unscrubbed** unless handled
explicitly. `LiveScript` is numeric and boolean only, so it needs no
scrubbing today — but if it ever gains a string (a script name, an error),
it must be added to the scrub. A comment at the spread already warns of
this.

## Testing

Follow the suite added on this branch (`node:test` via `tsx`, 68 tests).
The older specs' claim that the project has "no formal test framework" is
out of date.

1. **`replace: false` leaves the running script alive** — commit a second
   script for the same subagent without `replace`; assert the first is
   still running.
2. **`replace: true` kills the prior script** — same, asserting eviction.
3. **Default is `false`** — an instruction that omits the field must not
   evict. This is the regression guard for the 1,020-restart failure.
3b. **`replace: true` that fails to start keeps the predecessor** — the
   ordering guarantee. Commit a replacement whose declared RAM exceeds
   the budget; assert the original is still running and the orchestrator
   sees `failed_to_start`.
4. **`kill` stops the script** — assert the game is told, and no orphan
   remains.
5. **Per-subagent earnings reach the prompt** — assert against the
   prompt the loop actually builds, not an internal, matching
   `test/orchestrator/execution-feedback.test.ts`.
6. **End-to-end** — a real Bitburner run where a subagent's script earns,
   is re-instructed without `replace`, and keeps earning across the
   boundary.

## Comparability

This changes scoring semantics. All 86 published runs used implicit
replace, and their numbers are not comparable to anything produced after
this lands — the same rule CLAUDE.md already applies to the 20-minute vs
24-hour split.

Add a dated section to VALIDATION.md, mirroring the existing
snapshot-cadence break, recording that runs before this date ran under
implicit-replace with no per-subagent attribution, and that the 24h
`09521fa2` result is a 1,020-restart artifact rather than an
orchestration result.

## Open questions

- **Does `replace: false` change the RAM ceiling into the binding
  constraint?** With scripts accumulating, the ~3 GB budget is hit sooner.
  That is intended — a visible wall beats silent loss — but if every run
  now ends in RAM exhaustion, the next lever is the dispatcher's own
  footprint (~4.9 GB of 8 GB; `dispatcher-light.js` is ~3.1 GB).
- **Should `money_gained` stay a global delta?** Once per-script earnings
  exist, the global figure is arguably misleading in `ExecutionResult`.
  Left alone here to keep the change contained.
- **Is four closed loops enough to measure anything?** Even fully fixed,
  the canonical 20-minute run gives the orchestrator ~4 feedback events.
  This design does not resolve that; it makes each one informative.
