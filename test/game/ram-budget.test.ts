/**
 * The home-RAM budget is the constraint both models actually plan
 * against, so a stale figure silently deletes strategies from the
 * benchmark. It used to be a hand-maintained literal in three files, and
 * that is exactly how it broke: the 1.4 GB reclaim (dispatcher 5.2 ->
 * 3.8 GB) updated the subagent prompt but left the orchestrator prompt
 * saying "~3 GB". Since the orchestrator authors the subagent's
 * instructions, a manager capping its team at 3 GB overrides the
 * subagent's own corrected prompt — the reclaim bought nothing.
 *
 * So these tests pin BOTH prompts, not just one, against the single
 * exported constant in harness/game/ram-budget.ts.
 *
 * The anchors below capture the *number* out of fixed *wording*. That
 * shape is deliberate: editing a figure in either prompt leaves the
 * anchor matching and the value wrong (assert fails), while deleting the
 * sentence drops the match count (assert fails). Both directions of
 * drift are caught.
 *
 * Everything here must pass with NO submodule checked out — same rule as
 * test/orchestrator/docs-prompt.test.ts. Do not add an assertion that
 * reads the submodule tree.
 */

import { strict as assert } from "node:assert";
import test, { describe } from "node:test";

import {
  HOME_RAM_GB,
  MAX_DISPATCHER_GB,
  STRATEGY_SHAPES,
  SUBAGENT_RAM_BUDGET_GB,
  gb,
} from "../../harness/game/ram-budget";
import { buildSystemPrompt } from "../../harness/orchestrator/prompt";
import { SUBAGENT_SYSTEM_PROMPT } from "../../harness/subagent/worker";

const ORCHESTRATOR_SYSTEM_PROMPT = buildSystemPrompt(20 * 60);

/** Pulls the figure out of each anchor, asserting every anchor matched. */
function statedFigures(prompt: string, anchors: RegExp[]): number[] {
  return anchors.map((re) => {
    const m = re.exec(prompt);
    assert.ok(m, `prompt no longer contains the budget claim ${re}`);
    return Number(m[1]);
  });
}

describe("ram-budget constants", () => {
  test("the free budget is home RAM minus the dispatcher cap", () => {
    assert.equal(SUBAGENT_RAM_BUDGET_GB, HOME_RAM_GB - MAX_DISPATCHER_GB);
  });

  test("the cap is the measured dispatcher figure, not a looser round number", () => {
    // The 4.0 cap that shipped with the guard was 0.2 GB looser than the
    // 4.2 GB both prompts quote: a regression to exactly 4.0 passed the
    // guard while the prompts overstated the budget. See the module
    // comment for why the cap moved to the measurement rather than the
    // quoted budget moving to the cap.
    assert.equal(MAX_DISPATCHER_GB, 3.8);
    assert.equal(SUBAGENT_RAM_BUDGET_GB, 4.2);
  });

  test("every strategy shape the reclaim was for still fits the budget", () => {
    for (const shape of STRATEGY_SHAPES) {
      assert.ok(
        shape.costGb <= SUBAGENT_RAM_BUDGET_GB,
        `${shape.name} needs ${shape.costGb} GB but the budget is ${SUBAGENT_RAM_BUDGET_GB} GB`,
      );
    }
  });

  test("gb() renders derived sums without float noise", () => {
    // 1.6 + 1.3 is 2.9000000000000004 in IEEE754; that must never reach
    // a prompt. Asserted on literals so this stays a test of the
    // formatter and not of whatever the budget currently is.
    assert.equal(gb(1.6 + 1.3), "2.9");
    assert.equal(gb(8 - 3.8), "4.2");
    assert.equal(gb(8), "8");
    assert.equal(gb(3.85), "3.85");
  });

  test("no prompt figure renders with float noise", () => {
    for (const prompt of [SUBAGENT_SYSTEM_PROMPT, ORCHESTRATOR_SYSTEM_PROMPT]) {
      assert.doesNotMatch(prompt, /\d\.\d{3,} GB/, "a derived sum leaked its binary-float tail into the prompt");
    }
  });
});

describe("subagent system prompt RAM budget", () => {
  test("both budget claims come from the constant", () => {
    const stated = statedFigures(SUBAGENT_SYSTEM_PROMPT, [
      /~([\d.]+) GB of RAM available/,
      /exceed ~([\d.]+) GB/,
    ]);

    assert.equal(stated.length, 2, "the environment blurb and the RAM-discipline rule both state a budget");
    for (const figure of stated) {
      assert.equal(figure, SUBAGENT_RAM_BUDGET_GB, `prompt states ${figure} GB; the budget is ${SUBAGENT_RAM_BUDGET_GB} GB`);
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

describe("orchestrator system prompt RAM budget", () => {
  test("host, dispatcher, and free-budget claims all come from the constants", () => {
    const [home, dispatcher, ...budgets] = statedFigures(ORCHESTRATOR_SYSTEM_PROMPT, [
      /host with ~([\d.]+) GB of memory/,
      /using about ([\d.]+) GB for its process bookkeeping/,
      /leaving approximately ([\d.]+) GB/,
      /counts against that ([\d.]+) GB/,
      /fit in the ([\d.]+) GB budget/,
    ]);

    assert.equal(home, HOME_RAM_GB);
    assert.equal(dispatcher, MAX_DISPATCHER_GB);
    for (const figure of budgets) {
      assert.equal(figure, SUBAGENT_RAM_BUDGET_GB, `prompt states ${figure} GB; the budget is ${SUBAGENT_RAM_BUDGET_GB} GB`);
    }
  });

  test("the arithmetic it hands the orchestrator is internally consistent", () => {
    const [home, dispatcher, free] = statedFigures(ORCHESTRATOR_SYSTEM_PROMPT, [
      /host with ~([\d.]+) GB of memory/,
      /using about ([\d.]+) GB for its process bookkeeping/,
      /leaving approximately ([\d.]+) GB/,
    ]);

    assert.equal(home - dispatcher, free, "the prompt tells the orchestrator to do subtraction that does not work out");
  });

  test("per-shape costs are derived, not restated", () => {
    // These three were pinned by no test and could drift silently. They
    // are the sums in STRATEGY_SHAPES, so the assertion is that the
    // prompt renders those sums and not hand-typed copies of them.
    const stated = statedFigures(ORCHESTRATOR_SYSTEM_PROMPT, [
      /ns\.exec costs ([\d.]+) GB in total/,
      /ns\.scp plus ns\.exec ([\d.]+) GB/,
      /ns\.purchaseServer ([\d.]+) GB/,
    ]);

    assert.deepEqual(stated, STRATEGY_SHAPES.map((s) => Number(gb(s.costGb))));
  });

  test("does not still advertise the pre-reclaim 3 GB ceiling", () => {
    assert.doesNotMatch(
      ORCHESTRATOR_SYSTEM_PROMPT,
      /approximately 3 GB|about 3 GB/,
      "PR #37 left exactly this stale figure here while fixing the subagent prompt",
    );
  });

  test("stays fixed across models — SPEC §3.3 fairness", () => {
    // Interpolating a constant is fine; per-model text is not. The only
    // legal run-dependent substitution is the duration.
    assert.equal(buildSystemPrompt(20 * 60), ORCHESTRATOR_SYSTEM_PROMPT);
  });
});
