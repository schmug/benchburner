/**
 * Guards the invariant that makes this benchmark have more than one
 * legal strategy: the dispatcher must leave enough home RAM for a
 * subagent script to call ns.exec / ns.scp / ns.purchaseServer.
 *
 * Before this guard existed the dispatcher used 5.2 GB of home's 8 GB,
 * leaving 2.8 GB — under the 2.9 GB an ns.exec script needs — so the
 * only startable script shape was a single-host hack loop.
 *
 * The probe reports via ns.print rather than ns.tprint: tprint writes to
 * the game terminal, and only the script's own log buffer is captured
 * into ExecutionResult.stdout (dispatcher.js reads stats.logs).
 *
 * Usage: npx tsx harness/game/ram-budget-smoke.ts
 */
import { PuppeteerGame } from "./puppeteer";

const MAX_DISPATCHER_GB = 4.0;

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
