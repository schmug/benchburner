/**
 * Shared type contracts across the harness. Mirrors SPEC §2 (message
 * contracts), §3 (orchestrator I/O), §4 (DB rows), §6 (inference
 * adapter), and §10 (config schemas).
 *
 * All modules import from here so the bus, storage, game, orchestrator,
 * and subagent implementations stay in sync on a single source of truth.
 */

// ────────────────────────────────────────────────────────────────────
// Message contracts (SPEC §2)
// ────────────────────────────────────────────────────────────────────

export interface Instruction {
  instruction_id: string;
  subagent_id: string;
  task: string;
  context: string;
  constraints: {
    token_budget: number;
    max_script_size_lines: number;
  };
  timestamp: string;
}

export type ResultStatus = "success" | "error" | "timeout";

export interface Result {
  instruction_id: string;
  subagent_id: string;
  status: ResultStatus;
  code?: string;
  reasoning?: string;
  tokens_used: number;
  error_message?: string;
  timestamp: string;
}

export interface GameState {
  current_money: number;
  bitnode_id: number;
  bitnode_complete: boolean;
  augments_installed?: string[];
  // Extension point; distilled snapshots may carry more observables.
  [key: string]: unknown;
}

export interface ExecutionResult {
  script_id: string;
  subagent_id: string;
  status: "executed" | "failed";
  money_gained: number;
  time_elapsed_seconds: number;
  error?: string;
  game_state_snapshot: GameState;
  timestamp: string;
}

export interface Snapshot {
  source: "backend_snapshot";
  hour: number;
  game_state: GameState;
  timestamp: string;
}

// ────────────────────────────────────────────────────────────────────
// Orchestrator I/O (SPEC §3.1, §3.2)
// ────────────────────────────────────────────────────────────────────

export interface SubagentStatus {
  subagent_id: string;
  last_instruction_id: string | null;
  last_result: Result | null;
  status: "idle" | "pending" | "executed";
  model_choice?: string;
}

export interface OrchestratorInput {
  cycle_number: number;
  elapsed_time_seconds: number;
  game_state: GameState;
  subagent_status: SubagentStatus[];
  delegation_history: Array<{ instruction: Instruction; result: Result | null }>;
  /** Rolling summary of cycles older than `history_window`, if any. */
  delegation_history_summary?: string;
  available_subagent_models: string[];
}

export type OrchestratorActionType = "spawn" | "kill" | "instruct" | "noop";

export interface OrchestratorAction {
  action_type: OrchestratorActionType;
  subagent_id?: string;
  model_choice?: string;
  instruction?: Instruction;
}

export interface OrchestratorOutput {
  actions: OrchestratorAction[];
  reasoning: string;
}

// ────────────────────────────────────────────────────────────────────
// Inference (SPEC §6)
// ────────────────────────────────────────────────────────────────────

export interface InferenceInvokeParams {
  model: string;
  prompt: string;
  max_tokens: number;
  system?: string;
  stop?: string[];
  /** AbortSignal — adapters that support cancellation should honor it. */
  signal?: AbortSignal;
}

export interface InferenceResult {
  text: string;
  tokens_used: number;
  finish_reason: "stop" | "length" | "error";
}

export interface InferenceAdapter {
  readonly name: string;
  invoke(params: InferenceInvokeParams): Promise<InferenceResult>;
}

export interface ModelConfig {
  id: string;
  adapter: "ollama" | "http";
  endpoint: string;
  context_window: number;
  model_name?: string;
  api_key_env?: string;
}

// ────────────────────────────────────────────────────────────────────
// Game controller (Phase 4 real impl + Phase 2 mock)
// ────────────────────────────────────────────────────────────────────

export interface GameController {
  /** Boot the game and block until it's ready to accept scripts. */
  start(): Promise<void>;

  /** Push a subagent-generated Netscript file onto the `home` server. */
  submitScript(params: { script_id: string; code: string }): Promise<void>;

  /**
   * Run a previously-submitted script and return the execution result
   * (money gained, time elapsed, errors, resulting game state).
   */
  runScript(params: { script_id: string; subagent_id: string }): Promise<ExecutionResult>;

  /** Pull current distilled game state (for hourly snapshots). */
  readState(): Promise<GameState>;

  /** Gracefully shut down the game process. */
  stop(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────
// Run config (SPEC §10.1)
// ────────────────────────────────────────────────────────────────────

export interface RunConfig {
  run_id: string; // "auto" → replaced with uuid by the loader
  orchestrator: {
    model: string;
    polling_interval_seconds: number;
    history_window: number;
    hang_timeout_seconds: number;
  };
  subagent_roster: string[];
  subagent_limits: {
    max_concurrent: number;
    token_budget_per_instruction: number;
    timeout_seconds: number;
  };
  game: {
    bitburner_commit: string;
    seed: number;
  };
  duration_hours: number;
  attribution_mode: "public" | "anonymous";
}

// ────────────────────────────────────────────────────────────────────
// Bus channel map (referenced by bus.ts for typed pub/sub)
// ────────────────────────────────────────────────────────────────────

export interface ChannelMap {
  instructions: Instruction;
  results: Result;
  executions: ExecutionResult;
  snapshots: Snapshot;
}

// ────────────────────────────────────────────────────────────────────
// Storage row shapes (SPEC §4)
// ────────────────────────────────────────────────────────────────────

export type RunStatus = "in_progress" | "completed" | "failed";

export interface RunRow {
  run_id: string;
  orchestrator_model: string;
  orchestrator_config: string; // JSON-stringified
  subagent_roster: string; // JSON array of model ids
  seed: number;
  bitburner_commit: string;
  start_time: string;
  end_time: string | null;
  final_money: number | null;
  final_stats: string | null; // JSON
  status: RunStatus;
  failure_reason: string | null;
  attribution_mode: "public" | "anonymous";
}

export interface DelegationRow {
  delegation_id: string;
  run_id: string;
  cycle_number: number;
  action: string; // JSON
  subagent_id: string;
  instruction_id: string;
  result: string | null; // JSON
  timestamp: string;
}

export interface ScriptRow {
  script_id: string;
  run_id: string;
  subagent_id: string;
  instruction_id: string;
  code: string;
  executed_in_game: number; // 0 | 1 (SQLite bool)
  execution_result: string | null; // JSON
  tokens_used: number;
  timestamp: string;
}

export interface SnapshotRow {
  snapshot_id: string;
  run_id: string;
  hour: number;
  game_state: string; // JSON
  timestamp: string;
}

// ────────────────────────────────────────────────────────────────────
// Summary / leaderboard entry (SPEC §8; aggregator reads this shape)
// ────────────────────────────────────────────────────────────────────

export interface RunSummary {
  run_id: string;
  orchestrator_model: string;
  attribution: "public" | "anonymous";
  final_money: number;
  bitnodes_completed: number;
  augments_installed: number;
  status: RunStatus;
  failure_reason: string | null;
  bitburner_commit: string;
  start_time: string;
  end_time: string | null;
  duration_hours: number;
}
