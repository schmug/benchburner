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
    /**
     * The subagent's own reasoning on that turn — what it was trying and
     * why. Only the final turn's notes become `reasoning` above, so
     * without this the intermediate thinking behind a multi-iteration
     * instruction is lost.
     */
    notes?: string;
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
  /**
   * Per-subagent committed-script stats, keyed by subagent_id, as
   * reported by the in-game dispatcher. Reaches the orchestrator as
   * `SubagentStatus.live_script`, not through the game_state channel —
   * `scrubInput` projects game_state onto an explicit key list.
   */
  live_scripts?: Record<string, LiveScript>;
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

/**
 * What became of the script a subagent committed to the game — the
 * compact form the orchestrator sees.
 *
 * Distinct from `Result.iteration_summaries`, which covers the probe
 * runs inside the subagent's own write-run-observe loop. This is the
 * committed script: whether it actually started, and what it earned.
 * Without it the orchestrator cannot tell a script that is earning from
 * one that never ran, which is the difference the system prompt (SPEC
 * §3.3) already promises it can see.
 *
 * Deliberately omits `game_state_snapshot` — game state has its own
 * top-level channel, and repeating it per subagent inflates the prompt
 * without adding information.
 */
export interface ExecutionSummary {
  status: ExecutionResult["status"];
  exit_reason?: string;
  money_gained: number;
  time_elapsed_seconds: number;
  error?: string;
  /** Truncated; a chatty script must not dominate the prompt budget. */
  stdout?: string;
  stderr?: string;
  script_stats?: Record<string, number | string>;
  timestamp: string;
}

/**
 * Live state of a subagent's committed script, refreshed every time the
 * harness reads game state.
 *
 * `last_execution` answers "did my instruction produce a script that
 * started". This answers "is it still earning". Instruction quality is
 * not observable without both — the 24h run had neither and re-instructed
 * blindly for seventeen hours.
 *
 * `money_made` is the script's OWN earnings, read from
 * `ns.getRunningScript().onlineMoneyMade`. That distinction is the whole
 * point: `ExecutionResult.money_gained` is a global player delta and
 * cannot be attributed once more than one script is running.
 *
 * Every field is numeric or boolean. `scrubInput` builds SubagentStatus
 * with a spread, so if this ever gains a string field it must be scrubbed
 * there explicitly — see the note at that spread.
 */
export interface LiveScript {
  running: boolean;
  /** This script's own earnings — not a global player delta. */
  money_made: number;
  ram: number;
  uptime_seconds: number;
}

export interface SubagentStatus {
  subagent_id: string;
  last_instruction_id: string | null;
  last_result: Result | null;
  /** Outcome of this subagent's most recent committed script, if any. */
  last_execution?: ExecutionSummary | null;
  /** This subagent's committed script, if it has one running. */
  live_script?: LiveScript | null;
  status: "idle" | "pending" | "executed";
  model_choice?: string;
}

