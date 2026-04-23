/**
 * Orchestrator loop — the decision-making core.
 *
 * Every `polling_interval_seconds`:
 *   1. Assemble SPEC §3.1 input from current state + pool + history.
 *   2. Wrap in the §3.3 prompt (leak-audited).
 *   3. Call the orchestrator inference adapter.
 *   4. Parse the JSON output.
 *   5. Dispatch `spawn` / `kill` / `instruct` / `noop` actions to the
 *      bus and mutate the subagent pool.
 *   6. Record everything to storage.
 *
 * Also listens on `results` and `executions` channels to thread
 * subagent responses and game execution outcomes back into the
 * delegation record + history.
 *
 * Hang detection: if no cycle completes for `hang_timeout_seconds`,
 * fail the run.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { Bus } from "../bus/bus";
import type { Db } from "../storage/db";
import {
  insertDelegation,
  insertScript,
  updateDelegationResult,
  updateScriptExecution,
} from "../storage/writers";
import type { InferenceRegistry } from "../inference/registry";
import type {
  ExecutionResult,
  GameController,
  GameState,
  Instruction,
  OrchestratorAction,
  OrchestratorInput,
  OrchestratorOutput,
  Result,
  RunConfig,
  SubagentStatus,
} from "../types";
import type { SubagentPool } from "../subagent/pool";
import { HistoryBuffer } from "./history";
import { buildOrchestratorPrompt, detectLeaks } from "./prompt";

/**
 * JSON schema the orchestrator's per-cycle output must conform to.
 * Ollama / OpenAI-json-schema adapters will force compliance; other
 * adapters ignore this and rely on the SPEC §3.3 system-prompt
 * template.
 */
const ORCHESTRATOR_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action_type: { type: "string", enum: ["spawn", "kill", "instruct", "noop"] },
          subagent_id: { type: "string" },
          model_choice: { type: "string" },
          instruction: {
            type: "object",
            properties: {
              task: { type: "string" },
              context: { type: "string" },
              constraints: {
                type: "object",
                properties: {
                  token_budget: { type: "number" },
                  max_script_size_lines: { type: "number" },
                },
              },
            },
          },
        },
        required: ["action_type"],
      },
    },
    reasoning: { type: "string" },
  },
  required: ["actions"],
};

export interface LoopOptions {
  run_id: string;
  config: RunConfig;
  bus: Bus;
  db: Db;
  game: GameController;
  pool: SubagentPool;
  registry: InferenceRegistry;
  /** Directory where orchestrator-prompts.log is appended. */
  logDir: string;
  /** Called on fatal conditions (hang, inference model missing). */
  onFatal(reason: string): void;
}

interface SubagentTrack {
  last_instruction_id: string | null;
  last_result: Result | null;
  pending: boolean;
}

export class OrchestratorLoop {
  private readonly run_id: string;
  private readonly config: RunConfig;
  private readonly bus: Bus;
  private readonly db: Db;
  private readonly game: GameController;
  private readonly pool: SubagentPool;
  private readonly registry: InferenceRegistry;
  private readonly logDir: string;
  private readonly onFatal: (reason: string) => void;

  private readonly history: HistoryBuffer;
  private readonly subagentTracks = new Map<string, SubagentTrack>();
  /** instruction_id → delegation_id so result+execution updates can find the row. */
  private readonly delegationsByInstruction = new Map<string, string>();
  /** instruction_id → cycle_number for the history entry when the result lands. */
  private readonly cycleByInstruction = new Map<string, number>();
  /** instruction_id → script_id so executions update the right script row. */
  private readonly scriptByInstruction = new Map<string, string>();

  private cycle = 0;
  private startedAt = 0;
  private lastCycleCompletedAt = 0;
  private latestState: GameState | null = null;
  private running = false;
  private cycleInFlight = false;
  private timer?: NodeJS.Timeout;
  private hangTimer?: NodeJS.Timeout;
  private unsubscribeHandlers: Array<() => void> = [];

  constructor(opts: LoopOptions) {
    this.run_id = opts.run_id;
    this.config = opts.config;
    this.bus = opts.bus;
    this.db = opts.db;
    this.game = opts.game;
    this.pool = opts.pool;
    this.registry = opts.registry;
    this.logDir = opts.logDir;
    this.onFatal = opts.onFatal;
    this.history = new HistoryBuffer(opts.config.orchestrator.history_window);
    mkdirSync(this.logDir, { recursive: true });
  }

  start(initialState: GameState): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.lastCycleCompletedAt = Date.now();
    this.latestState = initialState;

    this.unsubscribeHandlers.push(
      this.bus.subscribe("results", (r) => this.onResult(r)),
      this.bus.subscribe("executions", (e) => this.onExecution(e)),
      this.bus.subscribe("snapshots", (s) => {
        this.latestState = s.game_state;
      }),
    );

