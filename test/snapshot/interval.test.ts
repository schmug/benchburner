/**
 * Snapshot cadence. CLAUDE.md constraint #3 says the orchestrator sees
 * "what subagents report + periodic game state snapshots" — so the
 * snapshot channel existing is part of the benchmark's definition, not
 * a nicety.
 *
 * With a hardcoded 3600s interval, every canonical 20-minute run fired
 * only the hour-0 snapshot, silently removing one of the orchestrator's
 * two information channels. These tests pin the interval to the run
 * duration so short runs keep the channel, while leaving 24h runs
 * bit-identical to the previous behaviour.
 */

import { strict as assert } from "node:assert";
import test, { describe } from "node:test";

import { resolveSnapshotInterval, SNAPSHOTS_PER_RUN } from "../../harness/snapshot/timer";

describe("snapshot interval resolution", () => {
  test("a 24h run keeps the historical 3600s interval", () => {
    assert.equal(resolveSnapshotInterval(86400), 3600);
  });

  test("a 24h run still produces the historical snapshot count", () => {
    assert.equal(86400 / resolveSnapshotInterval(86400), SNAPSHOTS_PER_RUN);
  });

  test("a canonical 20m run gets a proportional interval, not a single snapshot", () => {
    const interval = resolveSnapshotInterval(1200);
    assert.equal(interval, 50);
    assert.equal(1200 / interval, SNAPSHOTS_PER_RUN);
  });

  test("an explicit override wins over the proportional default", () => {
    assert.equal(resolveSnapshotInterval(1200, 300), 300);
  });

  test("very short runs are floored so readState is not hammered", () => {
    // 120s / 24 would be 5s, faster than the game controller should be
    // polled. The floor trades snapshot count for host stability.
    assert.ok(resolveSnapshotInterval(120) >= 30);
  });

  test("the floor never exceeds the run duration itself", () => {
    // A 10s smoke run must not schedule its first interval past the end
    // of the run — that would regress to the hour-0-only behaviour this
    // change exists to fix.
    assert.ok(resolveSnapshotInterval(10) <= 10);
  });
});
