/**
 * The live viewer reads a run's `state.db` while the harness is still
 * writing to it. That makes two properties load-bearing, and both are
 * easy to break silently:
 *
 *   1. The reader must NEVER write. `harness/storage/db.ts` applies the
 *      schema and runs ALTER TABLE on open — reusing it here would make
 *      a read-only observer mutate a scored run's artifact.
 *   2. Mid-run rows are half-populated by design: a delegation exists
 *      with `result = NULL` from dispatch until the subagent returns,
 *      and a script exists with `execution_result = NULL` until it runs.
 *      Dropping those rows would make the viewer show nothing during
 *      exactly the window it exists to show.
 *
 * Fixtures are built with the real `harness/storage/writers` so the
 * shapes stay honest to what the harness actually persists.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import { openDb } from "../../harness/storage/db";
import {
  insertRun,
  insertCycle,
  insertDelegation,
  updateDelegationResult,
  insertScript,
  updateScriptExecution,
  insertSnapshot,
} from "../../harness/storage/writers";
import { readLiveView } from "../../viewer/reader";
import type { ExecutionResult, Result } from "../../harness/types";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "benchburner-viewer-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const RUN_ID = "11111111-2222-3333-4444-555555555555";
const T0 = "2026-08-07T12:00:00.000Z";

let seq = 0;

/**
 * Builds a state.db that looks like a run caught mid-flight:
 * one delegation that succeeded and earned money, one that errored,
 * one still pending, plus two snapshots.
 */
function fixtureDb(): string {
  const dir = mkdtempSync(path.join(tmpRoot, `run-${seq++}-`));
  const file = path.join(dir, "state.db");
  const db = openDb(file);

  insertRun(db, {
    run_id: RUN_ID,
    orchestrator_model: "claude-opus-5",
    orchestrator_config: { polling_interval_seconds: 60 },
    subagent_roster: ["qwen2.5-coder-7b", "gpt-oss:20b"],
    seed: 8675309,
    bitburner_commit: "a4b0f22a",
    start_time: T0,
    attribution_mode: "public",
  });

  // ── cycle 1: succeeded, earned money ─────────────────────────
  insertDelegation(db, {
    delegation_id: "d-ok",
    run_id: RUN_ID,
    cycle_number: 1,
    action: {
      action_type: "instruct",
      subagent_id: "sub-a",
      instruction: {
        instruction_id: "i-ok",
        subagent_id: "sub-a",
        task: "Write a script that maximizes early-game income.",
        context: "No prior results yet.",
        constraints: { token_budget: 2000, max_script_size_lines: 200 },
        timestamp: T0,
      },
    },
    subagent_id: "sub-a",
    instruction_id: "i-ok",
    result: null,
    timestamp: T0,
  });
  const okResult: Result = {
    instruction_id: "i-ok",
    subagent_id: "sub-a",
    status: "success",
    code: "export async function main(ns) {}",
    reasoning: "Chose the lowest-security target.",
    tokens_used: 1500,
    iterations: 2,
    iteration_summaries: [
      { iteration: 1, exit_reason: "errored", money_gained: 0, stderr: "boom" },
      { iteration: 2, exit_reason: "exited", money_gained: 45000 },
    ],
    timestamp: T0,
  };
  updateDelegationResult(db, "d-ok", okResult);

  insertScript(db, {
    script_id: "s-ok",
    run_id: RUN_ID,
    subagent_id: "sub-a",
    instruction_id: "i-ok",
    code: "export async function main(ns) {}",
    tokens_used: 1500,
    timestamp: T0,
  });
  const okExec: ExecutionResult = {
    script_id: "s-ok",
    subagent_id: "sub-a",
    status: "executed",
    money_gained: 45000,
    time_elapsed_seconds: 12,
    stdout: "hacked n00dles",
    exit_reason: "exited",
    script_stats: { ram_usage: 4.2, threads: 1 },
    game_state_snapshot: { current_money: 46262, bitnode_id: 1, bitnode_complete: false },
    timestamp: T0,
  };
  updateScriptExecution(db, "s-ok", okExec);

  // ── cycle 2: subagent errored ────────────────────────────────
  insertDelegation(db, {
    delegation_id: "d-err",
    run_id: RUN_ID,
    cycle_number: 2,
    action: {
      action_type: "instruct",
      subagent_id: "sub-b",
      instruction: {
        instruction_id: "i-err",
        subagent_id: "sub-b",
        task: "Diversify into a second income stream.",
        context: "sub-a is already hacking.",
        constraints: { token_budget: 2000, max_script_size_lines: 200 },
        timestamp: T0,
      },
    },
    subagent_id: "sub-b",
    instruction_id: "i-err",
    result: null,
    timestamp: T0,
  });
  updateDelegationResult(db, "d-err", {
    instruction_id: "i-err",
    subagent_id: "sub-b",
    status: "error",
    tokens_used: 300,
    error_message: "model returned unparseable JSON",
    timestamp: T0,
  });

  // ── cycle 3: still pending (result IS NULL) ──────────────────
  insertDelegation(db, {
    delegation_id: "d-pending",
    run_id: RUN_ID,
    cycle_number: 3,
    action: {
      action_type: "instruct",
      subagent_id: "sub-a",
      instruction: {
        instruction_id: "i-pending",
        subagent_id: "sub-a",
        task: "Scale up the working strategy.",
        context: "45k earned so far.",
        constraints: { token_budget: 2000, max_script_size_lines: 200 },
        timestamp: T0,
      },
    },
    subagent_id: "sub-a",
    instruction_id: "i-pending",
    result: null,
    timestamp: T0,
  });

  // ── orchestrator ticks, including one that delegated nothing ──
  insertCycle(db, {
    run_id: RUN_ID,
    cycle_number: 1,
    status: "ok",
    reasoning: "Spawning a first worker to probe the lowest-security target.",
    actions: [{ action_type: "spawn", subagent_id: "sub-a" }],
    tokens_used: 400,
    latency_ms: 3100,
    timestamp: T0,
  });
  insertCycle(db, {
    run_id: RUN_ID,
    cycle_number: 2,
    status: "failed",
    reasoning: null,
    actions: [],
    tokens_used: 0,
    latency_ms: 120000,
    error: "Ollama request failed: This operation was aborted",
    timestamp: T0,
  });
  insertCycle(db, {
    run_id: RUN_ID,
    cycle_number: 3,
    status: "ok",
    reasoning: "sub-a earned 45k; instructing it to scale the same approach.",
    actions: [{ action_type: "instruct", subagent_id: "sub-a" }],
    tokens_used: 900,
    latency_ms: 5200,
    timestamp: T0,
  });
  insertCycle(db, {
    run_id: RUN_ID,
    cycle_number: 4,
    status: "ok",
    reasoning: "Holding steady while sub-a's committed script accrues income.",
    actions: [{ action_type: "noop" }],
    tokens_used: 350,
    latency_ms: 2800,
    timestamp: T0,
  });

  insertSnapshot(db, {
    snapshot_id: "snap-0",
    run_id: RUN_ID,
    hour: 0,
    game_state: { current_money: 1262, bitnode_id: 1, bitnode_complete: false },
    timestamp: T0,
  });
  insertSnapshot(db, {
    snapshot_id: "snap-1",
    run_id: RUN_ID,
    hour: 1,
    game_state: { current_money: 46262, bitnode_id: 1, bitnode_complete: false },
    timestamp: "2026-08-07T12:00:50.000Z",
  });

  db.close();
  return file;
}

