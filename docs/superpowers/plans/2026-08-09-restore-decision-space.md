# Restoring the Orchestrator's Decision Space — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the orchestrator more than one legal strategy, an honest view of what its instructions produced, and the game's own manual — so that "how well does it instruct subagents at coding" becomes measurable.

**Architecture:** Four independent seams. (1) The in-game dispatcher sheds 1.4 GB of RAM spent on two convenience calls, which reopens `scp`/`exec`/`purchaseServer` for subagent scripts. (2) Script lifecycle becomes explicit — committing no longer silently evicts a running earner, and `kill` actually kills. (3) The dispatcher reports per-script earnings so the orchestrator can tell a working instruction from a dead one. (4) The orchestrator gets the game's Basic Mechanics docs in its cached system prompt, and everything richer goes in-world where subagents must be sent to read it.

**Tech Stack:** TypeScript (Node ≥20, ESM) run via `tsx`; tests are `node:test` (`npm test`, currently 68 passing); the in-game dispatcher is plain Netscript JS pushed over the Remote File API; Bitburner pinned at `a4b0f22a`.

**Spec source:** [docs/superpowers/specs/2026-08-09-script-lifecycle-and-attribution-design.md](../specs/2026-08-09-script-lifecycle-and-attribution-design.md)

## Global Constraints

- **Never regress the RAM budget.** The dispatcher must stay under **4.0 GB**. Every `ns.*` call added to `dispatcher.js` costs home RAM that subagent scripts need. Task 1 adds a guard; do not weaken it.
- **`scrubInput` is a whitelist, not a spread, for `game_state`.** `harness/orchestrator/prompt.ts:155-160` rebuilds `game_state` as a four-key object literal. Any new game-state key must be added there or it never reaches the model.
- **`scrubInput` IS a spread for `SubagentStatus`.** Any new field with free text must be scrubbed explicitly, or a forbidden token fails the run closed.
- **Bitburner text files may only end in `.txt`, `.json`, or `.css`** (`src/Paths/TextFilePath.ts:9`). Not `.md`.
- **Prompt wording is fixed across models** (SPEC §3.3). No per-model text.
- **Do not commit `results/`.** The harness `git commit`s artifacts at run end; per `42c397c` those belong on `orchestrator/*` branches. Reset them out before committing plan work.
- Run `npm test` and `npm run typecheck` before every commit.

---

## File Structure

| File | Disposition | Responsibility |
|---|---|---|
| `harness/game/dispatcher.js` | Modify | Shed `getPlayer`/`getResetInfo`; honour `replace`; honour kill requests; export per-script stats |
| `harness/game/puppeteer.ts` | Modify | Boot probe for `bitnode_id`; cache `starting_money`; `killScript`; thread `replace`; push `/doc/*.txt` |
| `harness/game/ram-budget-smoke.ts` | Create | Measures real dispatcher RAM in-game; the regression guard |
| `harness/game/docs.ts` | Create | Curated doc manifest + loader shared by prompt and in-world library |
| `harness/types.ts` | Modify | `GameState.starting_money`/`money_earned`; `OrchestratorAction.replace`; `LiveScript`; `SubagentStatus.live_script`; `GameController.killScript` |
| `harness/orchestrator/loop.ts` | Modify | Thread `replace`; kill script on `kill`; thread `live_script` |
| `harness/orchestrator/prompt.ts` | Modify | Goal sentence; basics text; lifecycle/library paragraphs; whitelist keys |
| `test/game/dispatcher-replace.test.ts` | Create | `replace` semantics against a fake queue |
| `test/orchestrator/money-delta.test.ts` | Create | `money_earned` reaches the prompt |
| `test/orchestrator/live-script.test.ts` | Create | Per-subagent earnings reach the prompt |
| `test/orchestrator/docs-prompt.test.ts` | Create | Basics present, strategy guides absent |
| `SPEC.md`, `VALIDATION.md` | Modify | Schema + comparability break |

---

## Task 1: Reclaim the dispatcher's RAM

**Files:**
- Modify: `harness/game/dispatcher.js` (lines 22-41, 55, 75, and the `endMoney` write)
- Modify: `harness/game/puppeteer.ts` (`start()`, `readState()`)
- Create: `harness/game/ram-budget-smoke.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PuppeteerGame` continues to satisfy `GameController.readState(): Promise<GameState>` with `bitnode_id` populated from a boot probe rather than per-tick.

- [ ] **Step 1: Write the RAM budget smoke test**

Create `harness/game/ram-budget-smoke.ts`:

```ts
/**
 * Guards the invariant that makes this benchmark have more than one
 * legal strategy: the dispatcher must leave enough home RAM for a
 * subagent script to call ns.exec / ns.scp / ns.purchaseServer.
 *
 * Before this guard existed the dispatcher used 5.2 GB of home's 8 GB,
 * leaving 2.8 GB — under the 2.9 GB an ns.exec script needs — so the
 * only startable script shape was a single-host hack loop.
 *
 * Usage: npx tsx harness/game/ram-budget-smoke.ts
 */
import { PuppeteerGame } from "./puppeteer";

const MAX_DISPATCHER_GB = 4.0;

const probe = `/** @param {NS} ns */
export async function main(ns) {
  ns.tprint('DISPATCHER_RAM=' + ns.getScriptRam('/__dispatcher.js', 'home'));
  ns.tprint('HOME_MAX=' + ns.getServerMaxRam('home'));
}`;

async function main(): Promise<void> {
  const game = new PuppeteerGame({ seed: 8675309, rfaPort: 12598 });
  await game.start();
  try {
    await game.submitScript({ script_id: "rambudget", code: probe });
    const r = await game.runScript({
      script_id: "rambudget",
      subagent_id: "smoke",
      kind: "probe",
    });
    const out = r.stdout ?? "";
    const dispatcher = Number(/DISPATCHER_RAM=([\d.]+)/.exec(out)?.[1]);
    const home = Number(/HOME_MAX=([\d.]+)/.exec(out)?.[1]);
    if (!Number.isFinite(dispatcher) || !Number.isFinite(home)) {
      throw new Error(`could not parse probe output: ${JSON.stringify(out)}`);
    }

    const free = home - dispatcher;
    console.log(`[ram] home=${home}GB dispatcher=${dispatcher}GB free=${free}GB`);

    // A script's own base cost is 1.6 GB before any API call.
    const checks: Array<[string, number]> = [
      ["ns.exec", 1.6 + 1.3],
      ["ns.scp + ns.exec", 1.6 + 0.6 + 1.3],
      ["ns.purchaseServer", 1.6 + 2.25],
    ];
    let failed = false;
    if (dispatcher > MAX_DISPATCHER_GB) {
      console.error(`[ram] FAIL dispatcher ${dispatcher}GB exceeds ${MAX_DISPATCHER_GB}GB cap`);
      failed = true;
    }
    for (const [name, cost] of checks) {
      const ok = cost <= free;
      console.log(`[ram] ${ok ? "OK  " : "FAIL"} ${name} needs ${cost}GB, free ${free}GB`);
      if (!ok) failed = true;
    }
    if (failed) process.exit(1);
    console.log("[ram] all strategy shapes are startable");
  } finally {
    await game.stop();
  }
}
void main();
```