export interface OrchestratorInput {
  cycle_number: number;
  elapsed_time_seconds: number;
  total_duration_seconds: number;
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
  /**
   * Replace this subagent's currently running committed script with the
   * one this instruction produces. `instruct` only.
   *
   * Defaults to false, and the asymmetry is the reason: an accumulating
   * script eventually exhausts the shared RAM budget and surfaces as
   * `failed_to_start` in `last_execution` — loud and attributable —
   * whereas killing an earner produces no event at all. The silent
   * failure is the one that ran for seventeen hours undetected.
   *
   * It lives on the action rather than on `Instruction` because script
   * lifecycle is a directive to the harness, not something the subagent
   * needs in order to write code (SPEC §2.1 is unchanged).
   */
  replace?: boolean;
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
  adapter: "ollama" | "http" | "claude-cli" | "test-hang" | "test-scripted" | "null-orchestrator";
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
  /**
   * Per-model override of the orchestrator-call completion-token cap
   * (the harness default is `min(context_window - 1024, 4096)`).
   *
   * Reasoning models — Kimi K2.6, gpt-oss-thinking, qwen3-thinking,
   * deepseek-r1-style — emit a chain-of-thought trace that counts
   * against the same `max_tokens` budget as the visible answer.
   * With the 4096 default, the trace frequently consumes the whole
   * budget before any `content` is emitted: response comes back
   * with `finish_reason: "length"` and `content: ""`, and the
   * orchestrator parser sees an empty string.
   *
   * Set this to a value comfortably above the model's typical
   * reasoning length plus the answer; for Kimi K2.6 a 16K-32K
   * override is appropriate.
   *
   * Capped at `context_window - 1024` at use site so a misconfig
   * can't push the model over its window. Optional: when omitted,
   * the existing default applies (no behavior change).
   */
  max_completion_tokens?: number;
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
    /**
     * Retire this subagent's previous committed script — but only once
     * this one is confirmed running. Defaults to false; see
     * `OrchestratorAction.replace`. Ignored for probes, which never
     * occupy the committed slot.
     */
    replace?: boolean;
  }): Promise<ExecutionResult>;

  /**
   * Stop this subagent's committed script, if any. Called when the
   * orchestrator kills a subagent — otherwise the script outlives its
   * owner as an orphan that still consumes RAM and earns invisibly.
   */
  killScript(subagent_id: string): Promise<void>;

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
    /**
     * Hard upper bound on how long a single orchestrator inference call
     * may run before the harness aborts the request. Decoupled from
     * `hang_timeout_seconds` so the cycle-level inference deadline can
     * be tuned to the orchestrator model's reasoning latency without
     * also changing the run-level "orchestrator hung" detection window.
     *
     * When unset, the harness falls back to the historical formula
     * `max(30, hang_timeout_seconds * 0.5)`, so existing run configs
     * are unchanged. Set this explicitly when running a reasoning model
     * (Kimi K2.6, gpt-oss-thinking, qwen3-thinking) whose chain-of-
     * thought trace makes per-call latency unrelated to the hang-
     * detection window — e.g. 900 (15 min) for Kimi K2.6 with a 10-
     * cycle delegation history.
     *
     * Validated by the loader: positive integer, ≤ 3600.
     */
    per_cycle_timeout_seconds?: number;
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
  /**
   * Canonical run length. Seconds rather than hours because the
   * canonical measurement run is 20 minutes; YAML accepts either
   * `duration_hours` or `duration_minutes` and the loader resolves
   * both to this.
   */
  duration_seconds: number;
  /**
   * Overrides the proportional snapshot cadence. Left undefined by
   * almost every config — set it only to deliberately alter the
   * orchestrator's snapshot channel, since doing so makes a run
   * incomparable to runs that did not.
   */
  snapshot_interval_seconds?: number;
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

/** How a single orchestrator tick ended. */
export type CycleStatus = "ok" | "malformed" | "failed";

export interface CycleRow {
  run_id: string;
  cycle_number: number;
  status: CycleStatus;
  /**
   * The orchestrator's free-form explanation of its own decisions.
   * SPEC §3.2 logs it but does not score it; until this row existed it
   * was parsed and then discarded, so no artifact ever carried the
   * reasoning behind a run's delegation pattern.
   */
  reasoning: string | null;
  actions: string; // JSON array of OrchestratorAction
  tokens_used: number;
  latency_ms: number;
  error: string | null;
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
  /**
   * Kept for backward compatibility: existing run artifacts carry it
   * and aggregator/build.ts reads it. Now derived from the run's
   * effective duration, so it is fractional on sub-hour runs — it used
   * to be copied from config.duration_hours, which meant every
   * 20-minute PCS1/PDS6 run recorded itself as a 1-hour run.
   */
  duration_hours: number;
  /** Precise effective run length. Prefer this over duration_hours. */
  duration_seconds: number;
}