describe("viewer/reader — run identity", () => {
  test("reports the run's identity and in-progress status", () => {
    const v = readLiveView(fixtureDb());
    assert.equal(v.run.run_id, RUN_ID);
    assert.equal(v.run.orchestrator_model, "claude-opus-5");
    assert.equal(v.run.status, "in_progress");
    assert.deepEqual(v.run.subagent_roster, ["qwen2.5-coder-7b", "gpt-oss:20b"]);
  });

  test("never exposes the seed — it is opaque by CLAUDE.md constraint 6", () => {
    const v = readLiveView(fixtureDb());
    assert.equal(
      JSON.stringify(v).includes("8675309"),
      false,
      "seed leaked into the live view",
    );
  });
});

describe("viewer/reader — game stats", () => {
  test("builds a money series from snapshots, in index order", () => {
    const v = readLiveView(fixtureDb());
    assert.deepEqual(
      v.money.series.map((p) => p.money),
      [1262, 46262],
    );
    assert.equal(v.money.current, 46262, "current money is the latest snapshot");
  });

  test("attributes earned money to the executing subagent", () => {
    const v = readLiveView(fixtureDb());
    const a = v.subagents.find((s) => s.subagent_id === "sub-a");
    assert.equal(a?.money_earned, 45000);
  });
});

describe("viewer/reader — mid-run rows", () => {
  test("keeps pending delegations instead of dropping them", () => {
    const v = readLiveView(fixtureDb());
    const pending = v.delegations.find((d) => d.instruction_id === "i-pending");
    assert.ok(pending, "pending delegation was dropped");
    assert.equal(pending.state, "pending");
    assert.equal(pending.task, "Scale up the working strategy.");
  });

  test("surfaces the orchestrator's instruction text for every delegation", () => {
    const v = readLiveView(fixtureDb());
    assert.deepEqual(
      v.delegations.map((d) => d.task),
      [
        "Scale up the working strategy.",
        "Diversify into a second income stream.",
        "Write a script that maximizes early-game income.",
      ],
      "delegations should be newest-cycle-first with task text intact",
    );
  });
});

