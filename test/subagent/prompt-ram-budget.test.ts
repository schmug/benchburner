/**
 * The subagent's system prompt states the home-RAM budget its scripts
 * must fit inside. That figure is not decoration — it is the constraint
 * the model actually plans against, so a stale one silently deletes
 * strategies from the benchmark.
 *
 * Reclaiming 1.4 GB from the dispatcher (5.2 -> 3.8 GB) raised the
 * subagent budget from 2.8 to 4.2 GB, which is what makes
 * ns.scp+ns.exec (3.5 GB) and ns.purchaseServer (3.85 GB) startable for
 * the first time. While the prompt still said "~3 GB", a subagent
 * obeying it would never emit either shape — the reclaimed RAM was
 * unreachable and the guarded invariant bought nothing.
 *
 * Kept in sync by hand with harness/game/ram-budget-smoke.ts, which
 * caps the dispatcher at 4.0 GB of home's 8 GB.
 */

import { strict as assert } from "node:assert";
import test, { describe } from "node:test";

import { SUBAGENT_SYSTEM_PROMPT } from "../../harness/subagent/worker";

describe("subagent system prompt RAM budget", () => {
  test("states the measured 4.2 GB budget", () => {
    const stated = [...SUBAGENT_SYSTEM_PROMPT.matchAll(/~([\d.]+)\s*GB of RAM available|exceed ~([\d.]+)\s*GB/g)]
      .map((m) => Number(m[1] ?? m[2]));

    assert.equal(stated.length, 2, "both the environment blurb and the RAM-discipline rule state a budget");
    for (const gb of stated) {
      assert.equal(gb, 4.2, `prompt states ${gb} GB; the measured free budget is 4.2 GB`);
    }
  });

  test("does not still advertise the pre-reclaim 3 GB ceiling", () => {
    assert.doesNotMatch(
      SUBAGENT_SYSTEM_PROMPT,
      /~3 GB/,
      "a 3 GB ceiling forbids the scp+exec (3.5) and purchaseServer (3.85) shapes",
    );
  });

  test("still warns off the expensive calls, getResetInfo included", () => {
    // ns.getResetInfo is exactly what was cut from the dispatcher for
    // costing 1 GB to read a run-constant; subagents should avoid it too.
    assert.match(SUBAGENT_SYSTEM_PROMPT, /ns\.getResetInfo \(1 GB\)/);
    assert.match(SUBAGENT_SYSTEM_PROMPT, /ns\.getServer \(2 GB/);
  });
});
