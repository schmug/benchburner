/** @param {NS} ns */
// Light dispatcher used in golden-script / validation modes. Does
// NOT process /__queue.json (no ns.run / ns.isRunning / ns.kill), so
// its static Netscript RAM cost stays small enough that a 4-GB
// golden script can coexist on the default 8-GB home.
//
// Estimated RAM: 1.6 (base) + 0.5 (getPlayer) + 1.0 (getResetInfo) = 3.1 GB.
// Previous full dispatcher was ~4.7 GB — that left no room for a
// second script to start.
//
// The full dispatcher (dispatcher.js) still runs in the normal
// orchestrated mode where there's no competing long-running script.
export async function main(ns) {
  ns.disableLog("ALL");
  const STATE = "/__state.json";

  while (true) {
    // last_heartbeat_ms lets the harness tell a running dispatcher
    // from one that wrote /__state.json once and then died. Surface
    // any write failure to the in-game log instead of swallowing it
    // — silent failures produce a stale heartbeat that looks
    // identical to a dead loop.
    try {
      const p = ns.getPlayer();
      const ri = ns.getResetInfo();
      ns.write(
        STATE,
        JSON.stringify({
          current_money: Math.floor(p.money),
          bitnode_id: ri.currentNode,
          bitnode_complete: false,
          augments_installed: [],
          last_heartbeat_ms: Date.now(),
          timestamp: new Date().toISOString(),
        }),
        "w",
      );
    } catch (e) {
      try {
        ns.tprint("DISPATCHER-LIGHT STATE WRITE FAILED: " + (e && e.message ? e.message : String(e)));
      } catch (_) { /* terminal gone — nothing more we can do */ }
    }
    await ns.sleep(1000);
  }
}
