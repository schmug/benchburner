/**
 * Run duration is the benchmark's most load-bearing config value and
 * was, until this suite existed, only expressible in whole hours —
 * which is why every canonical 20-minute run in VALIDATION.md was
 * actually produced by the dev-only BENCHBURNER_DURATION_SEC override
 * while its config file claimed `duration_hours: 1`.
 *
 * These tests pin the contract: exactly one of duration_hours or
 * duration_minutes, resolved to a canonical duration_seconds.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import { loadRunConfig } from "../../harness/config/loader";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "benchburner-duration-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;

/** Writes a run config with the given duration keys spliced in. */
function configWith(durationYaml: string): string {
  const file = path.join(tmpRoot, `run-${seq++}.yaml`);
  writeFileSync(
    file,
    [
      "run_id: auto",
      "orchestrator:",
      "  model: claude-opus-5",
      "  polling_interval_seconds: 60",
      "  history_window: 10",
      "  hang_timeout_seconds: 120",
      "subagent_roster: [claude-haiku-4.5]",
      "game: { bitburner_commit: a4b0f22, seed: 8675309 }",
      durationYaml,
      "attribution_mode: public",
      "",
    ].join("\n"),
  );
  return file;
}

describe("run duration parsing", () => {
  test("duration_minutes: 20 resolves to 1200 seconds", () => {
    const cfg = loadRunConfig(configWith("duration_minutes: 20"));
    assert.equal(cfg.duration_seconds, 1200);
  });

  test("duration_hours: 24 resolves to 86400 seconds", () => {
    const cfg = loadRunConfig(configWith("duration_hours: 24"));
    assert.equal(cfg.duration_seconds, 86400);
  });

  test("fractional duration_hours is preserved exactly", () => {
    const cfg = loadRunConfig(configWith("duration_hours: 0.5"));
    assert.equal(cfg.duration_seconds, 1800);
  });

  test("rejects a config specifying both duration keys", () => {
    assert.throws(
      () => loadRunConfig(configWith("duration_hours: 1\nduration_minutes: 20")),
      /exactly one of/i,
      "specifying both is the exact ambiguity that produced configs claiming 1h for 20m runs",
    );
  });

  test("rejects a config specifying neither duration key", () => {
    assert.throws(() => loadRunConfig(configWith("# no duration")), /exactly one of/i);
  });

  test("rejects a non-positive duration", () => {
    assert.throws(() => loadRunConfig(configWith("duration_minutes: 0")), /must be > 0/);
    assert.throws(() => loadRunConfig(configWith("duration_hours: -1")), /must be > 0/);
  });

  test("rejects a non-numeric duration", () => {
    assert.throws(() => loadRunConfig(configWith("duration_minutes: twenty")));
  });
});

describe("snapshot_interval_seconds", () => {
  test("is undefined when omitted, so the timer applies its default", () => {
    const cfg = loadRunConfig(configWith("duration_minutes: 20"));
    assert.equal(cfg.snapshot_interval_seconds, undefined);
  });

  test("is carried through when set", () => {
    const cfg = loadRunConfig(
      configWith("duration_minutes: 20\nsnapshot_interval_seconds: 120"),
    );
    assert.equal(cfg.snapshot_interval_seconds, 120);
  });

  test("rejects a non-positive interval", () => {
    assert.throws(
      () => loadRunConfig(configWith("duration_minutes: 20\nsnapshot_interval_seconds: 0")),
      /must be > 0/,
    );
  });

  test("rejects an interval longer than the run itself", () => {
    // Would yield exactly one snapshot — the hour-0-only degradation
    // that motivated making the cadence proportional in the first place.
    assert.throws(
      () => loadRunConfig(configWith("duration_minutes: 20\nsnapshot_interval_seconds: 5000")),
      /exceed the run duration/i,
    );
  });
});
