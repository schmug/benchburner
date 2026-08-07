/**
 * Integration check on the actual OrchestratorLoop: a cycle that decides
 * to do nothing must still leave a record.
 *
 * This is the case a `reasoning` column on `delegations` could never
 * have covered. The null-orchestrator adapter emits SPEC §3.2's
 * single-action noop on every call, so this run produces zero
 * delegations, zero scripts, and — before the `cycles` table — zero
 * evidence that the orchestrator had run at all.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import { Bus } from "../../harness/bus/bus";
import { MockGame } from "../../harness/game/mock";
import { InferenceRegistry } from "../../harness/inference/registry";
import { OrchestratorLoop } from "../../harness/orchestrator/loop";
import { openDb } from "../../harness/storage/db";
import { insertRun } from "../../harness/storage/writers";
import { SubagentPool } from "../../harness/subagent/pool";
import type { CycleRow, RunConfig } from "../../harness/types";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "benchburner-cycle-loop-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const RUN_ID = "cccccccc-dddd-eeee-ffff-000000000000";

function config(): RunConfig {
  return {
    run_id: RUN_ID,
    orchestrator: {
      model: "null-orchestrator",
      polling_interval_seconds: 3600, // only the immediate first cycle runs
      history_window: 10,
      hang_timeout_seconds: 600,
    },
    subagent_roster: ["qwen2.5-coder:7b"],
    subagent_limits: {
      max_concurrent: 2,
      token_budget_per_instruction: 2000,
      timeout_seconds: 300,
    },
    game: { bitburner_commit: "a4b0f22a", seed: 8675309 },
    duration_seconds: 600,
    attribution_mode: "public",
  };
}

async function runOneCycle(): Promise<{ cycles: CycleRow[]; delegations: number }> {
  const dir = mkdtempSync(path.join(tmpRoot, "run-"));
  const db = openDb(path.join(dir, "state.db"));
  const cfg = config();

  insertRun(db, {
    run_id: RUN_ID,
    orchestrator_model: cfg.orchestrator.model,
    orchestrator_config: {},
    subagent_roster: cfg.subagent_roster,
    seed: cfg.game.seed,
    bitburner_commit: cfg.game.bitburner_commit,
    start_time: new Date().toISOString(),
    attribution_mode: "public",
  });

  const game = new MockGame({ seed: cfg.game.seed });
  await game.start();

  const loop = new OrchestratorLoop({
    run_id: RUN_ID,
    config: cfg,
    bus: new Bus(),
    db,
    game,
    pool: new SubagentPool(),
    registry: new InferenceRegistry([
      {
        id: "null-orchestrator",
        adapter: "null-orchestrator",
        endpoint: "none",
        context_window: 8192,
      },
    ]),
    totalDurationSeconds: cfg.duration_seconds,
    logDir: dir,
    onFatal: (reason) => {
      throw new Error(`unexpected fatal: ${reason}`);
    },
  });

  loop.start(await game.readState());
  // start() fires the first cycle immediately; give it room to settle.
  for (let i = 0; i < 100; i++) {
    const done = (db.raw.prepare(`SELECT COUNT(*) c FROM cycles`).get() as { c: number }).c;
    if (done > 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await loop.stop();
  await game.stop();

  const cycles = db.raw
    .prepare(`SELECT * FROM cycles ORDER BY cycle_number ASC`)
    .all() as CycleRow[];
  const delegations = (
    db.raw.prepare(`SELECT COUNT(*) c FROM delegations`).get() as { c: number }
  ).c;
  db.close();
  return { cycles, delegations };
}

describe("OrchestratorLoop — cycle recording", () => {
  test("records a cycle that produced no delegation at all", async () => {
    const { cycles, delegations } = await runOneCycle();

    assert.equal(delegations, 0, "precondition: the null orchestrator delegates nothing");
    assert.equal(cycles.length, 1, "the cycle must still be recorded");

    const [c] = cycles;
    assert.equal(c.cycle_number, 1);
    assert.equal(c.status, "ok");
    assert.equal(c.run_id, RUN_ID);
    assert.deepEqual(JSON.parse(c.actions), [{ action_type: "noop" }]);
    assert.equal(
      typeof c.reasoning,
      "string",
      "reasoning must round-trip even when the model returns an empty one",
    );
    assert.ok(c.latency_ms >= 0);
    assert.ok(Date.parse(c.timestamp) > 0, "timestamp must be ISO-8601");
  });
});
