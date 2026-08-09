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
