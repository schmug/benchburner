/**
 * Single source of truth for the home-RAM budget.
 *
 * This figure is the constraint both models plan against, and it used to
 * be a hand-maintained literal in three independent files: the subagent
 * prompt (twice), the orchestrator prompt, and the smoke guard. That is
 * not hypothetical duplication — it is how a bug shipped. The 1.4 GB
 * reclaim (dispatcher 5.2 -> 3.8 GB) updated the subagent prompt and
 * left the orchestrator prompt saying "approximately 3 GB". Because the
 * orchestrator authors its subagents' instructions, a manager capping
 * the team at 3 GB overrides the subagent's own corrected prompt, so the
 * whole reclaim was inert until a second review caught it.
 *
 * Everything downstream derives from MAX_DISPATCHER_GB. Nothing restates
 * it. test/game/ram-budget.test.ts fails if either prompt drifts.
 *
 * ## The 4.0-vs-4.2 skew, and why the cap moved
 *
 * The guard originally capped the dispatcher at 4.0 GB while both
 * prompts quoted 4.2 GB free. Those cannot both be right: a regression
 * to exactly 4.0 GB passed the guard while the prompts overstated the
 * budget by 0.2 GB, which is enough to make ns.purchaseServer (3.85 GB)
 * unstartable for a subagent that was told it had room.
 *
 * Resolved by tightening the cap to the measured 3.8 GB rather than
 * relaxing the prompts to 4.0 GB. The prompts are the contract the
 * models plan against and 4.2 GB is the measured truth; the cap is only
 * a guard, and a guard that permits 0.2 GB of undetected drift into the
 * contract is not doing its job. Loosening the contract to match a round
 * number picked for the guard would have lowered the real budget, which
 * this refactor is explicitly not allowed to do.
 *
 * Consequence, and it is intended: the cap now has no slack. Any
 * dispatcher growth at all fails the smoke, because any dispatcher
 * growth at all falsifies the 4.2 GB both prompts promise. Re-measure
 * and change this one constant — the prompts and the guard follow.
 */

/** home's total RAM in the pinned Bitburner build. */
export const HOME_RAM_GB = 8;

/**
 * Hard cap on what /__dispatcher.js may consume of home.
 *
 * Equal to the measured post-reclaim figure (see
 * docs/superpowers/specs/2026-08-09-script-lifecycle-and-attribution-design.md).
 */
export const MAX_DISPATCHER_GB = 3.8;

/**
 * What is actually left for subagent scripts. Exact in IEEE754:
 * 8 - 3.8 === 4.2.
 */
export const SUBAGENT_RAM_BUDGET_GB = HOME_RAM_GB - MAX_DISPATCHER_GB;

/**
 * The game's own static RAM costs, from the pinned BITBURNER_COMMIT:
 * bitburner/src/src/Netscript/RamCostGenerator.ts (`RamCostConstants`
 * for base/exec/scp, the `purchaseServer` entry for the last).
 *
 * Copied rather than imported for the same reason the basic docs are
 * vendored: ci.yml runs on `submodules: false`, so nothing on the test
 * path may read the submodule tree.
 */
export const RAM_COST_GB = {
  /** Every script pays this before referencing a single ns.* call. */
  base: 1.6,
  exec: 1.3,
  scp: 0.6,
  purchaseServer: 2.25,
} as const;

/**
 * The three script shapes the reclaim was for, and the reason the
 * benchmark has more than one legal strategy. Before the reclaim only
 * the first fit, so a single-host hack loop was the only startable
 * shape.
 *
 * Order is the order the orchestrator prompt renders them in.
 */
export const STRATEGY_SHAPES: ReadonlyArray<{ name: string; costGb: number }> = [
  { name: "ns.exec", costGb: RAM_COST_GB.base + RAM_COST_GB.exec },
  { name: "ns.scp + ns.exec", costGb: RAM_COST_GB.base + RAM_COST_GB.scp + RAM_COST_GB.exec },
  { name: "ns.purchaseServer", costGb: RAM_COST_GB.base + RAM_COST_GB.purchaseServer },
];

/**
 * Renders a GB figure for prompt interpolation.
 *
 * Necessary because the derived sums carry binary-float noise —
 * 1.6 + 1.3 is 2.9000000000000004 — and shipping that into a system
 * prompt would be both wrong-looking and a fairness wart, since the
 * prompt text must be identical for every model.
 */
export function gb(value: number): string {
  return String(Number(value.toFixed(2)));
}
