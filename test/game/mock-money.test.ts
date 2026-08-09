/**
 * PR #55 (issue #43, N5) made GameState carry starting_money and
 * money_earned so orchestrators score on the delta, not the balance.
 * MockGame was left out, so mock-driven smoke runs hit the scrub
 * fallback in prompt.ts (`gs.money_earned ?? 0`) and show the
 * orchestrator a score frozen at 0 while current_money climbs.
 *
 * Pinned here: every snapshot the mock hands out — readState() and the
 * per-execution game_state_snapshot alike — reports the same delta the
 * real controller does. The mock's baseline is its STARTING_MONEY
 * constant (1000), known at construction, so no capture dance is
 * needed. (Issue #57.)
 */

import { strict as assert } from "node:assert";
import test, { describe } from "node:test";

import { MockGame } from "../../harness/game/mock";
import type { ExecutionResult } from "../../harness/types";

const STARTING_MONEY = 1000;

/** Run the one submitted script until a run actually gains money. */
async function runUntilGain(game: MockGame): Promise<ExecutionResult> {
  // Deterministic seed, so once this finds a gaining run it always
  // will; the loop only rides out the mock's 5% failure coin flips.
  let result: ExecutionResult;
  let attempts = 0;
  do {
    result = await game.runScript({ script_id: "s1", subagent_id: "sub-1" });
    attempts++;
  } while (result.money_gained === 0 && attempts < 10);
  assert.ok(result.money_gained > 0, "precondition: a script run gained money");
  return result;
}

describe("MockGame money baseline", () => {
  test("readState() reports starting_money and money_earned as the delta", async () => {
    const game = new MockGame({ seed: 1 });
    await game.start();
    await game.submitScript({ script_id: "s1", code: "// noop" });
    await runUntilGain(game);

    const state = await game.readState();
    assert.ok(state.current_money > STARTING_MONEY);
    assert.equal(state.starting_money, STARTING_MONEY);
    assert.equal(state.money_earned, state.current_money - STARTING_MONEY);
  });

  test("execution-result snapshots carry the same baseline fields", async () => {
    const game = new MockGame({ seed: 1 });
    await game.start();
    await game.submitScript({ script_id: "s1", code: "// noop" });
    const result = await runUntilGain(game);

    const snapshot = result.game_state_snapshot;
    assert.equal(snapshot.starting_money, STARTING_MONEY);
    assert.equal(snapshot.money_earned, snapshot.current_money - STARTING_MONEY);
  });
});
