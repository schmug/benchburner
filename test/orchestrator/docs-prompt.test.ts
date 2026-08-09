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

  test("the basics are mechanics-only, and the two sets are disjoint", () => {
    // The check above is a two-name denylist, so it would stay green if
    // some *other* strategy doc (`advanced/*.md`, `programming/learn.md`)
    // were added to BASIC_DOCS tomorrow. Assert the shape of the whole
    // set instead: a free doc must come from `basic/` (mechanics), and
    // nothing a subagent has to be sent to fetch may also be free.
    for (const name of BASIC_DOCS) {
      assert.ok(name.startsWith("basic/"), `${name} is not a basic/ mechanics doc`);
    }
    for (const name of BASIC_DOCS) {
      assert.equal(
        LIBRARY_DOCS.includes(name),
        false,
        `${name} is in both BASIC_DOCS and LIBRARY_DOCS`,
      );
    }
  });

  test("a missing doc names the file and how to fix it", () => {
    // This is the first error a fresh cloner hits; a bare ENOENT on a
    // path deep inside the submodule doesn't tell them what to do.
    assert.throws(
      () => loadDocs(["basic/not-a-real-doc.md"]),
      (err: Error) => {
        assert.match(err.message, /basic\/not-a-real-doc\.md/);
        assert.match(err.message, /git submodule update --init --recursive/);
        return true;
      },
    );
  });

  test("the prompt does not leak the game's name", () => {
    const { leak_check_violations } = buildOrchestratorPrompt(input, 8675309);
    assert.deepEqual(leak_check_violations, []);
  });
});
