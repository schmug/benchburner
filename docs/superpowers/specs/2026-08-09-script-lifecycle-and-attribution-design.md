# Restoring the Orchestrator's Decision Space — Design

**Date:** 2026-08-09
**Status:** Approved — ready for implementation plan

## What this benchmark measures

**How well an orchestrator instructs subagents at coding.** Not team
management in the abstract — specifically, whether a model can turn a
goal into instructions that cause *other* models to produce working
code, and whether it can tell a good outcome from a bad one and adjust.

Two things must be true for that to be measurable, and neither is true
today:

1. The orchestrator must be able to **see** whether its instruction
   produced running, earning code.
2. There must be **more than one legal strategy** to choose between.

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

A *full* loop — instruct → code → commit → script runs → orchestrator
observes — is ~300s. At the canonical 20 minutes that is **about four
closed loops**, the first arriving after a quarter of the run has gone.

### Evidence 2 — given a long run, the loop went unused

Run `09521fa2` (claude-sonnet-4.6, 23.9 hours, `final_money` $2,022,061)
is the only run that ever escaped the floor:

- **one** subagent, `worker-1`, for all **1,430** delegations
- an instruction every **60 seconds**, every cycle, for 24 hours
- only **16 distinct code bodies** across all 1,430 results
- the identical four-line script
  `export async function main(ns) { while (true) { await ns.hack('foodnstuff'); } }`
  committed **1,020 times**

Because committing evicts a subagent's running script, the orchestrator
killed and restarted its own earner roughly once a minute for seventeen
hours. The $2M came from a four-line script and a long clock, *despite*
the orchestration. The behaviour was rational given what it could see:
nothing.

### Evidence 3 — there is only one legal strategy

Measured in-game against the pinned build (`ns.getServerMaxRam('home')`,
`ns.getServerUsedRam('home')`): home is **8.00 GB** and **7.00 GB is in
use** — the dispatcher (~5.2 GB) plus the measuring probe. A subagent
script gets **~2.8 GB**, and every script pays a 1.6 GB base cost, so the
API budget is **~1.2 GB**.

Against the game's own RAM cost table:

| strategy | cost | fits in 2.8 GB? |
|---|---|---|
| single-host `hack`/`grow`/`weaken` loop | 1.6 + ~0.4 = **2.0** | yes |
| `ns.exec` (run anything remotely) | 1.6 + 1.3 = **2.9** | **no** |
| `ns.scp` + `ns.exec` (distribute work) | 1.6 + 0.6 + 1.3 = **3.5** | **no** |
| `ns.purchaseServer` (buy RAM) | 1.6 + 2.25 = **3.85** | **no** |

`ns.singularity.upgradeHomeRam` is `SF4Cost`-gated: without Source-File 4
its cost is multiplied ×16, so it is unreachable in BitNode 1 regardless.

**Every RAM-bootstrap strategy is foreclosed — not by the game, by the
harness.** The only script shape that can start is a single-host hack
loop. That is the four-line script that "won" the 24h run, what the
hand-written golden script does, and why the leaderboard is flat: there
is one legal move, so there is nothing to orchestrate.

What the dispatcher spends its 5.2 GB on:

| call | cost | purpose |
|---|---|---|
| `ns.getResetInfo()` | **1.0** | `bitnode_id` — constant for a whole run |
| `ns.getPlayer()` | **0.5** | `p.money` — available for 0.1 elsewhere |
| `run` / `kill` / `isRunning` / `getRunningScript` | 1.9 | real dispatch machinery |
| script base | 1.6 | unavoidable |

`getServerMoneyAvailable("home")` returns `Player.money` directly
(`NetscriptFunctions.ts:996`) for 0.1 GB. Two convenience calls cost
1.4 GB, and that 1.4 GB is the entire early game.

### Root causes

1. **`instruct` silently destroys a working script.** `onResult` ends
   with an unconditional "on success, submit the script to the game";
   committing evicts the subagent's prior script.