- [ ] **Step 2: Run it and confirm it FAILS**

```bash
PUPPETEER_SKIP_DOWNLOAD=true npx tsx harness/game/ram-budget-smoke.ts
```

Expected: `dispatcher≈5.2GB free≈2.8GB`, then `FAIL` for all three shapes and for the 4.0 GB cap. This is the defect.

- [ ] **Step 3: Replace `ns.getPlayer()` with `ns.getServerMoneyAvailable("home")`**

In `harness/game/dispatcher.js`, there are four `ns.getPlayer()` calls, all reading `.money`. `getServerMoneyAvailable("home")` returns `Player.money` directly (`NetscriptFunctions.ts:996`) for 0.1 GB instead of 0.5 GB.

Add near the top of `main`:

```js
  // ns.getPlayer costs 0.5 GB; this returns the same value for 0.1 GB.
  // Home RAM spent here is RAM subagent scripts cannot have — see
  // harness/game/ram-budget-smoke.ts.
  const money = () => ns.getServerMoneyAvailable("home");
```

Then replace, in order:
- line ~23: `const p = ns.getPlayer();` → delete, and `current_money: Math.floor(p.money),` → `current_money: Math.floor(money()),`
- line ~55: `const startMoney = ns.getPlayer().money;` → `const startMoney = money();`
- line ~75: `other.endMoney = ns.getPlayer().money;` → `other.endMoney = money();`
- the later `task.endMoney = ns.getPlayer().money;` → `task.endMoney = money();`

- [ ] **Step 4: Drop `ns.getResetInfo()` from the dispatcher**

`bitnode_id` never changes during a run, so a 1.0 GB per-tick call buys nothing. Delete `const ri = ns.getResetInfo();` and remove `bitnode_id` and `bitnode_complete` from the state payload. The state object becomes:

```js
      ns.write(
        STATE,
        JSON.stringify({
          current_money: Math.floor(money()),
          augments_installed: [],
          last_heartbeat_ms: Date.now(),
          timestamp: new Date().toISOString(),
        }),
        "w",
      );
```

- [ ] **Step 5: Read `bitnode_id` once at boot in `puppeteer.ts`**

Add a private field and a boot probe. In `PuppeteerGame`, add:

```ts
  /** Read once at boot: constant for a run, and 1.0 GB/tick to poll. */
  private bitnodeId = 1;
```

At the end of `start()`, after the dispatcher is confirmed alive, add:

```ts
    // bitnode_id is constant for a run. Reading it once here keeps
    // ns.getResetInfo (1.0 GB) out of the dispatcher's per-tick budget.
    try {
      const probeId = "__bootprobe";
      await this.submitScript({
        script_id: probeId,
        code:
          "/** @param {NS} ns */\nexport async function main(ns) {" +
          " ns.tprint('BITNODE=' + ns.getResetInfo().currentNode); }",
      });
      const res = await this.runScript({
        script_id: probeId,
        subagent_id: "boot",
        kind: "probe",
      });
      const m = /BITNODE=(\d+)/.exec(res.stdout ?? "");
      if (m) this.bitnodeId = Number(m[1]);
    } catch (e) {
      console.warn(`[game] bitnode probe failed, assuming 1: ${(e as Error).message}`);
    }
```

- [ ] **Step 6: Merge the cached fields back in `readState()`**

The dispatcher no longer reports `bitnode_id`/`bitnode_complete`, but `GameState` still requires them. In `readState()`, after parsing `/__state.json`, spread the cached value in before returning:

```ts
    return {
      ...parsed,
      bitnode_id: this.bitnodeId,
      bitnode_complete: false,
    } as GameState;
```

Apply the same to the `read_failed` placeholder path so its shape stays identical.

- [ ] **Step 7: Run the smoke test and confirm it PASSES**

```bash
PUPPETEER_SKIP_DOWNLOAD=true npx tsx harness/game/ram-budget-smoke.ts
```

Expected: `dispatcher≈3.8GB free≈4.2GB`, `OK` for all three shapes, exit 0.

- [ ] **Step 8: Run the full gates**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean, 68 passing.

- [ ] **Step 9: Commit**

```bash
git add harness/game/dispatcher.js harness/game/puppeteer.ts harness/game/ram-budget-smoke.ts
git commit -m "perf(game): reclaim 1.4GB of home RAM from the dispatcher

ns.getResetInfo (1.0GB/tick) read a value constant for the whole run,
and ns.getPlayer (0.5GB) read money that getServerMoneyAvailable('home')
returns for 0.1GB. Together they left subagent scripts 2.8GB of home's
8GB — under the 2.9GB an ns.exec script needs — so the only startable
shape was a single-host hack loop.

Dispatcher 5.2 -> ~3.8GB, subagent budget 2.8 -> ~4.2GB, which makes
scp+exec (3.5) and purchaseServer (3.85) startable for the first time.

bitnode_id now comes from a one-shot boot probe. Adds
ram-budget-smoke.ts asserting the dispatcher stays under 4.0GB and each
strategy shape still fits."
```

---

## Task 2: Money is a delta, not a balance

**Files:**
- Modify: `harness/types.ts` (`GameState`)
- Modify: `harness/game/puppeteer.ts` (`readState`)
- Modify: `harness/orchestrator/prompt.ts` (goal sentence, `scrubInput`)
- Create: `test/orchestrator/money-delta.test.ts`

**Interfaces:**
- Consumes: Task 1's `readState()` merge point.
- Produces: `GameState.starting_money: number` and `GameState.money_earned: number`, both visible to the orchestrator.

**Why:** Bitburner starts the player at $1,262. Across two real runs the orchestrator wrote "only $1,262 **earned**", "only $1262 **banked**", and declined a RAM upgrade because "at $1262 with 5 minutes left, payback would not arrive". Actual earnings were $0.

- [ ] **Step 1: Write the failing test**

Create `test/orchestrator/money-delta.test.ts`:

