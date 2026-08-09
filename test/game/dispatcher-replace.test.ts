/**
 * Committing a script used to evict the subagent's running one
 * unconditionally. In the 24h run that meant killing and restarting the
 * same earning script 1,020 times.
 *
 * Eviction is now opt-in AND ordered: the predecessor dies only after
 * the replacement is confirmed running, so a failed start cannot cost
 * the income it was meant to preserve. This file pins the *rule*; the
 * ordering it depends on is pinned by test/game/dispatcher-runtime.test.ts,
 * which drives dispatcher.js itself.
 */
import { strict as assert } from "node:assert";
import test, { describe } from "node:test";

import { evictionTargets, killTargets, type QueueTask } from "../../harness/game/eviction";

const running = (subagent_id: string, pid: number): QueueTask => ({
  subagent_id,
  pid,
  status: "running",
  kind: "committed",
});

describe("dispatcher eviction", () => {
  test("replace omitted evicts nothing — the regression guard", () => {
    const incoming: QueueTask = { subagent_id: "a", status: "pending", kind: "committed" };
    assert.deepEqual(evictionTargets([running("a", 1), incoming], incoming), []);
  });

  test("replace false evicts nothing", () => {
    const incoming: QueueTask = {
      subagent_id: "a",
      status: "pending",
      kind: "committed",
      replace: false,
    };
    assert.deepEqual(evictionTargets([running("a", 1), incoming], incoming), []);
  });

  test("replace true evicts only that subagent's running committed script", () => {
    const incoming: QueueTask = {
      subagent_id: "a",
      status: "pending",
      kind: "committed",
      replace: true,
    };
    const queue = [running("a", 1), running("b", 2), incoming];
    assert.deepEqual(
      evictionTargets(queue, incoming).map((t) => t.pid),
      [1],
      "must not touch another subagent's script",
    );
  });

  test("probes are never evicted", () => {
    const incoming: QueueTask = {
      subagent_id: "a",
      status: "pending",
      kind: "committed",
      replace: true,
    };
    const probe: QueueTask = { subagent_id: "a", pid: 9, status: "running", kind: "probe" };
    assert.deepEqual(evictionTargets([probe, incoming], incoming), []);
  });

  test("a pending sibling is not evicted — only a started script can be replaced", () => {
    // The rule keys on status "running": a queued-but-unstarted script
    // has no pid to kill, and killing it would drop work the
    // orchestrator never saw start. Note that `kill` treats "pending"
    // the opposite way, deliberately — see the killTargets suite below.
    const incoming: QueueTask = {
      subagent_id: "a",
      status: "pending",
      kind: "committed",
      replace: true,
    };
    const sibling: QueueTask = { subagent_id: "a", status: "pending", kind: "committed" };
    assert.deepEqual(evictionTargets([sibling, incoming], incoming), []);
  });
});

describe("dispatcher kill targets", () => {
  test("stops the subagent's running committed script", () => {
    const queue = [running("a", 1), running("b", 2)];
    assert.deepEqual(
      killTargets(queue, "a").map((t) => t.pid),
      [1],
    );
  });

  test("stops a committed script that has not started yet", () => {
    // Unlike replacement, kill DOES claim pending entries. A commit is
    // ~500 ms from ns.run; ignoring it leaves a script that outlives its
    // owner with no track and nothing left to stop it — the orphan the
    // verb exists to prevent.
    const unborn: QueueTask = { subagent_id: "a", status: "pending", kind: "committed" };
    assert.deepEqual(killTargets([unborn], "a"), [unborn]);
  });

  test("leaves probes alone", () => {
    // A probe belongs to the subagent's own write-run-observe loop and
    // is bounded at 120 s regardless.
    const probe: QueueTask = { subagent_id: "a", pid: 9, status: "running", kind: "probe" };
    assert.deepEqual(killTargets([probe], "a"), []);
  });

  test("leaves other subagents alone", () => {
    assert.deepEqual(killTargets([running("b", 2)], "a"), []);
  });

  test("does not match on a different id that merely looks similar", () => {
    // subagent ids are model-prefixed uuids and are compared exactly;
    // a prefix or case variant is a different subagent.
    const queue = [running("worker-1", 1), running("worker-10", 2), running("WORKER-1", 3)];
    assert.deepEqual(
      killTargets(queue, "worker-1").map((t) => t.pid),
      [1],
    );
  });
});
