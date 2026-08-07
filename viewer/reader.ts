/**
 * Read-only projection of a run's `state.db` into a view model.
 *
 * The harness writes to this database continuously while a run is in
 * flight (insertDelegation on dispatch, updateDelegationResult on
 * return, insertScript / updateScriptExecution around each game run,
 * insertSnapshot on the snapshot timer), and the file is opened in WAL
 * mode — so a second process can read a run as it happens.
 *
 * Two rules this module exists to enforce:
 *
 *   1. NEVER write. `harness/storage/db.ts` applies the schema and runs
 *      ALTER TABLE on open; using it here would make an observer mutate
 *      a scored run's artifact. We open with `readonly: true` and do not
 *      touch the schema.
 *   2. NEVER expose the seed. CLAUDE.md constraint 6 keeps it opaque,
 *      and a dashboard is a display surface like any other.
 *
 * Mid-run rows are half-populated by design — a delegation carries
 * `result = NULL` between dispatch and return, a script carries
 * `execution_result = NULL` until it runs. Those are the rows the live
 * view most needs to show, so they are surfaced as `pending`, never
 * filtered out.
 */

import Database from "better-sqlite3";

import type {
  ExecutionResult,
  GameState,
  OrchestratorAction,
  Result,
  RunStatus,
} from "../harness/types";

// ────────────────────────────────────────────────────────────────────
// View model
// ────────────────────────────────────────────────────────────────────

/** Lifecycle of one instruction, as far as the artifacts can tell. */
export type DelegationState = "pending" | "success" | "error" | "timeout";

export interface LiveRun {
  run_id: string;
  orchestrator_model: string;
  subagent_roster: string[];
  status: RunStatus;
  start_time: string;
  end_time: string | null;
  elapsed_seconds: number;
  final_money: number | null;
  failure_reason: string | null;
  orchestrator_tokens: number;
  subagent_tokens: number;
  bitburner_commit: string;
  // Deliberately absent: seed.
}

export interface MoneyPoint {
  index: number;
  money: number;
  timestamp: string;
  /** True when the harness could not read game state and synthesised one. */
  read_failed: boolean;
}

export interface LiveMoney {
  current: number;
  starting: number;
  gained: number;
  series: MoneyPoint[];
}

export interface LiveSubagent {
  subagent_id: string;
  delegations: number;
  pending: number;
  errors: number;
  money_earned: number;
  tokens_used: number;
  last_task: string | null;
  last_state: DelegationState | null;
}

export interface LiveDelegation {
  delegation_id: string;
  cycle_number: number;
  subagent_id: string;
  instruction_id: string;
  action_type: string;
  task: string | null;
  context: string | null;
  state: DelegationState;
  /** The subagent's own explanation, when it returned one. */
  reasoning?: string;
  error?: string;
  tokens_used?: number;
  iterations?: number;
  iteration_summaries?: Result["iteration_summaries"];
  timestamp: string;
}

export interface LiveExecution {
  script_id: string;
  subagent_id: string;
  status: ExecutionResult["status"];
  money_gained: number;
  time_elapsed_seconds: number;
  exit_reason?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  script_stats?: Record<string, number | string>;
  timestamp: string;
}

/**
 * The harness flushes `runs.orchestrator_tokens` / `subagent_tokens` on a
 * timer, so mid-run they lag the delegations that have already returned.
 * Both sources are reported; `subagent` / `total` take whichever is
 * further along, because either one alone understates spend at some
 * point in the run.
 */
export interface LiveTokens {
  orchestrator: number;
  subagent: number;
  total: number;
  subagent_recorded: number;
  subagent_observed: number;
}

export interface LiveView {
  generated_at: string;
  run: LiveRun;
  money: LiveMoney;
  tokens: LiveTokens;
  subagents: LiveSubagent[];
  /** Newest cycle first — a dashboard reads top-down. */
  delegations: LiveDelegation[];
  /** Newest first. */
  executions: LiveExecution[];
  totals: {
    /**
     * Newest cycle number that produced an instruction — NOT the
     * orchestrator's cycle count. A cycle that only spawned or killed a
     * subagent writes no delegation row, so the artifacts cannot tell us
     * how many cycles have actually run.
     */
    latest_delegated_cycle: number;
    delegations: number;
    pending: number;
    errors: number;
    scripts_run: number;
  };
}