```ts
/**
 * The orchestrator was reading its own starting capital as revenue.
 * Bitburner starts the player at $1,262, and every run that earned
 * nothing still showed `current_money: 1262`, which the model read as
 * earnings — in one run declining a RAM investment because of it.
 */
import { strict as assert } from "node:assert";
import test, { describe } from "node:test";

import { buildOrchestratorPrompt } from "../../harness/orchestrator/prompt";
import type { OrchestratorInput } from "../../harness/types";

function input(over: Partial<OrchestratorInput["game_state"]>): OrchestratorInput {
  return {
    cycle_number: 1,
    elapsed_time_seconds: 60,
    total_duration_seconds: 1200,
    game_state: {
      current_money: 1262,
      starting_money: 1262,
      money_earned: 0,
      bitnode_id: 1,
      bitnode_complete: false,
      ...over,
    },
    subagent_status: [],
    delegation_history: [],
    available_subagent_models: ["m"],
  };
}

describe("orchestrator prompt — money is a delta", () => {
  test("money_earned reaches the model and reads 0 at run start", () => {
    const { user } = buildOrchestratorPrompt(input({}), 8675309);
    const gs = JSON.parse(user).game_state;
    assert.equal(gs.money_earned, 0, "a run that earned nothing must show 0");
    assert.equal(gs.starting_money, 1262);
  });

  test("money_earned tracks the delta once the team earns", () => {
    const { user } = buildOrchestratorPrompt(
      input({ current_money: 51262, money_earned: 50000 }),
      8675309,
    );
    assert.equal(JSON.parse(user).game_state.money_earned, 50000);
  });

  test("the goal sentence asks for money earned, not a balance", () => {
    const { system } = buildOrchestratorPrompt(input({}), 8675309);
    assert.match(system, /earn/i);
    assert.doesNotMatch(
      system,
      /maximize the team's in-game money in the/,
      "the old balance-framed goal sentence must be gone",
    );
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test test/orchestrator/money-delta.test.ts
```

Expected: FAIL — `gs.money_earned` is `undefined`, because `scrubInput` whitelists only four keys.

- [ ] **Step 3: Add the fields to `GameState`**

In `harness/types.ts`, inside `GameState`, above the index signature:

```ts
  /** Money the player began the run with. A given, not an achievement. */
  starting_money?: number;
  /** current_money - starting_money. The actual score. */
  money_earned?: number;
```

- [ ] **Step 4: Populate them in `readState()`**

In `PuppeteerGame`, add a field:

```ts
  /** Captured on the first successful state read; the run's baseline. */
  private startingMoney: number | null = null;
```

In `readState()`, where Task 1 merges `bitnode_id`, extend the merge:

```ts
    const current = Number(parsed.current_money ?? 0);
    if (this.startingMoney === null && !parsed.read_failed) {
      this.startingMoney = current;
    }
    const starting = this.startingMoney ?? current;
    return {
      ...parsed,
      bitnode_id: this.bitnodeId,
      bitnode_complete: false,
      starting_money: starting,
      money_earned: current - starting,
    } as GameState;
```

- [ ] **Step 5: Add both keys to the `scrubInput` whitelist**

`harness/orchestrator/prompt.ts:155-160` rebuilds `game_state` as an object literal with no spread. Add the two keys:

```ts
    game_state: {
      current_money: gs.current_money,
      starting_money: gs.starting_money ?? gs.current_money,
      money_earned: gs.money_earned ?? 0,
      level_id: gs.bitnode_id,
      level_complete: gs.bitnode_complete,
      upgrades_installed: gs.augments_installed ?? [],
    } as unknown as OrchestratorInput["game_state"],
```

- [ ] **Step 6: Rewrite the goal sentence**

In `buildSystemPrompt`, replace `Your goal is to maximize the team's in-game money in the ${horizon}-hour window.` with:

```ts
`Your goal is to maximize the money your team EARNS in the ${horizon}-hour window. You begin with a starting balance, which is a given and not an achievement — game_state.money_earned is your actual score, and it starts at zero. If money_earned is not rising, your team is producing nothing, no matter how large current_money looks.`
```

- [ ] **Step 7: Run the tests**

```bash
npx tsx --test test/orchestrator/money-delta.test.ts && npm run typecheck && npm test
```

Expected: 3 new tests pass; 71 total; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add harness/types.ts harness/game/puppeteer.ts harness/orchestrator/prompt.ts test/orchestrator/money-delta.test.ts
git commit -m "fix(orchestrator): report money earned, not the starting balance

Bitburner starts the player at \$1,262 and the prompt asked to 'maximize
the team's in-game money', so the orchestrator read its own starting
capital as revenue. Across two runs it wrote 'only \$1,262 earned' and
'only \$1262 banked', and declined a RAM investment because 'at \$1262
with 5 minutes left, payback would not arrive'. Real earnings: \$0.

GameState gains starting_money and money_earned; the goal sentence now
asks for money earned above the starting balance. Both keys added to
scrubInput's four-key game_state whitelist, without which they would
never reach the model."
```

---

## Task 3: `replace` — stop committing from destroying a working script

**Files:**
- Modify: `harness/types.ts` (`OrchestratorAction`, `GameController.runScript`)
- Modify: `harness/game/puppeteer.ts` (`runScript` enqueue)
- Modify: `harness/game/dispatcher.js` (eviction block)
- Modify: `harness/orchestrator/loop.ts` (`handleInstruct`, `onResult`, `executeScript`)
- Create: `test/game/dispatcher-replace.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `OrchestratorAction.replace?: boolean`; `GameController.runScript` accepts `replace?: boolean`; queue entries carry `replace: boolean`.

**Why:** In the 24h run, the orchestrator committed the identical four-line script 1,020 times. Each commit evicted the previous one, so it killed and restarted its own earner about once a minute for seventeen hours.

- [ ] **Step 1: Write the failing test**

The eviction decision lives in `dispatcher.js`, which runs inside the game. Extract the decision into a pure helper so it can be tested without a browser. Create `test/game/dispatcher-replace.test.ts`:

```ts
/**
 * Committing a script used to evict the subagent's running one
 * unconditionally. In the 24h run that meant killing and restarting the
 * same earning script 1,020 times.
 *
 * Eviction is now opt-in AND ordered: the predecessor dies only after
 * the replacement is confirmed running, so a failed start cannot cost
 * the income it was meant to preserve.
 */
import { strict as assert } from "node:assert";
import test, { describe } from "node:test";

import { evictionTargets } from "../../harness/game/eviction";

const running = (subagent_id: string, pid: number) => ({
  subagent_id,
  pid,
  status: "running",
  kind: "committed",
});

describe("dispatcher eviction", () => {
  test("replace omitted evicts nothing — the regression guard", () => {
    const queue = [running("a", 1), { subagent_id: "a", status: "pending", kind: "committed" }];
    assert.deepEqual(evictionTargets(queue, queue[1]), []);
  });

  test("replace false evicts nothing", () => {
    const incoming = { subagent_id: "a", status: "pending", kind: "committed", replace: false };
    assert.deepEqual(evictionTargets([running("a", 1), incoming], incoming), []);
  });

  test("replace true evicts only that subagent's running committed script", () => {
    const incoming = { subagent_id: "a", status: "pending", kind: "committed", replace: true };
    const queue = [running("a", 1), running("b", 2), incoming];
    assert.deepEqual(
      evictionTargets(queue, incoming).map((t) => t.pid),
      [1],
      "must not touch another subagent's script",
    );
  });

  test("probes are never evicted", () => {
    const incoming = { subagent_id: "a", status: "pending", kind: "committed", replace: true };
    const probe = { subagent_id: "a", pid: 9, status: "running", kind: "probe" };
    assert.deepEqual(evictionTargets([probe, incoming], incoming), []);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test test/game/dispatcher-replace.test.ts
```

Expected: FAIL — `Cannot find module '../../harness/game/eviction'`.

- [ ] **Step 3: Create the shared eviction helper**