2. **`kill` does not kill the script.** `handleKill` calls `pool.kill`
   and `subagentTracks.delete` and never touches the game — leaving an
   orphan that burns RAM and earns invisibly. Both verbs are backwards.
3. **No per-subagent earning signal.** `/__state.json` carries no running
   script data; `money_gained` is a global player delta.
4. **No affordable strategy but one** (Evidence 3).
5. **The orchestrator has no manual.** It is told the ns API and RAM
   costs but nothing about the game's mechanics — that servers form a
   network, that RAM can be bought or borrowed, that programs open
   ports. It must infer the world from subagent reports.

## Non-goals

- **Loop latency.** Shortening the ~250s round trip is the other half of
  the problem. This design makes the loop *usable*; a later change makes
  it *faster*.
- **Accept/reject.** Constraint 2 says the orchestrator "accepts or
  rejects whole results"; it can currently do neither. A real
  accept/reject adds a full cycle to a loop that closes ~4 times per run.
  Revisit once latency is addressed.
- **Naming the game.** The scrub stays. See §5 for why it no longer
  matters much.
- **Re-baselining published runs.** Noted in Comparability, not done here.

## Design

### 1. Explicit replace

`OrchestratorAction` gains `replace?: boolean`, **defaulting to
`false`**. A subagent's prior committed script is evicted only when the
originating action set `replace: true`.

Default `false` because the failure modes are asymmetric. Accumulating
scripts exhaust the budget, the runtime refuses to start the new one, and
the orchestrator sees `failed_to_start` — a loud, attributable failure it
can now observe. Killing an earner produces no event at all; income
simply stops. That is the failure that ran for seventeen hours undetected.

**It lives on the action, not on `Instruction`.** `Instruction` is the
message the *subagent* receives, and script lifecycle is a directive to
the harness. Keeping it off `Instruction` leaves SPEC §2.1's subagent
contract unchanged. If it matters to the code being written, the
orchestrator can say so in `context`.

**Ordering is load-bearing.** With `replace: true` the sequence is
submit → run → confirm started → *then* evict the predecessor. Killing
first and failing to start loses the income and gains nothing —
reproducing the failure this design exists to remove.

**Probe runs are unaffected.** Write-run-observe iterations are ephemeral
(`kind: "probe"`) and never occupy the committed slot.

### 2. `kill` kills the script

`handleKill` stops the subagent's committed script in the game before
dropping the track, so no orphan outlives its owner.

No separate "retire the worker, keep its script" verb: an idle subagent
costs nothing until instructed, so that strategy is simply *not
instructing it*.

### 3. Per-subagent live earnings

Extend the dispatcher's state write to enumerate running committed
scripts — `subagent_id`, `online_money_made`, `ram`, `uptime_seconds`.
The dispatcher already holds the pid→task map and already calls
`ns.getRunningScript`.

```ts
/** Live state of this subagent's committed script, refreshed each snapshot. */
export interface LiveScript {
  running: boolean;
  money_made: number;      // this script's own earnings, not a global delta
  ram: number;
  uptime_seconds: number;
}
```

`last_execution` (already landed) answers *did my instruction produce a
script that started*. `LiveScript` answers *is it still earning*.
Instruction quality is not observable without both.

### 4. Reclaim the dispatcher's 1.4 GB

- Drop `ns.getResetInfo()` (1.0 GB). `bitnode_id` is constant for a run;
  read it once at boot from a throwaway script, or take it from config.
- Replace `ns.getPlayer()` (0.5 GB) with
  `ns.getServerMoneyAvailable("home")` (0.1 GB).

Dispatcher 5.2 → **~3.6 GB**; subagent budget 2.8 → **~4.4 GB**. That
makes `scp`+`exec` (3.5) and `purchaseServer` (3.85) startable, so the
orchestrator gains a real decision: grind one host, borrow RAM from
nuked servers, or spend money on servers.

