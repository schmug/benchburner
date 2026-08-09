/**
 * The orchestrator was reading its own starting capital as revenue.
 * Bitburner starts the player at $1,262, and every run that earned
 * nothing still showed `current_money: 1262`, which the model read as
 * earnings — in one run declining a RAM investment because of it.
 *
 * `scrubInput` rebuilds game_state as an explicit key list with no
 * spread, so these tests are the proof the new keys actually reach the
 * model rather than dying at the whitelist.
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
    assert.match(system, /maximize the money your team EARNS/);
    assert.match(system, /starting balance/);
    assert.doesNotMatch(
      system,
      /maximize the team's in-game money in the/,
      "the old balance-framed goal sentence must be gone",
    );
  });
});
