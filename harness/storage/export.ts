/**
 * JSON export pass. Dumps the per-run SQLite state into the four
 * human-readable artifacts under `results/<run_id>/`:
 *
 *   - summary.json     SPEC §8 leaderboard-entry shape
 *   - delegations.json full delegation log, oldest first
 *   - scripts.json     all generated scripts + execution metadata
 *   - snapshots.json   hourly game-state snapshots
 *
 * These are what the aggregator + Pages site consume; the .db stays
 * around too, but JSON is the Git-friendly source of truth.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Db } from "./db";
import type {
  DelegationRow,
  RunRow,
  RunSummary,
  ScriptRow,
  SnapshotRow,
} from "../types";

// Small helper: JSON.parse a column that may be null/undefined.
function parseNullable<T>(raw: string | null | undefined): T | null {
  if (raw === null || raw === undefined) return null;
  return JSON.parse(raw) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/**
 * Takes the run's *effective* duration in seconds, not the configured
 * one. Callers previously passed config.duration_hours, which ignored
 * the BENCHBURNER_DURATION_SEC override and so recorded every
 * 20-minute PCS1/PDS6 run as a 1-hour run in its own summary.json.
 */
export function exportRunArtifacts(
  db: Db,
  run_id: string,
  outDir: string,
  duration_seconds: number,
): RunSummary {
  mkdirSync(outDir, { recursive: true });

  // ── runs row → summary.json ─────────────────────────────────────
  const runRow = db.raw
    .prepare<[string], RunRow>(`SELECT * FROM runs WHERE run_id = ?`)
    .get(run_id);
  if (!runRow) {
    throw new Error(`exportRunArtifacts: run_id ${run_id} not found in runs`);
  }

  const finalStats =
    parseNullable<Record<string, unknown>>(runRow.final_stats) ?? {};
  const bitnodes_completed =
    typeof finalStats.bitnodes_completed === "number"
      ? (finalStats.bitnodes_completed as number)
      : 0;
  const augments_installed =
    typeof finalStats.augments_installed === "number"
      ? (finalStats.augments_installed as number)
      : Array.isArray(finalStats.augments_installed)
        ? (finalStats.augments_installed as unknown[]).length
        : 0;

  const summary: RunSummary = {
    run_id: runRow.run_id,
    orchestrator_model: runRow.orchestrator_model,
    attribution: runRow.attribution_mode,
    final_money: runRow.final_money ?? 0,
    bitnodes_completed,
    augments_installed,
    status: runRow.status,
    failure_reason: runRow.failure_reason,
    bitburner_commit: runRow.bitburner_commit,
    start_time: runRow.start_time,
    end_time: runRow.end_time,
    duration_hours: duration_seconds / 3600,
    duration_seconds,
  };
  writeJson(join(outDir, "summary.json"), summary);

  // ── delegations.json ────────────────────────────────────────────
  const delegationRows = db.raw
    .prepare<[string], DelegationRow>(
      `SELECT * FROM delegations WHERE run_id = ?
       ORDER BY cycle_number ASC, timestamp ASC`,
    )
    .all(run_id);
  const delegations = delegationRows.map((r) => ({
    delegation_id: r.delegation_id,
    cycle_number: r.cycle_number,
    subagent_id: r.subagent_id,
    instruction_id: r.instruction_id,
    action: parseNullable<unknown>(r.action),
    result: parseNullable<unknown>(r.result),
    timestamp: r.timestamp,
  }));
  writeJson(join(outDir, "delegations.json"), delegations);

  // ── scripts.json ────────────────────────────────────────────────
  const scriptRows = db.raw
    .prepare<[string], ScriptRow>(
      `SELECT * FROM scripts WHERE run_id = ? ORDER BY timestamp ASC`,
    )
    .all(run_id);
  const scripts = scriptRows.map((r) => ({
    script_id: r.script_id,
    subagent_id: r.subagent_id,
    instruction_id: r.instruction_id,
    code: r.code,
    executed_in_game: r.executed_in_game === 1,
    execution_result: parseNullable<unknown>(r.execution_result),
    tokens_used: r.tokens_used,
    timestamp: r.timestamp,
  }));
  writeJson(join(outDir, "scripts.json"), scripts);

  // ── snapshots.json ──────────────────────────────────────────────
  const snapshotRows = db.raw
    .prepare<[string], SnapshotRow>(
      `SELECT * FROM snapshots WHERE run_id = ? ORDER BY hour ASC`,
    )
    .all(run_id);
  const snapshots = snapshotRows.map((r) => ({
    snapshot_id: r.snapshot_id,
    hour: r.hour,
    game_state: parseNullable<unknown>(r.game_state),
    timestamp: r.timestamp,
  }));
  writeJson(join(outDir, "snapshots.json"), snapshots);

  return summary;
}