// ────────────────────────────────────────────────────────────────────
// Row shapes as they come back from SQLite
// ────────────────────────────────────────────────────────────────────

interface RunRowRaw {
  run_id: string;
  orchestrator_model: string;
  subagent_roster: string;
  status: RunStatus;
  start_time: string;
  end_time: string | null;
  final_money: number | null;
  failure_reason: string | null;
  bitburner_commit: string;
  orchestrator_tokens: number | null;
  subagent_tokens: number | null;
}

interface DelegationRowRaw {
  delegation_id: string;
  cycle_number: number;
  action: string;
  subagent_id: string;
  instruction_id: string;
  result: string | null;
  timestamp: string;
}

interface ScriptRowRaw {
  script_id: string;
  subagent_id: string;
  execution_result: string | null;
  timestamp: string;
}

interface SnapshotRowRaw {
  hour: number;
  game_state: string;
  timestamp: string;
}

/**
 * Parses JSON that the harness wrote, tolerating a torn read. A row can
 * in principle be observed between write and commit; returning null
 * degrades one card rather than throwing away the whole view.
 */
function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function stateOf(result: Result | null): DelegationState {
  if (result === null) return "pending";
  if (result.status === "success") return "success";
  if (result.status === "timeout") return "timeout";
  return "error";
}

// ────────────────────────────────────────────────────────────────────
// Reader
// ────────────────────────────────────────────────────────────────────

/**
 * Opens `dbPath` read-only and projects it into a `LiveView`.
 *
 * Throws if the file does not exist — a viewer that silently created an
 * empty database would look like a run with no activity, which is the
 * single most misleading thing this tool could do.
 *
 * Safe to call on a repeating timer against a run in progress.
 */
