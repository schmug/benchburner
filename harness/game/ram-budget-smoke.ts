/**
 * Guards the invariant that makes this benchmark have more than one
 * legal strategy: the dispatcher must leave enough home RAM for a
 * subagent script to call ns.exec / ns.scp / ns.purchaseServer.
 *
 * Before this guard existed the dispatcher used 5.2 GB of home's 8 GB,
 * leaving 2.8 GB — under the 2.9 GB an ns.exec script needs — so the
 * only startable script shape was a single-host hack loop.
 *
 * Every threshold here derives from ./ram-budget, which is also what
 * both system prompts interpolate. The guard and the prompts cannot
 * disagree any more; they used to, by 0.2 GB, and that module's comment
 * records how the skew was resolved.
 *
 * The probe reports via ns.print rather than ns.tprint: tprint writes to
 * the game terminal, and only the script's own log buffer is captured
 * into ExecutionResult.stdout (dispatcher.js reads stats.logs).
 *
 * Usage: npx tsx harness/game/ram-budget-smoke.ts
 */
import { PuppeteerGame } from "./puppeteer";
import { HOME_RAM_GB, MAX_DISPATCHER_GB, STRATEGY_SHAPES, SUBAGENT_RAM_BUDGET_GB, gb } from "./ram-budget";

const probe = `/** @param {NS} ns */
export async function main(ns) {
  ns.print('DISPATCHER_RAM=' + ns.getScriptRam('/__dispatcher.js', 'home'));
  ns.print('HOME_MAX=' + ns.getServerMaxRam('home'));
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

    let failed = false;

    // SUBAGENT_RAM_BUDGET_GB is derived as HOME_RAM_GB - MAX_DISPATCHER_GB,
    // so a home that is not what the constant assumes silently falsifies
    // the budget both prompts quote. Check the assumption, not just the
    // dispatcher.
    if (home !== HOME_RAM_GB) {
      console.error(`[ram] FAIL home is ${home}GB; ram-budget.ts derives the budget from ${HOME_RAM_GB}GB`);
      failed = true;
    }
    if (dispatcher > MAX_DISPATCHER_GB) {
      console.error(`[ram] FAIL dispatcher ${dispatcher}GB exceeds ${MAX_DISPATCHER_GB}GB cap`);
      failed = true;
    }
    if (free < SUBAGENT_RAM_BUDGET_GB) {
      console.error(`[ram] FAIL free ${free}GB is under the ${SUBAGENT_RAM_BUDGET_GB}GB both prompts promise`);
      failed = true;
    }
    for (const { name, costGb } of STRATEGY_SHAPES) {
      const ok = costGb <= free;
      // gb() because the derived sums carry float noise: 1.6 + 1.3 logs
      // as 2.9000000000000004 raw.
      console.log(`[ram] ${ok ? "OK  " : "FAIL"} ${name} needs ${gb(costGb)}GB, free ${gb(free)}GB`);
      if (!ok) failed = true;
    }
    if (failed) process.exit(1);
    console.log("[ram] all strategy shapes are startable");
  } finally {
    await game.stop();
  }
}
void main();