Create `harness/game/eviction.ts`:

```ts
/**
 * Which running scripts a newly-started committed task displaces.
 *
 * Extracted from dispatcher.js so the rule is unit-testable without a
 * browser. dispatcher.js keeps its own inlined copy (it is pushed into
 * the game as plain Netscript and cannot import); the test suite pins
 * the behaviour here and `dispatcher-parity` asserts they agree.
 */
export interface QueueTask {
  subagent_id?: string;
  pid?: number;
  status?: string;
  kind?: string;
  replace?: boolean;
}

export function evictionTargets<T extends QueueTask>(queue: T[], incoming: T): T[] {
  if (incoming.replace !== true) return [];
  return queue.filter(
    (other) =>
      other !== incoming &&
      other.status === "running" &&
      other.kind === "committed" &&
      other.subagent_id === incoming.subagent_id,
  );
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx tsx --test test/game/dispatcher-replace.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Apply the rule in the dispatcher, after the run succeeds**

In `harness/game/dispatcher.js`, **delete** the eviction block that currently sits before `ns.run` (the `if (task.kind === "committed") { for (const other of queue) ... }` block, roughly lines 64-79).

Then, inside the `if (pid > 0)` branch after `task.startedAt = Date.now();`, insert:

```js
          // Evict the subagent's previous committed script ONLY now that
          // the replacement is confirmed running, and only if the
          // orchestrator asked. Killing first and then failing to start
          // loses the income and gains nothing. Mirror of
          // harness/game/eviction.ts — keep the two in step.
          if (task.kind === "committed" && task.replace === true) {
            for (const other of queue) {
              if (other === task) continue;
              if (other.status !== "running") continue;
              if (other.kind !== "committed") continue;
              if (other.subagent_id !== task.subagent_id) continue;
              try { ns.kill(other.pid); } catch (_) { /* ignore */ }
              other.status = "done";
              other.exit_reason = "replaced";
              other.stderr = "replaced by a newer committed script from the same subagent";
              other.completedAt = Date.now();
              other.endMoney = money();
              writeResult(ns, other);
              changed = true;
            }
          }
```

- [ ] **Step 6: Thread `replace` through the type and the queue**

In `harness/types.ts`:

```ts
export interface OrchestratorAction {
  action_type: OrchestratorActionType;
  subagent_id?: string;
  model_choice?: string;
  /**
   * Replace this subagent's currently running committed script with the
   * one this instruction produces. Defaults to false: an accumulating
   * script hits the RAM budget and surfaces as failed_to_start, which
   * the orchestrator can see, whereas killing an earner is silent.
   */
  replace?: boolean;
  instruction?: Instruction;
}
```

And widen `GameController.runScript`'s parameter object with `replace?: boolean;`.

In `harness/game/puppeteer.ts`, add `replace = false` to the `runScript` destructured parameters and its type, and include it in the pushed queue entry:

```ts
    queue.push({
      script_id,
      subagent_id,
      path: this.scriptFilename(script_id),
      status: "pending",
      kind,
      replace,
    });
```

- [ ] **Step 7: Carry `replace` from the action to the commit**

In `harness/orchestrator/loop.ts`, add a field beside the other per-instruction maps:

```ts
  /** instruction_id → whether the orchestrator asked to replace the running script. */
  private readonly replaceByInstruction = new Map<string, boolean>();
```

In `handleInstruct`, after `instruction` is built:

```ts
    this.replaceByInstruction.set(instruction.instruction_id, a.replace === true);
```

Change `executeScript`'s signature to `private async executeScript(script_id: string, r: Result, replace: boolean)` and pass it through:

```ts
      const exec = await this.game.runScript({
        script_id,
        subagent_id: r.subagent_id,
        kind: "committed",
        replace,
      });
```

At the `onResult` call site:

```ts
      void this.executeScript(script_id, r, this.replaceByInstruction.get(r.instruction_id) === true);
```

- [ ] **Step 8: Document it in the system prompt**

In `buildSystemPrompt`, replace the committed-script-lifecycle paragraph with:

```ts
`Committed-script lifecycle: when a subagent returns final code, it is committed and runs until the run ends. By default it runs ALONGSIDE that subagent's existing committed script — it does NOT replace it. Set "replace": true on an instruct action to retire the old one, which happens only once the new script is confirmed running. All committed scripts share one RAM budget, so scripts accumulate until the budget is exhausted, at which point new ones report failed_to_start. Killing a subagent also stops its committed script.`
```

- [ ] **Step 9: Add `replace` to the orchestrator output schema**

In `ORCHESTRATOR_OUTPUT_SCHEMA` in `loop.ts`, inside the action `properties`, add:

```ts
          replace: { type: "boolean" },
```

And in the schema block printed in the system prompt, add the line
`      "replace": "boolean (optional, instruct only; default false)",`
after the `model_choice` line.

- [ ] **Step 10: Run the gates**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean, 75 passing.

- [ ] **Step 11: Commit**

```bash
git add harness/types.ts harness/game/eviction.ts harness/game/dispatcher.js harness/game/puppeteer.ts harness/orchestrator/loop.ts test/game/dispatcher-replace.test.ts
git commit -m "feat(orchestrator): make script replacement explicit and ordered

Committing a subagent's code evicted its running script unconditionally.
In the 24h run that meant the orchestrator killed and restarted the same
four-line earner about once a minute for seventeen hours — 1,020
identical commits — because it had no way to say 'keep what is running'.

replace now defaults to false: accumulating scripts hit the RAM budget
and surface as failed_to_start, which the orchestrator can see, whereas
killing an earner is silent. Eviction also moved to after the
replacement is confirmed running, so a failed start cannot cost the
income it was meant to preserve.

The rule is extracted to harness/game/eviction.ts so it can be tested
without a browser; dispatcher.js mirrors it inline because it is pushed
into the game as plain Netscript."
```

---

## Task 4: `kill` actually kills the script

**Files:**
- Modify: `harness/types.ts` (`GameController`)
- Modify: `harness/game/puppeteer.ts` (`killScript`)
- Modify: `harness/game/mock.ts` (`killScript`)
- Modify: `harness/game/dispatcher.js` (honour `kill_requested`)
- Modify: `harness/orchestrator/loop.ts` (`handleKill`)

**Interfaces:**
- Consumes: Task 3's queue entry shape.
- Produces: `GameController.killScript(subagent_id: string): Promise<void>`.

**Why:** `handleKill` calls `pool.kill` and `subagentTracks.delete` and never touches the game, so a killed subagent's script keeps running, keeps consuming the RAM budget, keeps earning — and the orchestrator has just deleted the only record of it.

- [ ] **Step 1: Add `killScript` to the `GameController` interface**

In `harness/types.ts`:

```ts
  /**
   * Stop this subagent's committed script, if any. Called when the
   * orchestrator kills a subagent — otherwise the script outlives its
   * owner as an orphan that still consumes RAM and earns invisibly.
   */
  killScript(subagent_id: string): Promise<void>;
