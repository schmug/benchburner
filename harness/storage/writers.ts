/**
 * Prepared-statement writers for the storage module.
 *
 * One function per INSERT/UPDATE path the harness needs. All object
 * columns are JSON-encoded here so callers hand in plain JS values.
 * Prepared statements are cached per-Db instance via a WeakMap so we
 * don't re-prepare on every call inside the hot orchestrator loop.
 */

import type { Db } from "./db";
import type {
  CycleStatus,
  ExecutionResult,
  OrchestratorAction,
  Result,
  RunStatus,
} from "../types";

// ────────────────────────────────────────────────────────────────────
// Prepared-statement cache
// ────────────────────────────────────────────────────────────────────

type Stmts = {
  insertRun: import("better-sqlite3").Statement;
  updateRun: import("better-sqlite3").Statement;
  insertDelegation: import("better-sqlite3").Statement;
  updateDelegationResult: import("better-sqlite3").Statement;
  insertScript: import("better-sqlite3").Statement;
  updateScriptExecution: import("better-sqlite3").Statement;
  insertSnapshot: import("better-sqlite3").Statement;
  insertCycle: import("better-sqlite3").Statement;
};

const stmtCache = new WeakMap<Db, Stmts>();

function stmts(db: Db): Stmts {
  const cached = stmtCache.get(db);
  if (cached) return cached;
  const prepared: Stmts = {
    insertRun: db.raw.prepare(`
      INSERT INTO runs (
        run_id, orchestrator_model, orchestrator_config, subagent_roster,
        seed, bitburner_commit, start_time, status, attribution_mode
      ) VALUES (
        @run_id, @orchestrator_model, @orchestrator_config, @subagent_roster,
        @seed, @bitburner_commit, @start_time, 'in_progress', @attribution_mode
      )
    `),
    // Patch-style update: COALESCE lets callers send only the fields
    // they care about by passing null for the rest.
    updateRun: db.raw.prepare(`
      UPDATE runs SET
        status              = COALESCE(@status, status),
        end_time            = COALESCE(@end_time, end_time),
        final_money         = COALESCE(@final_money, final_money),
        final_stats         = COALESCE(@final_stats, final_stats),
        failure_reason      = COALESCE(@failure_reason, failure_reason),
        orchestrator_tokens = COALESCE(@orchestrator_tokens, orchestrator_tokens),
        subagent_tokens     = COALESCE(@subagent_tokens, subagent_tokens)
      WHERE run_id = @run_id
    `),
    insertDelegation: db.raw.prepare(`
      INSERT INTO delegations (
        delegation_id, run_id, cycle_number, action, subagent_id,
        instruction_id, result, timestamp
      ) VALUES (
        @delegation_id, @run_id, @cycle_number, @action, @subagent_id,
        @instruction_id, @result, @timestamp
      )
    `),
    updateDelegationResult: db.raw.prepare(`
      UPDATE delegations SET result = @result WHERE delegation_id = @delegation_id
    `),
    insertScript: db.raw.prepare(`
      INSERT INTO scripts (
        script_id, run_id, subagent_id, instruction_id, code,
        executed_in_game, execution_result, tokens_used, timestamp
      ) VALUES (
        @script_id, @run_id, @subagent_id, @instruction_id, @code,
        0, NULL, @tokens_used, @timestamp
      )
    `),
    updateScriptExecution: db.raw.prepare(`
      UPDATE scripts SET
        executed_in_game = 1,
        execution_result = @execution_result
      WHERE script_id = @script_id
    `),
    insertSnapshot: db.raw.prepare(`
      INSERT INTO snapshots (
        snapshot_id, run_id, hour, game_state, timestamp
      ) VALUES (
        @snapshot_id, @run_id, @hour, @game_state, @timestamp
      )
    `),
    // REPLACE rather than INSERT: a cycle is identified by (run, tick),
    // so a retry must overwrite that tick rather than double-count it.
    insertCycle: db.raw.prepare(`
      INSERT OR REPLACE INTO cycles (
        run_id, cycle_number, status, reasoning, actions,
        tokens_used, latency_ms, error, timestamp
      ) VALUES (
        @run_id, @cycle_number, @status, @reasoning, @actions,
        @tokens_used, @latency_ms, @error, @timestamp
      )
    `),
  };
  stmtCache.set(db, prepared);
  return prepared;
}

// ────────────────────────────────────────────────────────────────────
// runs
// ────────────────────────────────────────────────────────────────────

