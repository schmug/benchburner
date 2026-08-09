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