**Why this is not optional given §5 and §6.** `basic/ram.md` tells the
player *"You can purchase more RAM for your home computer... You can also
use cloud or hacked servers as a source of additional RAM."* Handing the
orchestrator that manual while the budget forbids both is worse than
handing it nothing — it would be a manual that lies, and the orchestrator
would burn its scarce cycles on instructions that cannot start. Ship §4
with §5, or ship neither.

This is the largest comparability break in the design. Approved 2026-08-09.

### 5. Give the orchestrator the basics

The §3.3 system prompt gains, verbatim, the five Basic Mechanics files
relevant to a BitNode-1 hacking run — **2,682 words total**:

| file | words |
|---|---|
| `basic/ram.md` | 66 |
| `basic/servers.md` | 540 |
| `basic/hacking.md` | 773 |
| `basic/scripts.md` | 1136 |
| `basic/programs.md` | 167 |

Deliberately excluded:

- `help/getting_started.md` (5,793 w) — walks through a working
  early-hack script. That hands over a strategy, not mechanics.
- `programming/hackingalgorithms.md` (1,697 w) — optimal HWG batching.
  This is the strategy guide.
- `advanced/*` — corporations, gangs, BitNode guides. Irrelevant to a
  20-minute BN1 run.

The text is the game's own, identical for every model, and lives in the
**system prompt** where it is stable and caches. That also defuses the
fairness worry about differential Bitburner knowledge: rather than
rewarding whichever model absorbed more wiki content, every orchestrator
is handed the same manual explicitly.

### 6. An in-world reference library

At boot, push a curated doc set onto `home` as `/doc/<name>.txt`, plus
`/doc/index.txt` listing what is available. `rfa.pushFile(filename,
content, server)` is already generic — `submitScript` is a thin wrapper
over it — so this is a boot-time loop, not new transport.

**`.txt`, not `.md`:** `hasTextExtension` (`src/Paths/TextFilePath.ts:9`)
accepts only `.txt`, `.json`, `.css`.

The library holds what §5 excludes — the tutorial, hacking algorithms,
and the remaining basic files. `ns.read` costs **0 GB**, so a subagent can
read any of it inside even the tight budget and report back.

Already present and needing no work: **69 `.lit` literature files across
the world's servers, and `.msg` messages that arrive on `home` as hacking
level crosses 25 / 40 / 50** (`MessageHelpers.tsx:75-82`). `ns.read` on
these is gated on the file genuinely being on that server
(`NetscriptFunctions.ts:1131`), so the discovery channel cannot be faked
— it works exactly as it does for a player.

The orchestrator is told the library exists and that subagents can read
it and report back. It is **not** given the contents. Research therefore
costs a subagent round trip (~200s) that could have been spent earning —
making "should I send someone to read the manual?" a real orchestration
decision with a real opportunity cost, which is precisely the skill under
measurement.

### 7. Money is a delta, not a balance

Every game starts the player with money — $1,262 in BitNode 1. The
orchestrator is shown `current_money` as an absolute and told to
"maximize the team's in-game money", so it reads its own starting
capital as revenue. Verified across two runs:

- *"Cycle 2 with ~390s left and only $1,262 **earned** — the team is
  barely producing."*
- *"90s of 480s gone and only $1262 **banked**."*
- *"No spending on upgrades/hacknet: at $1262 with 5 minutes left,
  payback would not arrive before the run ends, so all capital stays in
  direct hacking throughput."*

Actual earnings in both runs were **$0**. The third quote is the damaging
one: the orchestrator was weighing precisely the RAM-bootstrap
investment this design exists to enable, and declined it on a misreading
of starting capital as revenue.

`GameState` gains `starting_money` (captured once at boot) and
`money_earned` (`current_money - starting_money`). Both are exposed to
the orchestrator, and the §3.3 goal sentence changes from "maximize the
team's in-game money" to maximize money **earned above the starting
balance**, stating that the balance is a given, not an achievement.

