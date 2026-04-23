/**
 * Hand-written golden script for Phase 0 Step 1 of VALIDATION.md.
 *
 * RAM-conscious rewrite. The previous version used ns.getServer (2 GB)
 * and ns.hackAnalyzeChance (1 GB), which put the script at 5.6 GB and
 * broke co-residency with the light dispatcher (3.1 GB) on home's
 * 8 GB. This version uses the individual get*() functions at 0.1-0.25
 * GB each and caches min/max (which don't change), landing at ~2.65
 * GB total. Light dispatcher + this = 5.75 GB, fits comfortably.
 *
 * RAM budget (home = 8 GB; must coexist with dispatcher-light):
 *   base:                      1.6
 *   ns.hasRootAccess:          0.05
 *   ns.nuke:                   0.05
 *   ns.getServerSecurityLevel: 0.1
 *   ns.getServerMinSecurityLevel: 0.1
 *   ns.getServerMoneyAvailable: 0.1
 *   ns.getServerMaxMoney:      0.25
 *   ns.weaken:                 0.15
 *   ns.grow:                   0.15
 *   ns.hack:                   0.1
 *   total:                    ~2.65 GB
 *
 * @param {NS} ns
 */
export async function main(ns) {
  const target = "n00dles";
  ns.disableLog("ALL");

  if (!ns.hasRootAccess(target)) {
    ns.nuke(target);
  }

  // Cached constants — don't change for a given server.
  const minSec = ns.getServerMinSecurityLevel(target);
  const maxMoney = ns.getServerMaxMoney(target);

  let iter = 0;
  let earned = 0;
  let lastAction = "(none)";
  let lastHack = 0;

  while (true) {
    iter += 1;
    const curSec = ns.getServerSecurityLevel(target);
    const curMoney = ns.getServerMoneyAvailable(target);

    // Validation-grade strategy: maintain security, then hack. Don't
    // bother growing — on a fresh boot n00dles starts with ~4% of its
    // max money and growing to half would take hours with a slow
    // single-thread grow. We're proving *any* money movement, not
    // optimizing yield; tight hack calls earn something now.
    if (curSec > minSec + 3) {
      lastAction = "weaken";
      await ns.weaken(target);
    } else {
      lastAction = "hack";
      const got = await ns.hack(target);
      lastHack = got;
      earned += got;
    }

    // Diagnostic write — harness reads via RFA.
    try {
      ns.write(
        "/__golden_diag.json",
        JSON.stringify({
          iteration: iter,
          last_action: lastAction,
          last_hack_return: Math.floor(lastHack),
          total_earned: Math.floor(earned),
          target_money_available: Math.floor(curMoney),
          target_security: curSec,
          target_min_security: minSec,
          target_max_money: Math.floor(maxMoney),
          timestamp: new Date().toISOString(),
        }),
        "w",
      );
    } catch (_) {
      /* best effort */
    }
  }
}