    // First cycle fires immediately so the orchestrator can seed its plan.
    void this.runCycle();
    this.timer = setInterval(() => void this.runCycle(), this.config.orchestrator.polling_interval_seconds * 1000);
    this.hangTimer = setInterval(() => this.checkHang(), 30_000);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.hangTimer) clearInterval(this.hangTimer);
    for (const un of this.unsubscribeHandlers) un();
    this.unsubscribeHandlers = [];
    // Wait up to 5s for an in-flight cycle to settle.
    const deadline = Date.now() + 5_000;
    while (this.cycleInFlight && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private checkHang(): void {
    const quietMs = Date.now() - this.lastCycleCompletedAt;
    if (quietMs >= this.config.orchestrator.hang_timeout_seconds * 1000) {
      this.onFatal(`orchestrator hang: no cycle completed for ${Math.round(quietMs / 1000)}s`);
    }
  }

  private async runCycle(): Promise<void> {
    if (!this.running || this.cycleInFlight) return;
    this.cycleInFlight = true;
    this.cycle += 1;
    const cycleStart = Date.now();

    try {
      const input = this.assembleInput();
      const { system, user, leak_check_violations } = buildOrchestratorPrompt(input, this.config.game.seed);

      this.appendPromptLog({ cycle: this.cycle, system, user, leak_check_violations });
      if (leak_check_violations.length > 0) {
        // Leak policy violation → fail closed. Logged loudly.
        console.error(`[orchestrator] leak violations in cycle ${this.cycle}: ${leak_check_violations.join(", ")}`);
        this.onFatal(`leak policy violated in cycle ${this.cycle}: ${leak_check_violations.join(", ")}`);
        return;
      }

      const model = this.config.orchestrator.model;
      const resolved = this.registry.get(model);

      const maxTokens = Math.min(
        resolved.config.context_window - 1024,
        4096,
      );

      const raw = await resolved.adapter.invoke({
        model: resolved.modelName,
        prompt: user,
        system,
        max_tokens: maxTokens,
        // NOTE: intentionally do NOT force responseFormat on the
        // orchestrator path. Ollama's schema-constrained output
        // breaks reasoning models (gpt-oss, qwen3*): the thinking
        // stream gets starved, response comes back empty. Orchestrators
        // rely on SPEC §3.3 system-prompt discipline + our lenient
        // parser (accepts bare JSON / fenced / first-balanced-object).
      });

      const parsed = parseOrchestratorOutput(raw.text);
      if (!parsed) {
        console.warn(`[orchestrator] cycle ${this.cycle}: malformed JSON from model; treating as noop`);
      } else {
        await this.dispatchActions(parsed.actions);
      }

      this.lastCycleCompletedAt = Date.now();
      const ms = this.lastCycleCompletedAt - cycleStart;
      console.log(
        `[orchestrator] cycle ${this.cycle} done in ${ms}ms — actions=${parsed?.actions.length ?? 0}, pool=${this.pool.size()}, money=${this.latestState?.current_money ?? "?"}`,
      );
    } catch (e) {
      console.error(`[orchestrator] cycle ${this.cycle} failed:`, (e as Error).message);
    } finally {
      this.cycleInFlight = false;
    }
  }

  private assembleInput(): OrchestratorInput {
    const elapsedSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
    const { verbatim, summary } = this.history.view();

    const subagent_status: SubagentStatus[] = this.pool.list().map((s) => {
      const t = this.subagentTracks.get(s.subagent_id);
      return {
        subagent_id: s.subagent_id,
        model_choice: s.model,
        last_instruction_id: t?.last_instruction_id ?? null,
        last_result: t?.last_result ?? null,
        status: !t ? "idle" : t.pending ? "pending" : "executed",
      };
    });

    return {
      cycle_number: this.cycle,
      elapsed_time_seconds: elapsedSeconds,
      game_state: this.latestState ?? { current_money: 0, bitnode_id: 1, bitnode_complete: false },
      subagent_status,
      delegation_history: verbatim,
      delegation_history_summary: summary,
      available_subagent_models: [...this.config.subagent_roster],
    };
  }

  private async dispatchActions(actions: OrchestratorAction[]): Promise<void> {
    for (const a of actions) {
      switch (a.action_type) {
        case "spawn":
          this.handleSpawn(a);
          break;
        case "kill":
          this.handleKill(a);
          break;
        case "instruct":
          this.handleInstruct(a);
          break;
        case "noop":
          break;
        default:
          console.warn(`[orchestrator] unknown action_type: ${JSON.stringify(a)}`);
      }
    }
  }

  private handleSpawn(a: OrchestratorAction): void {
    const model = a.model_choice;
    if (!model || !this.config.subagent_roster.includes(model)) {
      console.warn(`[orchestrator] rejected spawn: model_choice "${model}" not in roster`);
      return;
    }
    const subagent_id = a.subagent_id && !this.pool.has(a.subagent_id) ? a.subagent_id : `${model}-${randomUUID().slice(0, 8)}`;
    this.pool.spawn(subagent_id, model, new Date().toISOString());
    this.subagentTracks.set(subagent_id, { last_instruction_id: null, last_result: null, pending: false });
  }

  private handleKill(a: OrchestratorAction): void {
    if (!a.subagent_id) return;
    this.pool.kill(a.subagent_id);
    this.subagentTracks.delete(a.subagent_id);
  }

  private handleInstruct(a: OrchestratorAction): void {
    if (!a.subagent_id || !a.instruction) return;
    if (!this.pool.has(a.subagent_id)) {
      console.warn(`[orchestrator] rejected instruct: ${a.subagent_id} not in pool`);
      return;
    }
    const instruction: Instruction = {
      instruction_id: a.instruction.instruction_id ?? randomUUID(),
      subagent_id: a.subagent_id,
      task: a.instruction.task,
      context: a.instruction.context ?? "",
      constraints: {
        token_budget: a.instruction.constraints?.token_budget ?? this.config.subagent_limits.token_budget_per_instruction,
        max_script_size_lines: a.instruction.constraints?.max_script_size_lines ?? 200,
      },
      timestamp: new Date().toISOString(),
    };

    const delegation_id = randomUUID();
    insertDelegation(this.db, {
      delegation_id,
      run_id: this.run_id,
      cycle_number: this.cycle,
      action: a,
      subagent_id: a.subagent_id,
      instruction_id: instruction.instruction_id,
      result: null,
      timestamp: instruction.timestamp,
    });
    this.delegationsByInstruction.set(instruction.instruction_id, delegation_id);
    this.cycleByInstruction.set(instruction.instruction_id, this.cycle);

    const track = this.subagentTracks.get(a.subagent_id) ?? { last_instruction_id: null, last_result: null, pending: false };
    track.last_instruction_id = instruction.instruction_id;
    track.pending = true;
    this.subagentTracks.set(a.subagent_id, track);

    this.history.record({
      cycle_number: this.cycle,
      instruction,
      result: null,
    });

    this.bus.publish("instructions", instruction);
  }

  private onResult(r: Result): void {
    const delegation_id = this.delegationsByInstruction.get(r.instruction_id);
    if (delegation_id) {
      updateDelegationResult(this.db, delegation_id, r);
    }
    const track = this.subagentTracks.get(r.subagent_id);
    if (track) {
      track.last_result = r;
      track.pending = false;
    }
    // Update history entry if still in window.
    const cycle = this.cycleByInstruction.get(r.instruction_id);
    if (cycle !== undefined) {
      // The HistoryBuffer is append-only; mutate the entry directly.
      // (We stored a reference.)
      const entries = (this.history as unknown as { entries: Array<{ cycle_number: number; instruction: Instruction; result: Result | null }> }).entries;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].instruction.instruction_id === r.instruction_id) {
          entries[i].result = r;
          break;
        }
      }
    }

    // On success, submit the script to the game and record it.
    if (r.status === "success" && r.code) {
      const script_id = randomUUID();
      this.scriptByInstruction.set(r.instruction_id, script_id);
      insertScript(this.db, {
        script_id,
        run_id: this.run_id,
        subagent_id: r.subagent_id,
        instruction_id: r.instruction_id,
        code: r.code,
        tokens_used: r.tokens_used,
        timestamp: new Date().toISOString(),
      });
      void this.executeScript(script_id, r);
    }
  }

  private async executeScript(script_id: string, r: Result): Promise<void> {
    if (!r.code) return;
    try {
      await this.game.submitScript({ script_id, code: r.code });
      const exec = await this.game.runScript({ script_id, subagent_id: r.subagent_id });
      updateScriptExecution(this.db, script_id, exec);
      this.bus.publish("executions", exec);
    } catch (e) {
      const err = e as Error;
      const exec: ExecutionResult = {
        script_id,
        subagent_id: r.subagent_id,
        status: "failed",
        money_gained: 0,
        time_elapsed_seconds: 0,
        error: err.message,
        game_state_snapshot: this.latestState ?? { current_money: 0, bitnode_id: 1, bitnode_complete: false },
        timestamp: new Date().toISOString(),
      };
      updateScriptExecution(this.db, script_id, exec);
      this.bus.publish("executions", exec);
    }
  }

  private onExecution(e: ExecutionResult): void {
    this.latestState = e.game_state_snapshot;
  }

  private appendPromptLog(entry: { cycle: number; system: string; user: string; leak_check_violations: string[] }): void {
    const line = JSON.stringify({
      cycle: entry.cycle,
      at: new Date().toISOString(),
      leak_check_violations: entry.leak_check_violations,
      system: entry.system,
      user: entry.user,
    });
    appendFileSync(path.join(this.logDir, "orchestrator-prompts.log"), line + "\n");
  }
}

/**
 * Parse the orchestrator model's output. Accepts raw JSON and JSON
 * inside ```json ... ``` fences. Returns null on malformed output so
 * the loop can treat that cycle as noop.
 */
export function parseOrchestratorOutput(text: string): OrchestratorOutput | null {
  const stripped = stripJsonFence(text).trim();
  // Some models emit the JSON plus trailing prose. Find the first
  // balanced JSON object from the start.
  const jsonStr = extractFirstJsonObject(stripped) ?? stripped;
  try {
    const parsed = JSON.parse(jsonStr) as OrchestratorOutput;
    if (!parsed || !Array.isArray(parsed.actions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function stripJsonFence(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1] : s;
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\" && inStr) {
      escape = true;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export const __testing = { parseOrchestratorOutput, detectLeaks };
