/**
 * Which running scripts a newly-started committed task displaces.
 *
 * Extracted from dispatcher.js so the rule is unit-testable without a
 * browser. dispatcher.js keeps its own inlined copy — it is pushed into
 * the game as plain Netscript and cannot import from the harness — so
 * the two must be kept in step by hand. `test/game/dispatcher-runtime.test.ts`
 * drives the real dispatcher against a fake `ns` and asserts the inline
 * copy agrees with this one, which is the only thing standing between a
 * divergence and a silent regression in-game.
 *
 * Two properties matter and both are load-bearing:
 *
 * 1. **Opt-in.** `replace` must be exactly `true`. Absent, false, or any
 *    truthy-but-not-true value evicts nothing. Committing used to evict
 *    unconditionally, which is how one run restarted its own earner 1,020
 *    times.
 * 2. **Own-subagent, committed, already running.** Another subagent's
 *    script is not this instruction's to kill; a probe never occupies the
 *    committed slot; and a pending sibling has no pid to kill yet.
 */
export interface QueueTask {
  subagent_id?: string;
  pid?: number;
  status?: string;
  kind?: string;
  replace?: boolean;
  /**
   * Set by `PuppeteerGame.killScript` and consumed by the dispatcher on
   * its next tick. Kill requests ride /__queue.json rather than a second
   * control file — the dispatcher already reads that file every tick and
   * already holds the pid.
   */
  kill_requested?: boolean;
}

export function evictionTargets<T extends QueueTask>(queue: T[], incoming: T): T[] {
  if (incoming.replace !== true) return [];
  return queue.filter(
    (other) =>
      other !== incoming &&
      other.status === "running" &&
      other.kind === "committed" &&
      other.subagent_id === incoming.subagent_id,
  );
}

/**
 * Which queue entries a `kill` of `subagent_id` has to stop.
 *
 * Differs from `evictionTargets` in one deliberate way: it claims
 * **pending** entries as well as running ones. A committed script sitting
 * in the queue is at most one dispatcher tick (~500 ms) from `ns.run`, and
 * a kill that skips it lets the script start moments after its owner was
 * deleted from the pool — an orphan with no track, still holding RAM,
 * still earning, and with nothing left that knows how to stop it. That is
 * precisely the failure `kill` exists to prevent, so the narrow window
 * gets closed rather than documented.
 *
 * Probes are untouched: they belong to the subagent's own
 * write-run-observe loop and the dispatcher bounds them at 120 s anyway.
 *
 * Ids are compared exactly. They are model-prefixed uuids assigned by the
 * harness, so a case or prefix variant is a different subagent, not a
 * sloppy spelling of this one.
 */
export function killTargets<T extends QueueTask>(queue: T[], subagent_id: string): T[] {
  return queue.filter(
    (t) =>
      t.subagent_id === subagent_id &&
      t.kind === "committed" &&
      (t.status === "running" || t.status === "pending"),
  );
}