export function insertRun(
  db: Db,
  row: {
    run_id: string;
    orchestrator_model: string;
    orchestrator_config: object;
    subagent_roster: string[];
    seed: number;
    bitburner_commit: string;
    start_time: string;
    attribution_mode: "public" | "anonymous";
  },
): void {
  stmts(db).insertRun.run({
    run_id: row.run_id,
    orchestrator_model: row.orchestrator_model,
    orchestrator_config: JSON.stringify(row.orchestrator_config),
    subagent_roster: JSON.stringify(row.subagent_roster),
    seed: row.seed,
    bitburner_commit: row.bitburner_commit,
    start_time: row.start_time,
    attribution_mode: row.attribution_mode,
  });
}

export function updateRunStatus(
  db: Db,
  run_id: string,
  patch: {
    status?: RunStatus;
    end_time?: string;
    final_money?: number;
    final_stats?: object;
    failure_reason?: string;
    orchestrator_tokens?: number;
    subagent_tokens?: number;
  },
): void {
  stmts(db).updateRun.run({
    run_id,
    status: patch.status ?? null,
    end_time: patch.end_time ?? null,
    final_money: patch.final_money ?? null,
    final_stats: patch.final_stats !== undefined ? JSON.stringify(patch.final_stats) : null,
    failure_reason: patch.failure_reason ?? null,
    orchestrator_tokens: patch.orchestrator_tokens ?? null,
    subagent_tokens: patch.subagent_tokens ?? null,
  });
}

// ────────────────────────────────────────────────────────────────────
// delegations
// ────────────────────────────────────────────────────────────────────

export function insertDelegation(
  db: Db,
  row: {
    delegation_id: string;
    run_id: string;
    cycle_number: number;
    action: OrchestratorAction;
    subagent_id: string;
    instruction_id: string;
    result: Result | null;
    timestamp: string;
  },
): void {
  stmts(db).insertDelegation.run({
    delegation_id: row.delegation_id,
    run_id: row.run_id,
    cycle_number: row.cycle_number,
    action: JSON.stringify(row.action),
    subagent_id: row.subagent_id,
    instruction_id: row.instruction_id,
    result: row.result === null ? null : JSON.stringify(row.result),
    timestamp: row.timestamp,
  });
}

export function updateDelegationResult(
  db: Db,
  delegation_id: string,
  result: Result,
): void {
  stmts(db).updateDelegationResult.run({
    delegation_id,
    result: JSON.stringify(result),
  });
}

// ────────────────────────────────────────────────────────────────────
// scripts
// ────────────────────────────────────────────────────────────────────

export function insertScript(
  db: Db,
  row: {
    script_id: string;
    run_id: string;
    subagent_id: string;
    instruction_id: string;
    code: string;
    tokens_used: number;
    timestamp: string;
  },
): void {
  stmts(db).insertScript.run({
    script_id: row.script_id,
    run_id: row.run_id,
    subagent_id: row.subagent_id,
    instruction_id: row.instruction_id,
    code: row.code,
    tokens_used: row.tokens_used,
    timestamp: row.timestamp,
  });
}

export function updateScriptExecution(
  db: Db,
  script_id: string,
  execution_result: ExecutionResult,
): void {
  stmts(db).updateScriptExecution.run({
    script_id,
    execution_result: JSON.stringify(execution_result),
  });
}

// ────────────────────────────────────────────────────────────────────
// snapshots
// ────────────────────────────────────────────────────────────────────

/**
 * Records one orchestrator tick — including ticks that produced no
 * delegation. The `reasoning` field is the orchestrator's own account of
 * why it did what it did; SPEC §3.2 logs it but does not score it.
 */
export function insertCycle(
  db: Db,
  row: {
    run_id: string;
    cycle_number: number;
    status: CycleStatus;
    reasoning: string | null;
    actions: OrchestratorAction[];
    tokens_used: number;
    latency_ms: number;
    error?: string | null;
    timestamp: string;
  },
): void {
  stmts(db).insertCycle.run({
    run_id: row.run_id,
    cycle_number: row.cycle_number,
    status: row.status,
    reasoning: row.reasoning,
    actions: JSON.stringify(row.actions),
    tokens_used: row.tokens_used,
    latency_ms: row.latency_ms,
    error: row.error ?? null,
    timestamp: row.timestamp,
  });
}

export function insertSnapshot(
  db: Db,
  row: {
    snapshot_id: string;
    run_id: string;
    hour: number;
    game_state: object;
    timestamp: string;
  },
): void {
  stmts(db).insertSnapshot.run({
    snapshot_id: row.snapshot_id,
    run_id: row.run_id,
    hour: row.hour,
    game_state: JSON.stringify(row.game_state),
    timestamp: row.timestamp,
  });
}