export function readLiveView(dbPath: string, now: Date = new Date()): LiveView {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const runRow = db
      .prepare(
        `SELECT run_id, orchestrator_model, subagent_roster, status, start_time,
                end_time, final_money, failure_reason, bitburner_commit,
                orchestrator_tokens, subagent_tokens
           FROM runs LIMIT 1`,
      )
      .get() as RunRowRaw | undefined;

    if (!runRow) throw new Error(`no run row in ${dbPath}`);

    const delegationRows = db
      .prepare(
        `SELECT delegation_id, cycle_number, action, subagent_id,
                instruction_id, result, timestamp
           FROM delegations
          ORDER BY cycle_number DESC, timestamp DESC`,
      )
      .all() as DelegationRowRaw[];

    const scriptRows = db
      .prepare(
        `SELECT script_id, subagent_id, execution_result, timestamp
           FROM scripts ORDER BY timestamp DESC`,
      )
      .all() as ScriptRowRaw[];

    const snapshotRows = db
      .prepare(
        `SELECT hour, game_state, timestamp FROM snapshots ORDER BY hour ASC`,
      )
      .all() as SnapshotRowRaw[];

    // ── delegations ────────────────────────────────────────────
    const delegations: LiveDelegation[] = delegationRows.map((row) => {
      const action = parseJson<OrchestratorAction>(row.action);
      const result = parseJson<Result>(row.result);
      const instruction = action?.instruction;
      return {
        delegation_id: row.delegation_id,
        cycle_number: row.cycle_number,
        subagent_id: row.subagent_id,
        instruction_id: row.instruction_id,
        action_type: action?.action_type ?? "instruct",
        task: instruction?.task ?? null,
        context: instruction?.context ?? null,
        state: stateOf(result),
        reasoning: result?.reasoning,
        error: result?.error_message,
        tokens_used: result?.tokens_used,
        iterations: result?.iterations,
        iteration_summaries: result?.iteration_summaries,
        timestamp: row.timestamp,
      };
    });

    // ── executions ─────────────────────────────────────────────
    const executions: LiveExecution[] = [];
    for (const row of scriptRows) {
      const exec = parseJson<ExecutionResult>(row.execution_result);
      if (!exec) continue; // not run yet — nothing to show on the exec feed
      executions.push({
        script_id: row.script_id,
        subagent_id: row.subagent_id,
        status: exec.status,
        money_gained: exec.money_gained ?? 0,
        time_elapsed_seconds: exec.time_elapsed_seconds ?? 0,
        exit_reason: exec.exit_reason,
        stdout: exec.stdout,
        stderr: exec.stderr,
        error: exec.error,
        script_stats: exec.script_stats,
        timestamp: row.timestamp,
      });
    }

    // ── money series ───────────────────────────────────────────
    const series: MoneyPoint[] = snapshotRows.map((row) => {
      const gs = parseJson<GameState>(row.game_state);
      return {
        index: row.hour,
        money: Number(gs?.current_money ?? 0),
        timestamp: row.timestamp,
        read_failed: gs?.read_failed === true,
      };
    });
    // A failed read is a placeholder, not a real zero. Prefer the latest
    // trustworthy point so the headline number can't crash to 0 because
    // one RFA read timed out (the PDS7 cycle-16 failure mode).
    const trustworthy = series.filter((p) => !p.read_failed);
    const latest = trustworthy.at(-1) ?? series.at(-1);
    const starting = trustworthy[0]?.money ?? series[0]?.money ?? 0;
    const current = runRow.final_money ?? latest?.money ?? 0;

    // ── per-subagent rollup ────────────────────────────────────
    const bySubagent = new Map<string, LiveSubagent>();
    const ensure = (id: string): LiveSubagent => {
      let s = bySubagent.get(id);
      if (!s) {
        s = {
          subagent_id: id,
          delegations: 0,
          pending: 0,
          errors: 0,
          money_earned: 0,
          tokens_used: 0,
          last_task: null,
          last_state: null,
        };
        bySubagent.set(id, s);
      }
      return s;
    };

    // delegations are newest-first, so the first one seen per subagent
    // is its most recent.
    for (const d of delegations) {
      const s = ensure(d.subagent_id);
      s.delegations += 1;
      if (d.state === "pending") s.pending += 1;
      if (d.state === "error" || d.state === "timeout") s.errors += 1;
      s.tokens_used += d.tokens_used ?? 0;
      if (s.last_state === null) {
        s.last_task = d.task;
        s.last_state = d.state;
      }
    }
    for (const e of executions) {
      ensure(e.subagent_id).money_earned += e.money_gained;
    }

    const subagentRecorded = runRow.subagent_tokens ?? 0;
    const subagentObserved = delegations.reduce(
      (sum, d) => sum + (d.tokens_used ?? 0),
      0,
    );
    const orchestratorTokens = runRow.orchestrator_tokens ?? 0;
    const subagentTokens = Math.max(subagentRecorded, subagentObserved);

    const startMs = Date.parse(runRow.start_time);
    const endMs = runRow.end_time ? Date.parse(runRow.end_time) : now.getTime();
    const elapsed = Number.isFinite(startMs)
      ? Math.max(0, Math.round((endMs - startMs) / 1000))
      : 0;

    return {
      generated_at: now.toISOString(),
      run: {
        run_id: runRow.run_id,
        orchestrator_model: runRow.orchestrator_model,
        subagent_roster: parseJson<string[]>(runRow.subagent_roster) ?? [],
        status: runRow.status,
        start_time: runRow.start_time,
        end_time: runRow.end_time,
        elapsed_seconds: elapsed,
        final_money: runRow.final_money,
        failure_reason: runRow.failure_reason,
        orchestrator_tokens: runRow.orchestrator_tokens ?? 0,
        subagent_tokens: runRow.subagent_tokens ?? 0,
        bitburner_commit: runRow.bitburner_commit,
      },
      money: {
        current,
        starting,
        gained: current - starting,
        series,
      },
      tokens: {
        orchestrator: orchestratorTokens,
        subagent: subagentTokens,
        total: orchestratorTokens + subagentTokens,
        subagent_recorded: subagentRecorded,
        subagent_observed: subagentObserved,
      },
      subagents: [...bySubagent.values()].sort((a, b) =>
        a.subagent_id.localeCompare(b.subagent_id),
      ),
      delegations,
      executions,
      totals: {
        latest_delegated_cycle: delegations.length ? delegations[0].cycle_number : 0,
        delegations: delegations.length,
        pending: delegations.filter((d) => d.state === "pending").length,
        errors: delegations.filter(
          (d) => d.state === "error" || d.state === "timeout",
        ).length,
        scripts_run: executions.length,
      },
    };
  } finally {
    db.close();
  }
}
