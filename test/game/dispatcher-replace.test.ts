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

import { evictionTargets, type QueueTask } from "../../harness/game/eviction";

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
    // orchestrator never saw start.
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