describe("viewer/reader — failures", () => {
  test("classifies a failed subagent result and carries its error message", () => {
    const v = readLiveView(fixtureDb());
    const err = v.delegations.find((d) => d.instruction_id === "i-err");
    assert.equal(err?.state, "error");
    assert.equal(err?.error, "model returned unparseable JSON");
  });

  test("counts per-subagent errors", () => {
    const v = readLiveView(fixtureDb());
    assert.equal(v.subagents.find((s) => s.subagent_id === "sub-b")?.errors, 1);
    assert.equal(v.subagents.find((s) => s.subagent_id === "sub-a")?.errors, 0);
  });

  test("exposes failed iterations inside a successful instruction", () => {
    const v = readLiveView(fixtureDb());
    const ok = v.delegations.find((d) => d.instruction_id === "i-ok");
    assert.equal(ok?.iterations, 2);
    assert.equal(ok?.iteration_summaries?.[0]?.exit_reason, "errored");
    assert.equal(ok?.iteration_summaries?.[0]?.stderr, "boom");
  });

  test("carries execution exit_reason and stdout through to the view", () => {
    const v = readLiveView(fixtureDb());
    const exec = v.executions.find((e) => e.script_id === "s-ok");
    assert.equal(exec?.exit_reason, "exited");
    assert.equal(exec?.money_gained, 45000);
    assert.equal(exec?.stdout, "hacked n00dles");
  });
});

describe("viewer/reader — cycles and orchestrator reasoning", () => {
  test("surfaces the orchestrator's reasoning, newest cycle first", () => {
    const v = readLiveView(fixtureDb());
    assert.deepEqual(
      v.cycles.map((c) => c.cycle_number),
      [4, 3, 2, 1],
    );
    assert.equal(
      v.cycles.find((c) => c.cycle_number === 1)?.reasoning,
      "Spawning a first worker to probe the lowest-security target.",
    );
  });

  test("keeps cycles that delegated nothing — the reason a delegations column would not do", () => {
    const v = readLiveView(fixtureDb());
    const noop = v.cycles.find((c) => c.cycle_number === 4);
    assert.ok(noop, "the noop cycle was dropped");
    assert.equal(noop.delegation_count, 0);
    assert.match(noop.reasoning ?? "", /Holding steady/);
    assert.deepEqual(
      noop.actions.map((a) => a.action_type),
      ["noop"],
    );
  });

  test("reports a true cycle count now that every tick is recorded", () => {
    const v = readLiveView(fixtureDb());
    assert.equal(v.totals.cycles, 4, "4 ticks ran, only 3 delegated");
    assert.equal(v.totals.delegations, 3);
    assert.equal(v.totals.latest_delegated_cycle, 3);
  });

  test("carries failed and malformed cycles so a stalled run is visible", () => {
    const v = readLiveView(fixtureDb());
    const bad = v.cycles.find((c) => c.cycle_number === 2);
    assert.equal(bad?.status, "failed");
    assert.match(bad?.error ?? "", /aborted/);
  });

  test("still reads a run database written before the cycles table existed", () => {
    const file = fixtureDb();
    const db = openDb(file);
    db.raw.exec(`DROP TABLE cycles`);
    db.close();

    // The 86 already-published runs have no cycles table. The viewer has
    // to degrade to "no reasoning available", not throw.
    const v = readLiveView(file);
    assert.deepEqual(v.cycles, []);
    assert.equal(v.totals.cycles, 0);
    assert.equal(v.totals.delegations, 3, "the rest of the view still works");
  });
});

describe("viewer/reader — token accounting", () => {
  /**
   * `runs.orchestrator_tokens` / `runs.subagent_tokens` are flushed on a
   * timer by the harness, so mid-run they lag the delegations that have
   * already returned. Reporting the column alone makes a busy run read
   * as "0 tokens used", which is the most expensive number on the page.
   */
  test("reports subagent tokens observed in delegations, not just the lagging column", () => {
    const v = readLiveView(fixtureDb());
    // Fixture: 1500 (success) + 300 (error) returned; run columns never flushed.
    assert.equal(v.tokens.subagent_observed, 1800);
    assert.equal(v.tokens.subagent_recorded, 0, "column is still at its default");
    assert.equal(
      v.tokens.subagent,
      1800,
      "the headline should prefer whichever source is further along",
    );
  });

  test("prefers the recorded column once it overtakes what delegations show", () => {
    const file = fixtureDb();
    const db = openDb(file);
    // Simulate the harness flushing its counters, including tokens spent
    // on cycles that produced no delegation at all.
    db.raw
      .prepare(`UPDATE runs SET orchestrator_tokens = 900, subagent_tokens = 5000`)
      .run();
    db.close();

    const v = readLiveView(file);
    assert.equal(v.tokens.subagent, 5000);
    assert.equal(v.tokens.orchestrator, 900);
    assert.equal(v.tokens.total, 5900);
  });
});

describe("viewer/reader — read-only guarantee", () => {
  test("does not modify the database file", () => {
    const file = fixtureDb();
    const before = {
      hash: createHash("sha256").update(readFileSync(file)).digest("hex"),
      size: statSync(file).size,
    };

    for (let i = 0; i < 3; i++) readLiveView(file);

    const after = {
      hash: createHash("sha256").update(readFileSync(file)).digest("hex"),
      size: statSync(file).size,
    };
    assert.equal(after.hash, before.hash, "reader mutated the db file");
    assert.equal(after.size, before.size);
  });

  test("refuses to create a database that does not exist", () => {
    const missing = path.join(tmpRoot, "nope", "state.db");
    assert.throws(() => readLiveView(missing));
  });
});