```

- [ ] **Step 2: Implement it in `puppeteer.ts`**

Reuse the existing queue channel rather than adding a new file:

```ts
  async killScript(subagent_id: string): Promise<void> {
    this.requireReady();
    const raw = await this.safeGetFile("/__queue.json");
    if (!raw) return;
    const queue = safeJsonParseArray(raw) as Array<Record<string, unknown>>;
    let touched = false;
    for (const t of queue) {
      if (t.subagent_id === subagent_id && t.kind === "committed" && t.status === "running") {
        t.kill_requested = true;
        touched = true;
      }
    }
    if (touched) await this.rfa!.pushFile("/__queue.json", JSON.stringify(queue), "home");
  }
```

- [ ] **Step 3: Implement it in `mock.ts`**

```ts
  async killScript(_subagent_id: string): Promise<void> {
    // MockGame runs nothing in-game; nothing to stop.
  }
```

- [ ] **Step 4: Honour it in the dispatcher**

In `harness/game/dispatcher.js`, in the `else if (task.status === "running")` branch, before the existing timeout check:

```js
        if (task.kill_requested) {
          try { ns.kill(task.pid); } catch (_) { /* ignore */ }
          task.status = "done";
          task.exit_reason = "killed";
          task.stderr = "stopped because the orchestrator killed its subagent";
          task.completedAt = Date.now();
          task.endMoney = money();
          changed = true;
          writeResult(ns, task);
          continue;
        }
```

- [ ] **Step 5: Call it from `handleKill`**

In `harness/orchestrator/loop.ts`:

```ts
  private handleKill(a: OrchestratorAction): void {
    if (!a.subagent_id) return;
    // Stop the script before dropping the track. Otherwise it outlives
    // its owner: still burning RAM, still earning, and now invisible.
    void this.game.killScript(a.subagent_id).catch((e) => {
      console.error(`[orchestrator] killScript(${a.subagent_id}) failed: ${(e as Error).message}`);
    });
    this.pool.kill(a.subagent_id);
    this.subagentTracks.delete(a.subagent_id);
  }
```

- [ ] **Step 6: Run the gates**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean (any other `GameController` implementer now fails to compile until it gains `killScript` — fix those), 75 passing.

- [ ] **Step 7: Commit**

```bash
git add harness/types.ts harness/game/puppeteer.ts harness/game/mock.ts harness/game/dispatcher.js harness/orchestrator/loop.ts
git commit -m "fix(orchestrator): killing a subagent stops its committed script

handleKill dropped the subagent from the pool and deleted its track
without ever telling the game, so the committed script kept running,
kept consuming the shared RAM budget, and kept earning — while the
orchestrator deleted the only record it had of it.

Together with the replace fix, both lifecycle verbs were backwards:
instruct killed a script you wanted to keep, kill spared one you wanted
to stop.

Kill requests ride the existing /__queue.json channel rather than adding
a second control file."
```

---

## Task 5: Per-subagent live earnings

**Files:**
- Modify: `harness/game/dispatcher.js` (state write)
- Modify: `harness/types.ts` (`LiveScript`, `SubagentStatus`)
- Modify: `harness/orchestrator/loop.ts` (`assembleInput`)
- Create: `test/orchestrator/live-script.test.ts`

**Interfaces:**
- Consumes: Task 1's state payload shape.
- Produces: `LiveScript`; `SubagentStatus.live_script?: LiveScript | null`; `GameState.live_scripts?: LiveScript[]`.

**Why:** `last_execution` (already shipped) says whether a script *started*. Nothing says whether it is still *earning*. The 24h orchestrator had neither, so it re-instructed blindly.

- [ ] **Step 1: Write the failing test**

Create `test/orchestrator/live-script.test.ts`:

```ts
/**
 * "Is this subagent's script still earning?" was unanswerable: the
 * state export carried no running-script data, and money_gained is a
 * global player delta that cannot be attributed when several scripts
 * run at once. The per-script figure already existed in-game
 * (ns.getRunningScript().onlineMoneyMade) and was simply never exported.
 */
import { strict as assert } from "node:assert";
import test, { describe } from "node:test";

import { buildOrchestratorPrompt } from "../../harness/orchestrator/prompt";
import type { LiveScript, OrchestratorInput } from "../../harness/types";

const live: LiveScript = {
  running: true,
  money_made: 45000,
  ram: 2.6,
  uptime_seconds: 180,
};

function input(ls: LiveScript | null): OrchestratorInput {
  return {
    cycle_number: 3,
    elapsed_time_seconds: 180,
    total_duration_seconds: 1200,
    game_state: {
      current_money: 46262,
      starting_money: 1262,
      money_earned: 45000,
      bitnode_id: 1,
      bitnode_complete: false,
    },
    subagent_status: [
      {
        subagent_id: "earner",
        last_instruction_id: "i-1",
        last_result: null,
        live_script: ls,
        status: "executed",
      },
    ],
    delegation_history: [],
    available_subagent_models: ["m"],
  };
}