`scrubInput` whitelists exactly four `game_state` keys
(`prompt.ts:155-160`); the two new fields must be added there or they
will never reach the model.

**Not changed here:** `RunSummary.final_money` stays absolute, so the 86
published runs keep parsing. But it means a run that earned nothing is
published as $1,262 rather than $0 — the "floor" every result sits on is
starting capital, not score. Adding a `money_earned` column to the
leaderboard is the honest follow-up and is left to a separate change.

### 8. Prompt changes

Added to the §3.3 system prompt, wording fixed across models:

- the Basic Mechanics text (§5)
- money earned vs. starting balance (§7)
- that a new script runs **alongside** unless `replace: true`, and that
  the RAM budget is shared
- that `kill` stops the subagent's script too
- per-subagent earnings are visible
- the `/doc` library exists, `.lit` and `.msg` files are discoverable
  in-world, and reading costs no RAM but does cost a subagent's time

## Schema changes

| File | Change |
|---|---|
| `harness/types.ts` | `OrchestratorAction.replace?: boolean`; `LiveScript`; `SubagentStatus.live_script?: LiveScript \| null`; `GameController.killScript`; `GameState.starting_money` / `money_earned` |
| `harness/orchestrator/loop.ts` | Honour `replace`; kill script in `handleKill`; thread `live_script` |
| `harness/orchestrator/prompt.ts` | Basics text; lifecycle + library paragraphs; goal sentence; **add the two money keys to the `scrubInput` whitelist** |
| `harness/game/dispatcher.js` | Drop `getResetInfo`/`getPlayer`; export running-script stats; support killing a committed script |
| `harness/game/puppeteer.ts` | `killScript`; push `/doc/*.txt` at boot |
| `SPEC.md` | §2.1, §3.1, §3.3 |
| `VALIDATION.md` | Dated comparability break |

**Leak-policy note.** `scrubInput` builds `SubagentStatus` with a spread,
so any new field reaches the model unscrubbed unless handled. `LiveScript`
is numeric/boolean only and needs no scrubbing today — but must be added
if it ever gains a string.

## Testing

`node:test` via `tsx` (68 tests currently). Older specs' claim of "no
formal test framework" is out of date.

1. `replace: false` leaves the running script alive.
2. `replace: true` evicts the predecessor.
3. **Default is `false`** — the regression guard for the 1,020-restart
   failure.
4. `replace: true` whose replacement fails to start keeps the
   predecessor, and the orchestrator sees `failed_to_start`.
5. `kill` stops the script; no orphan remains.
6. Per-subagent earnings reach the prompt the loop actually builds.
7. **Dispatcher RAM regression guard** — assert measured dispatcher cost
   stays under a threshold (~4.0 GB) so a future convenience call cannot
   silently re-close the strategy space. This is the test that would have
   caught the original defect.
8. `/doc/*.txt` is readable by a script for 0 GB.
9. **`money_earned` reaches the prompt and reads 0 at run start** — the
   regression guard for the "$1,262 earned" misreading.
10. End-to-end: a subagent script earns, is re-instructed without
    `replace`, and keeps earning across the boundary.

## Comparability

This is a clean break. All 86 published runs ran with implicit replace,
no per-subagent attribution, a 2.8 GB budget, and no manual. Their
numbers are not comparable to anything produced after this lands.

Add a dated VALIDATION.md section mirroring the snapshot-cadence break,
recording that the 24h `09521fa2` result is a 1,020-restart artifact of a
single four-line script rather than an orchestration result.

## Open questions

- **Does the strategy space actually open?** The prediction is that
  `scp`+`exec` and `purchaseServer` become viable and runs stop
  converging on one script shape. If runs still flatten, the next
  suspects are loop latency (~4 closures) and the 20-minute duration.
- **Should `money_gained` stay a global delta** in `ExecutionResult` once
  per-script earnings exist? Left alone to keep the change contained.
- **Is four closed loops enough to measure anything?** This design makes
  each feedback event informative; it does not make them more frequent.
