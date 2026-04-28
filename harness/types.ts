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
  /** Number of write-run-observe iterations the subagent used (agentic loop). */
  iterations?: number;
  /**
   * Per-iteration execution outcomes the subagent observed. Used by the
   * orchestrator only in summary form; the full trace stays in storage.
   */
  iteration_summaries?: Array<{
    iteration: number;
    exit_reason?: string;
    money_gained?: number;
    stderr?: string;
  }>;
  timestamp: string;
}

export interface GameState {
  current_money: number;
  bitnode_id: number;
  bitnode_complete: boolean;
  augments_installed?: string[];
  /**
   * Wall-clock ms (Date.now()) the in-game dispatcher last completed a
   * loop iteration. Used by waitForDispatcherAlive and liveness probes
   * to distinguish a running dispatcher from one that wrote
   * /__state.json once at boot and then died. Optional for backward
   * compat with older snapshots and dispatchers.
   */
  last_heartbeat_ms?: number;
  /**
   * Set to true when the harness could not actually read game state
   * from RFA (socket dead, timeout, parse failure) and synthesised a
   * placeholder. Consumers MUST treat current_money/etc. as garbage in
   * that case and NOT overwrite a previously-good cached state.
   *
   * Without this flag a failed read is indistinguishable from a real
   * "money is zero" snapshot, which poisons OrchestratorLoop.latestState
   * permanently (PDS7 cycle 16 incident).
   */
  read_failed?: boolean;
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
  /** stdout captured from ns.print / ns.tprint calls. May be truncated. */
  stdout?: string;
  /** Runtime error / exception / kill reason from the game-side runner. */
  stderr?: string;
  /** "exited" | "killed" | "errored" | "timed_out" — coarse-grained exit class. */
  exit_reason?: string;
  /** exp gained + ram usage + online seconds; see dispatcher.js for fields. */
  script_stats?: Record<string, number | string>;
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
  /**
   * Constrain the model's output. "json" forces any valid JSON; an
   * object is passed as a JSON schema the response must conform to.
   * Adapters that don't support structured output should ignore this
   * and fall back to natural-language prompting.
   */
  responseFormat?: "json" | Record<string, unknown>;
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
  adapter: "ollama" | "http" | "test-hang" | "test-scripted" | "null-orchestrator";
  endpoint: string;
  context_window: number;
  model_name?: string;
  api_key_env?: string;
  /**
   * When true, the subagent worker may pass a JSON schema via
   * `responseFormat` to constrain this model's output. Known-safe
   * models (non-reasoning coders like qwen2.5-coder) benefit from
   * it. Reasoning models (gpt-oss, qwen3*) break when schema is
   * applied — Ollama starves their `thinking` stream and the
   * response comes back empty. Default false.
   */
  supports_structured_output?: boolean;
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
   * Run a previously-submitted script and return the execution result.
   *
   * `kind: "probe"` (default) is used by subagent agentic iterations —
   * dispatcher bounds it at ~120 s so one bad iteration can't stall the
   * queue, and runScript blocks until the probe result arrives.
   *
   * `kind: "committed"` is used for orchestrator-accepted final scripts
   * that should run until shutdown. runScript returns as soon as the
   * dispatcher confirms the script started (or failed_to_start); money
   * earned flows into game_state snapshots for the rest of the run.
   */
  runScript(params: {
    script_id: string;
    subagent_id: string;
    kind?: "probe" | "committed";
  }): Promise<ExecutionResult>;

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