describe("orchestrator input — live script", () => {
  test("per-subagent earnings reach the prompt", () => {
    const { user } = buildOrchestratorPrompt(input(live), 8675309);
    const s = JSON.parse(user).subagent_status[0];
    assert.equal(s.live_script.running, true);
    assert.equal(s.live_script.money_made, 45000);
    assert.equal(s.live_script.uptime_seconds, 180);
  });

  test("a subagent with no committed script reports null, not a fake zero", () => {
    const { user } = buildOrchestratorPrompt(input(null), 8675309);
    assert.equal(JSON.parse(user).subagent_status[0].live_script, null);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test test/orchestrator/live-script.test.ts
```

Expected: FAIL — `live_script` is not a property of `SubagentStatus`.

- [ ] **Step 3: Add the types**

In `harness/types.ts`:

```ts
/**
 * Live state of a subagent's committed script, refreshed each snapshot.
 * `last_execution` answers "did my instruction produce a script that
 * started"; this answers "is it still earning". Instruction quality is
 * not observable without both.
 */
export interface LiveScript {
  running: boolean;
  /** This script's own earnings — not a global player delta. */
  money_made: number;
  ram: number;
  uptime_seconds: number;
}
```

Add to `SubagentStatus`:

```ts
  /** This subagent's committed script, if it has one running. */
  live_script?: LiveScript | null;
```

Add to `GameState`, beside the other optional fields:

```ts
  /** Per-subagent committed-script stats, keyed by subagent_id. */
  live_scripts?: Record<string, LiveScript>;
```

- [ ] **Step 4: Export the stats from the dispatcher**

The state write currently happens before the queue is read. Move the queue read above it, then build the map. Replace the state-write block with:

```js
    // ── Read queue first so state can report running scripts ─────
    let queue = [];
    try {
      const raw = ns.read(QUEUE);
      queue = raw ? JSON.parse(raw) : [];
    } catch (_) {
      queue = [];
    }

    // ── Publish state ────────────────────────────────────────────
    try {
      const liveScripts = {};
      for (const t of queue) {
        if (t.status !== "running" || t.kind !== "committed" || !t.subagent_id) continue;
        let st = null;
        try { st = ns.getRunningScript(t.pid); } catch (_) { st = null; }
        liveScripts[t.subagent_id] = {
          running: !!st,
          money_made: st ? (st.onlineMoneyMade ?? 0) : 0,
          ram: st ? (st.ramUsage ?? 0) : 0,
          uptime_seconds: st ? (st.onlineRunningTime ?? 0) : 0,
        };
      }
      ns.write(
        STATE,
        JSON.stringify({
          current_money: Math.floor(money()),
          augments_installed: [],
          live_scripts: liveScripts,
          last_heartbeat_ms: Date.now(),
          timestamp: new Date().toISOString(),
        }),
        "w",
      );
    } catch (e) {
      try {
        ns.tprint("DISPATCHER STATE WRITE FAILED: " + (e && e.message ? e.message : String(e)));
      } catch (_) { /* terminal gone */ }
    }
```

Delete the now-duplicated queue read that followed.

- [ ] **Step 5: Thread it into `assembleInput`**

In `harness/orchestrator/loop.ts`, inside the `this.pool.list().map(...)`:

```ts
          live_script: this.latestState?.live_scripts?.[s.subagent_id] ?? null,
```

- [ ] **Step 6: Run the tests**

```bash
npx tsx --test test/orchestrator/live-script.test.ts && npm run typecheck && npm test
```

Expected: 2 new tests pass; 77 total.

- [ ] **Step 7: Verify the dispatcher is still under budget**

```bash
PUPPETEER_SKIP_DOWNLOAD=true npx tsx harness/game/ram-budget-smoke.ts
```

Expected: still `OK` on all shapes. `ns.getRunningScript` was already in the dispatcher's cost, so this adds nothing.

- [ ] **Step 8: Commit**

```bash
git add harness/types.ts harness/game/dispatcher.js harness/orchestrator/loop.ts test/orchestrator/live-script.test.ts
git commit -m "feat(orchestrator): report per-subagent script earnings

last_execution says whether an instruction produced a script that
started. Nothing said whether it was still earning: /__state.json
carried no running-script data, and money_gained is a global player
delta that cannot be attributed when several scripts run at once.

The per-script figure already existed — dispatcher.js:172 reads
ns.getRunningScript().onlineMoneyMade for probe results — and was simply
never written into the state export. Now it is, keyed by subagent, and
surfaced as SubagentStatus.live_script.

No RAM cost: getRunningScript was already in the dispatcher's budget."
```

---

## Task 6: Give the orchestrator the game's basics

**Files:**
- Create: `harness/game/docs.ts`
- Modify: `harness/orchestrator/prompt.ts`
- Create: `test/orchestrator/docs-prompt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BASIC_DOCS: readonly string[]`, `LIBRARY_DOCS: readonly string[]`, `loadDocs(names: readonly string[]): string`.

**Why:** The orchestrator is told the ns API and RAM costs but nothing about the world — that servers form a network, that RAM can be bought or borrowed, that programs open ports. The game ships that text, it is identical for every model, and it caches in the system prompt.

- [ ] **Step 1: Write the failing test**

Create `test/orchestrator/docs-prompt.test.ts`:

```ts
/**
 * The orchestrator gets the game's own Basic Mechanics text — mechanics,
 * not strategy. The tutorial (which walks through a working early-hack
 * script) and the optimal-batching guide stay out of the prompt and go
 * in-world, where a subagent must be sent to read them.
 */
import { strict as assert } from "node:assert";
import test, { describe } from "node:test";

import { BASIC_DOCS, LIBRARY_DOCS, loadDocs } from "../../harness/game/docs";
import { buildOrchestratorPrompt } from "../../harness/orchestrator/prompt";
import type { OrchestratorInput } from "../../harness/types";

const input: OrchestratorInput = {
  cycle_number: 1,
  elapsed_time_seconds: 0,
  total_duration_seconds: 1200,
  game_state: {
    current_money: 1262,
    starting_money: 1262,
    money_earned: 0,
    bitnode_id: 1,
    bitnode_complete: false,
  },
  subagent_status: [],
  delegation_history: [],
  available_subagent_models: ["m"],
};

describe("orchestrator docs", () => {
  test("loads the five basic files from the pinned game", () => {
    const text = loadDocs(BASIC_DOCS);
    assert.ok(text.length > 5000, `expected the basics, got ${text.length} chars`);
    assert.match(text, /purchase more RAM for your home computer/i);
  });

  test("the basics reach the system prompt", () => {
    const { system } = buildOrchestratorPrompt(input, 8675309);
    assert.match(system, /purchase more RAM for your home computer/i);
  });

  test("strategy guides are excluded from the prompt", () => {
    assert.equal(BASIC_DOCS.includes("help/getting_started.md"), false);
    assert.equal(BASIC_DOCS.includes("programming/hackingalgorithms.md"), false);
    assert.ok(LIBRARY_DOCS.includes("help/getting_started.md"));
    assert.ok(LIBRARY_DOCS.includes("programming/hackingalgorithms.md"));
  });

  test("the prompt does not leak the game's name", () => {
    const { leak_check_violations } = buildOrchestratorPrompt(input, 8675309);
    assert.deepEqual(leak_check_violations, []);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test test/orchestrator/docs-prompt.test.ts
```

Expected: FAIL — `Cannot find module '../../harness/game/docs'`.

- [ ] **Step 3: Create the doc loader**

Create `harness/game/docs.ts`:

```ts
/**
 * The game's own documentation, used two ways.
 *
 * BASIC_DOCS go verbatim into the orchestrator's system prompt: pure
 * mechanics, identical for every model, and stable so they cache. Using
 * the game's text rather than a briefing we author removes both the
 * authoring bias and the fairness gap between models that absorbed more
 * wiki content than others.
 *
 * LIBRARY_DOCS are pushed in-world instead. They include the tutorial
 * and the optimal-batching guide — strategy, not mechanics — so reading
 * them costs a subagent round trip that could have been spent earning.
 * That makes "send someone to read the manual?" an orchestration
 * decision rather than a freebie.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC_ROOT = path.resolve(
  HERE, "..", "..", "bitburner", "src", "src", "Documentation", "doc", "en",
);

/** Mechanics only. ~2,682 words. */
export const BASIC_DOCS = [
  "basic/ram.md",
  "basic/servers.md",
  "basic/hacking.md",
  "basic/scripts.md",
  "basic/programs.md",
] as const;

/** Pushed in-world; must be fetched by a subagent. */
export const LIBRARY_DOCS = [
  "help/getting_started.md",
  "programming/hackingalgorithms.md",
  "basic/stats.md",
  "basic/terminal.md",
  "basic/world.md",
] as const;

/** Concatenates docs with a heading per file. Throws if one is missing. */
export function loadDocs(names: readonly string[]): string {
  return names
    .map((name) => {
      const body = readFileSync(path.join(DOC_ROOT, name), "utf8").trim();
      return `--- ${name} ---\n${body}`;
    })
    .join("\n\n");
}

/** In-world filename for a doc. Bitburner allows only .txt/.json/.css. */
export function inWorldName(name: string): string {
  return `/doc/${name.replace(/\//g, "_").replace(/\.md$/, "")}.txt`;
}
```

- [ ] **Step 4: Inject the basics into the system prompt**

In `harness/orchestrator/prompt.ts`, import `{ BASIC_DOCS, loadDocs }` and add, before the JSON-schema paragraph:

```ts
`Reference — the environment's own documentation. This is mechanics, not strategy; deciding what to do with it is your job.

${loadDocs(BASIC_DOCS)}
`
```

Cache it at module load so it is read once per process:

```ts
const BASICS_TEXT = loadDocs(BASIC_DOCS);
```

and interpolate `${BASICS_TEXT}`.

- [ ] **Step 5: Check the leak detector still passes**

The docs are game text and will contain game vocabulary. `detectLeaks` runs over the built prompt and fails a run closed on `bitburner`, `bitnode`, `hacknet`, `augment`, or the seed.

```bash
npx tsx --test test/orchestrator/docs-prompt.test.ts
```

If the "does not leak" test fails, the offending token is in a doc file. **Do not weaken `detectLeaks`.** Instead, run each doc through the existing `scrubText` before interpolation:

```ts
const BASICS_TEXT = scrubText(loadDocs(BASIC_DOCS));
```

- [ ] **Step 6: Run the gates**

```bash
npm run typecheck && npm test
```

Expected: 4 new tests pass; 81 total.

- [ ] **Step 7: Commit**

```bash
git add harness/game/docs.ts harness/orchestrator/prompt.ts test/orchestrator/docs-prompt.test.ts
git commit -m "feat(orchestrator): give it the game's own Basic Mechanics docs

The orchestrator knew the ns API and its RAM costs but nothing about the
world it was managing — that servers form a network, that RAM can be
bought or borrowed from hacked machines, that programs open ports. It
had to infer all of it from subagent reports.

Adds the game's five Basic Mechanics files (~2,682 words) verbatim to
the system prompt, where they are identical across models and cache.
Using the game's own text rather than an authored briefing removes both
the authoring bias and the advantage a model gets from having absorbed
more wiki content.

The tutorial and the optimal-batching guide are deliberately excluded —
they demonstrate a strategy rather than describing mechanics, and go
in-world in the next change."
```

---

## Task 7: The in-world reference library

**Files:**
- Modify: `harness/game/puppeteer.ts` (`start()`)
- Modify: `harness/orchestrator/prompt.ts` (library paragraph)

**Interfaces:**
- Consumes: Task 6's `LIBRARY_DOCS`, `loadDocs`, `inWorldName`.
- Produces: `/doc/*.txt` and `/doc/index.txt` on `home` at boot.

**Why:** `ns.read` costs 0 GB, so anything on `home` is readable inside even a tight budget — but only by a subagent, and only if the orchestrator spends a round trip sending one.

- [ ] **Step 1: Push the library at boot**

In `PuppeteerGame.start()`, after the dispatcher is confirmed alive and before the bitnode probe, add:

```ts
    // In-world reference library. ns.read costs 0 GB, so a subagent can
    // read any of this inside the RAM budget — but only if the
    // orchestrator spends a subagent round trip sending one.
    try {
      const index: string[] = [];
      for (const name of LIBRARY_DOCS) {
        const file = inWorldName(name);
        await this.rfa!.pushFile(file, loadDocs([name]), "home");
        index.push(`${file}  (${name})`);
      }
      await this.rfa!.pushFile(
        "/doc/index.txt",
        [
          "Reference library. Read any entry with ns.read(path) — costs 0 GB.",
          "",
          ...index,
        ].join("\n"),
        "home",
      );
    } catch (e) {
      console.warn(`[game] doc library push failed: ${(e as Error).message}`);
    }
```

Import `{ LIBRARY_DOCS, loadDocs, inWorldName }` from `./docs`.

- [ ] **Step 2: Tell the orchestrator the library exists**

Add to `buildSystemPrompt`, after the basics block:

```ts
`Further reference exists inside the environment itself, not in this prompt. A file /doc/index.txt on the home machine lists additional documentation, and other readable files are scattered on machines across the network — some arrive on the home machine as your team's capability grows. Reading any of them costs no memory (ns.read is free), but a subagent has to be instructed to read one and report back, which costs that subagent's time. Deciding whether that is worth it is part of your job.`
```

- [ ] **Step 3: Verify in-game that a subagent can read it for 0 GB**

Add to `harness/game/ram-budget-smoke.ts`, inside `main()` before `game.stop()`:

```ts
    await game.submitScript({
      script_id: "docread",
      code:
        "/** @param {NS} ns */\nexport async function main(ns) {" +
        " const t = ns.read('/doc/index.txt');" +
        " ns.tprint('DOC_INDEX_LEN=' + (t ? t.length : 0));" +
        " ns.tprint('DOC_READ_RAM=' + ns.getScriptRam(ns.getScriptName(), 'home')); }",
    });
    const dr = await game.runScript({ script_id: "docread", subagent_id: "smoke", kind: "probe" });
    const len = Number(/DOC_INDEX_LEN=(\d+)/.exec(dr.stdout ?? "")?.[1]);
    if (!(len > 0)) {
      console.error("[ram] FAIL /doc/index.txt is missing or empty in-world");
      process.exit(1);
    }
    console.log(`[ram] OK   /doc/index.txt readable in-world (${len} chars)`);
```

- [ ] **Step 4: Run it**

```bash
PUPPETEER_SKIP_DOWNLOAD=true npx tsx harness/game/ram-budget-smoke.ts
```

Expected: all shapes `OK`, plus `/doc/index.txt readable in-world`.

- [ ] **Step 5: Run the gates**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean, 81 passing.

- [ ] **Step 6: Commit**

```bash
git add harness/game/puppeteer.ts harness/orchestrator/prompt.ts harness/game/ram-budget-smoke.ts
git commit -m "feat(game): push an in-world documentation library

The tutorial and the optimal-batching guide are pushed onto home as
/doc/*.txt at boot, with /doc/index.txt listing them. ns.read costs 0 GB
so a subagent can read any of it inside even the tight RAM budget — but
only if the orchestrator spends a subagent round trip sending one, which
makes research an orchestration decision with a real opportunity cost
rather than a freebie in the prompt.

This complements what the game already provides and needs no work: 69
.lit files across the network's servers, and .msg messages that arrive
on home as hacking level crosses 25/40/50.

Files land as .txt because hasTextExtension accepts only .txt/.json/.css.
rfa.pushFile was already generic; submitScript is a thin wrapper over it."
```

---

## Task 8: Update SPEC.md and VALIDATION.md

**Files:**
- Modify: `SPEC.md` (§2.1, §3.1, §3.2, §3.3)
- Modify: `VALIDATION.md` (new dated section)

**Interfaces:**
- Consumes: everything above.
- Produces: documentation only.

- [ ] **Step 1: Update SPEC §3.1 input schema**

In the `subagent_status` entry, after `last_execution`, add:

```json
      "live_script": {
        /* This subagent's committed script while it runs. Null if none.
           last_execution says whether the script STARTED; this says
           whether it is still EARNING. */
        "running": true,
        "money_made": 45000,
        "ram": 2.6,
        "uptime_seconds": 180
      },
```

And in `game_state`, add `"starting_money": 1262,` and `"money_earned": 0,` above `current_money`, with a note that `money_earned` is the score and `starting_money` is a given.

- [ ] **Step 2: Update SPEC §3.2 output schema**

Add `replace` to the action object with the note: *optional, `instruct` only, defaults to `false`; when true the subagent's running committed script is retired once the replacement is confirmed running.*

- [ ] **Step 3: Update SPEC §3.3**

Record that the system prompt now contains the game's Basic Mechanics documentation verbatim, that it is identical across models, and that the tutorial and hacking-algorithms guide are deliberately in-world instead.

- [ ] **Step 4: Add the VALIDATION.md comparability break**

At the top, mirroring the existing snapshot-cadence break:

```markdown
## ⚠️ Decision-space break — 2026-08-09

**Every result recorded below this line was produced under conditions
where the benchmark had one legal strategy, and is not comparable to
runs made after this date.**

Measured in-game on the pinned build: home is 8.00 GB and the dispatcher
consumed ~5.2 GB, leaving subagent scripts ~2.8 GB. After each script's
1.6 GB base cost that is ~1.2 GB of API budget — less than `ns.exec`
alone (1.3). So `exec`, `scp`+`exec` and `purchaseServer` were all
unstartable, and the only viable script shape was a single-host
hack/grow/weaken loop.

Consequences to hold onto:

1. **The 24h `09521fa2` result ($2,022,061) is not an orchestration
   result.** One subagent, an instruction every 60s, 16 distinct scripts
   across 1,430 delegations, and the identical four-line
   `while(true) ns.hack('foodnstuff')` committed 1,020 times. Because
   committing evicted the running script, the orchestrator restarted its
   own earner about once a minute for seventeen hours. The money came
   from a four-line script and a long clock.
2. **The $1,262 "floor" is starting capital, not score.** Runs that
   earned nothing published as $1,262. `RunSummary.final_money` is still
   absolute; a `money_earned` column is the honest follow-up.
3. **The golden-script comparison was never fair.** A hand-written
   script beating LLM teams reflected that everyone was confined to the
   same single strategy.

Runs after this line have a ~4.2 GB subagent budget, explicit script
replacement, per-subagent earnings, and the game's Basic Mechanics docs
in the orchestrator prompt.
```

- [ ] **Step 5: Commit**

```bash
git add SPEC.md VALIDATION.md
git commit -m "docs: record the decision-space break and the new input schema

SPEC §3.1/§3.2/§3.3 for live_script, money_earned/starting_money, the
replace action flag, and the Basic Mechanics docs now in the prompt.

VALIDATION.md gains a dated break mirroring the snapshot-cadence one:
every prior result was produced when the harness left ~2.8GB for
subagent scripts, under the 2.9GB ns.exec alone requires, so the
benchmark had exactly one legal strategy. That includes the 24h
\$2,022,061 result, which was a four-line script restarted 1,020 times."
```

---

## Task 9: End-to-end verification

**Files:**
- Modify: `config/run.opus-orch-sonnet-sub.yaml` (comment only)

**Interfaces:**
- Consumes: all previous tasks.
- Produces: evidence the decision space actually opened.

- [ ] **Step 1: Run the RAM smoke test one final time**

```bash
PUPPETEER_SKIP_DOWNLOAD=true npx tsx harness/game/ram-budget-smoke.ts
```

Expected: dispatcher under 4.0 GB, all three strategy shapes `OK`, `/doc/index.txt` readable.

- [ ] **Step 2: Run a real 8-minute run**

```bash
BENCHBURNER_CONFIG=config/run.opus-orch-sonnet-sub.yaml npx tsx harness/index.ts
```

In a second terminal: `npm run viewer` → <http://127.0.0.1:8099>.

- [ ] **Step 3: Check the four predictions**

Against `results/<run_id>/`:

1. **`money_earned` starts at 0** — grep `orchestrator-prompts.log` for `money_earned`; the first cycle must show `0`, not `1262`.
2. **At least one script uses a formerly-impossible API** — grep `scripts.json` for `ns.exec`, `ns.scp` or `ns.purchaseServer`. If none appears, the orchestrator chose not to; check its `cycles.json` reasoning to see whether it *considered* it. That distinction matters: the strategy space being open is what this change guarantees, not that it gets used.
3. **No 1,020-restart pattern** — count distinct `code` values in `delegations.json` against the delegation count. Repeated identical commits should now require an explicit `replace: true`.
4. **`live_script` appears** — grep `orchestrator-prompts.log` for `live_script` with a non-null `money_made`.

- [ ] **Step 4: Record the outcome in VALIDATION.md**

Add an evidence line under the new break with the run id, `final_money`, `money_earned`, and which of the four predictions held. **If runs still converge on one script shape, say so** — the next suspects are loop latency (~4 closed loops per run) and the 20-minute duration, both explicit non-goals here.

- [ ] **Step 5: Reset out the auto-committed artifacts and commit**

The harness `git commit`s `results/` at run end; per `42c397c` those belong on `orchestrator/*` branches.

```bash
git reset --mixed HEAD~1 && rm -rf results/*/
git add VALIDATION.md config/run.opus-orch-sonnet-sub.yaml
git commit -m "docs(validation): end-to-end evidence for the decision-space change"
```

---

## Self-Review

**Spec coverage.** §1 explicit replace → Task 3. §2 kill kills the script → Task 4. §3 per-subagent earnings → Task 5. §4 RAM reclaim → Task 1. §5 basics in prompt → Task 6. §6 in-world library → Task 7. §7 money delta → Task 2. §8 prompt changes → distributed across Tasks 2, 3, 6, 7. Schema table → Tasks 1-7. Testing 1-10 → Tasks 1-7 plus Task 9. Comparability → Task 8. All covered.

**Type consistency.** `LiveScript` fields (`running`, `money_made`, `ram`, `uptime_seconds`) are identical in Task 5's type, the dispatcher writer, and the test. `evictionTargets(queue, incoming)` matches between `eviction.ts`, its test, and the dispatcher's mirrored inline copy. `killScript(subagent_id)` matches across the interface, both implementations, and `handleKill`. `replace` is spelled the same in `OrchestratorAction`, the queue entry, `runScript`, and the dispatcher.

**Known duplication, deliberate.** The eviction rule exists twice: `harness/game/eviction.ts` (tested) and inline in `dispatcher.js` (executed). `dispatcher.js` is pushed into the game as plain Netscript and cannot import from the harness. Task 3 Step 5 flags the pairing in a comment.

**Ordering.** Task 1 must land first — it is the enabler, and its smoke test is the guard every later task re-runs. Tasks 2-5 are independent of one another. Task 7 depends on Task 6's `docs.ts`. Tasks 8-9 last.
