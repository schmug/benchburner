/**
 * The orchestrator's own reasoning — the "why" behind every spawn, kill
 * and instruct — was parsed out of the model response and then dropped
 * on the floor: `runCycle` used `parsed.actions` and never touched
 * `parsed.reasoning`. It reached no table, no artifact, and no reader.
 *
 * A column on `delegations` would not have fixed it. Reasoning is
 * per-cycle, and the cycles that most need explaining are exactly the
 * ones that write no delegation row at all:
 *
 *   - a cycle that decides to do nothing (`noop`)
 *   - a cycle that only spawns or kills
 *   - a cycle whose model emitted unparseable JSON
 *   - a cycle that threw
 *
 * Hence a `cycles` table, one row per orchestrator tick, which also
 * gives readers a true cycle count instead of "highest cycle number
 * that happened to produce a delegation".
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import { openDb } from "../../harness/storage/db";
import { insertRun, insertCycle } from "../../harness/storage/writers";
import type { CycleRow } from "../../harness/types";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "benchburner-cycles-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const RUN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
let seq = 0;

function freshDb() {
  const file = path.join(tmpRoot, `state-${seq++}.db`);
  const db = openDb(file);
  insertRun(db, {
    run_id: RUN_ID,
    orchestrator_model: "claude-opus-5",
    orchestrator_config: {},
    subagent_roster: ["qwen2.5-coder:7b"],
    seed: 8675309,
    bitburner_commit: "a4b0f22a",
    start_time: "2026-08-07T12:00:00.000Z",
    attribution_mode: "public",
  });
  return { db, file };
}

function rows(db: ReturnType<typeof openDb>): CycleRow[] {
  return db.raw
    .prepare(`SELECT * FROM cycles ORDER BY cycle_number ASC`)
    .all() as CycleRow[];
}

describe("storage/cycles", () => {
  test("persists the orchestrator's reasoning verbatim", () => {
    const { db } = freshDb();
    const why =
      "worker1 has produced nothing in three cycles; killing it and " +
      'reallocating to a second hacking target instead.';
    insertCycle(db, {
      run_id: RUN_ID,
      cycle_number: 4,
      status: "ok",
      reasoning: why,
      actions: [{ action_type: "kill", subagent_id: "worker1" }],
      tokens_used: 1200,
      latency_ms: 8400,
      timestamp: "2026-08-07T12:04:00.000Z",
    });

    const [row] = rows(db);
    assert.equal(row.reasoning, why);
    assert.equal(row.cycle_number, 4);
    assert.equal(row.status, "ok");
    assert.equal(row.tokens_used, 1200);
    assert.equal(row.latency_ms, 8400);
    assert.deepEqual(JSON.parse(row.actions), [
      { action_type: "kill", subagent_id: "worker1" },
    ]);
    db.close();
  });

  test("records a noop cycle, which produces no delegation row", () => {
    const { db } = freshDb();
    insertCycle(db, {
      run_id: RUN_ID,
      cycle_number: 1,
      status: "ok",
      reasoning: "Waiting for worker1's first result before committing further.",
      actions: [{ action_type: "noop" }],
      tokens_used: 300,
      latency_ms: 2100,
      timestamp: "2026-08-07T12:01:00.000Z",
    });

    const [row] = rows(db);
    assert.equal(row.status, "ok");
    assert.match(row.reasoning ?? "", /Waiting for worker1/);
    assert.equal(
      (db.raw.prepare(`SELECT COUNT(*) c FROM delegations`).get() as { c: number }).c,
      0,
      "precondition: a noop cycle writes no delegation",
    );
    db.close();
  });

  test("records a cycle whose model returned unparseable JSON", () => {
    const { db } = freshDb();
    insertCycle(db, {
      run_id: RUN_ID,
      cycle_number: 2,
      status: "malformed",
      reasoning: null,
      actions: [],
      tokens_used: 4096,
      latency_ms: 30000,
      error: "malformed JSON from model; treated as noop",
      timestamp: "2026-08-07T12:02:00.000Z",
    });

    const [row] = rows(db);
    assert.equal(row.status, "malformed");
    assert.equal(row.reasoning, null);
    assert.match(row.error ?? "", /malformed JSON/);
    db.close();
  });

  test("records a cycle that threw, so a stalled run is not silent", () => {
    const { db } = freshDb();
    insertCycle(db, {
      run_id: RUN_ID,
      cycle_number: 3,
      status: "failed",
      reasoning: null,
      actions: [],
      tokens_used: 0,
      latency_ms: 120000,
      error: "Ollama request failed: This operation was aborted",
      timestamp: "2026-08-07T12:03:00.000Z",
    });

    const [row] = rows(db);
    assert.equal(row.status, "failed");
    assert.match(row.error ?? "", /aborted/);
    db.close();
  });

  test("is keyed per run and cycle, so a re-insert cannot duplicate a tick", () => {
    const { db } = freshDb();
    const base = {
      run_id: RUN_ID,
      cycle_number: 1,
      status: "ok" as const,
      reasoning: "first",
      actions: [{ action_type: "noop" as const }],
      tokens_used: 1,
      latency_ms: 1,
      timestamp: "2026-08-07T12:01:00.000Z",
    };
    insertCycle(db, base);
    insertCycle(db, { ...base, reasoning: "second" });

    const all = rows(db);
    assert.equal(all.length, 1, "same cycle inserted twice must not duplicate");
    assert.equal(all[0].reasoning, "second", "latest write wins");
    db.close();
  });
});
