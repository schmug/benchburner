/**
 * SubagentWorker — consumes `instructions` from the bus and runs an
 * *agentic* write-run-observe loop on behalf of each instruction.
 *
 * Loop shape:
 *   1. Inference call asks for code + a decision token: either RUN
 *      (try it in the game, observe the result, iterate) or DONE
 *      (commit this code as the final answer).
 *   2. If RUN: harness submits the code via the GameController,
 *      captures the ExecutionResult, feeds it back into the subagent
 *      as the next inference turn's context.
 *   3. Bounded by `max_iterations` (default 3). On exhaustion we commit
 *      the most recent code with `status: "success"` and whatever the
 *      final execution looked like.
 *
 * This mirrors how a real coding agent works — write, run, read
 * errors, iterate — so the benchmark measures "orchestrator leading
 * coding agents" and not "orchestrator synthesizing write-once
 * output." See SPEC §2.1 addendum in bitburner/patches/README.md
 * (agentic-subagent decision).
 *
 * Concurrency is still capped by `max_concurrent` (default 5).
 */

import type { Bus } from "../bus/bus";
import type {
  ExecutionResult,
  GameController,
  Instruction,
  Result,
  RunConfig,
} from "../types";
import type { InferenceRegistry } from "../inference/registry";
import type { SubagentPool } from "./pool";
import { SUBAGENT_RAM_BUDGET_GB, gb } from "../game/ram-budget";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_ITERATIONS = 3;

/**
 * Infrastructure budget floor: reasoning-capable models (gpt-oss,
 * qwen3/qwen3.6) can burn 2000+ tokens inside <think> before emitting
 * a single character of response. Orchestrators typically don't know
 * their subagents' reasoning overhead — that's an implementation
 * detail of the local-model family. Without a floor, an orchestrator
 * that picks a 200-token budget starves the subagent and we measure
 * "can the orchestrator guess reasoning overhead" rather than "can
 * the orchestrator orchestrate."
 *
 * The floor is applied to the inference `max_tokens` (which caps both
 * thinking and response on Ollama). It does NOT widen the
 * orchestrator's declared instruction budget that the subagent sees
 * in its prompt — that stays the orchestrator's choice, so the
 * orchestrator's intent (terse vs verbose code) is preserved.
 */
const INFERENCE_MAX_TOKEN_FLOOR = 6000;

/**
 * JSON schema for the subagent's turn output. Adapters that support
 * structured output (Ollama, OpenAI format=json_schema) will use this
 * to force valid parses even on small / quantized models that drift
 * on large escaped-string content. Adapters that don't support it
 * ignore the field and rely on the system prompt's template.
 */
const TURN_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["RUN", "DONE"] },
    code: { type: "string" },
    notes: { type: "string" },
  },
  required: ["decision", "code"],
};

/**
 * Exported so the stated RAM budget can be pinned by test. The figure
 * here is the constraint the model actually plans against: while it read
 * "~3 GB", the 1.4 GB reclaimed from the dispatcher was unreachable —
 * no subagent would emit the scp+exec or purchaseServer shapes it was
 * reclaimed for.
 *
 * The budget is interpolated from harness/game/ram-budget.ts, never
 * restated — see that module for why it is the single source.
 */
export const SUBAGENT_SYSTEM_PROMPT = `You are a coding subagent on a software team. Your manager has given you a single task. You produce code, you may test it, and you return a final committed version.

Runtime environment (fixed, not negotiable): your code runs in a sandboxed async JavaScript runtime with ~${gb(SUBAGENT_RAM_BUDGET_GB)} GB of RAM available after harness overhead. Every script MUST take the form:

  /** @param {NS} ns */
  export async function main(ns) {
    // your code here
  }

The "ns" object is the environment API — your manager's instructions will tell you what to do with it. Do NOT write Python, shell, pseudocode, or any other language. Only this shape compiles and runs.

RAM discipline is critical. Every ns.* function you reference (even once, even inside an unreachable branch) adds its static cost to your script's total; exceed ~${gb(SUBAGENT_RAM_BUDGET_GB)} GB and the runtime rejects the script with "ns.run returned 0". Cheap: ns.hack / ns.weaken / ns.grow (~0.1 GB), the individual ns.getServerX getters (0.1-0.25 GB), ns.nuke / ns.hasRootAccess (0.05 GB). Expensive and usually avoidable: ns.getServer (2 GB — use individual getters), ns.hackAnalyzeChance (1 GB), ns.getResetInfo (1 GB). Prefer small, targeted scripts over kitchen-sink ones.

On each turn you respond with EXACTLY a JSON object:
{
  "decision": "RUN" | "DONE",
  "code": "<the full script source — always include it, not just a diff>",
  "notes": "<optional short rationale>"
}

- RUN: the harness submits your code into the sandbox and runs it. You will see the result (stdout from ns.print / ns.tprint calls, stderr from runtime errors or kill reason, exit_reason, any side effects the task tracks) on your next turn. Iterate on the code based on what you observed. You have a bounded iteration budget — use it deliberately, not reflexively.
- DONE: commit this code as your final answer. No further inference calls. Use DONE when you're satisfied with the code OR when you've run out of useful probes.

Rules:
- Output ONLY the JSON. No prose, no markdown fences, no explanation outside it.
- "code" must be the complete script as a string. The harness replaces whatever you pushed previously with this new code each RUN.
- Respect the line budget your manager specifies. If you can't fit, simplify; do not truncate mid-statement.
- You have no memory between tasks; only within this one conversation.`;

export interface WorkerOptions {
  bus: Bus;
  registry: InferenceRegistry;
  pool: SubagentPool;
  limits: RunConfig["subagent_limits"];
  /** Game controller used to run code during subagent iterations. */
  game: GameController;
  /** Max write-run-observe iterations per instruction. Default 3. */
  maxIterations?: number;
}

interface TurnOutput {
  decision: "RUN" | "DONE";
  code: string;
  notes?: string;
}

export class SubagentWorker {
  private readonly bus: Bus;
  private readonly registry: InferenceRegistry;
  private readonly pool: SubagentPool;
  private readonly limits: RunConfig["subagent_limits"];
  private readonly game: GameController;
  private readonly maxIterations: number;
  private readonly inFlight = new Set<Promise<void>>();
  private queue: Instruction[] = [];
  private stopped = false;
  private unsubscribe?: () => void;
  /** Running total of tokens spent across all subagent inference
   *  calls (including RUN iterations that didn't reach DONE). Read
   *  by the run entry point for cost capping. */
  public tokensUsedTotal = 0;

  constructor(opts: WorkerOptions) {
    this.bus = opts.bus;
    this.registry = opts.registry;
    this.pool = opts.pool;
    this.limits = opts.limits;
    this.game = opts.game;
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe("instructions", (instr) => {
      if (this.stopped) return;
      this.queue.push(instr);
      this.pump();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.queue = [];
    await Promise.allSettled([...this.inFlight]);
  }

  private pump(): void {
    while (!this.stopped && this.inFlight.size < this.limits.max_concurrent && this.queue.length > 0) {
      const instr = this.queue.shift()!;
      const p = this.handleOne(instr).finally(() => {
        this.inFlight.delete(p);
        if (!this.stopped) this.pump();
      });
      this.inFlight.add(p);
    }
  }

  private async handleOne(instr: Instruction): Promise<void> {
    const model = this.pool.modelFor(instr.subagent_id);
    if (!model) {
      this.publishResult({
        instruction_id: instr.instruction_id,
        subagent_id: instr.subagent_id,
        status: "error",
        tokens_used: 0,
        error_message: `subagent_id ${instr.subagent_id} is not in the pool (was it spawned?)`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    let resolved: {
      adapter: import("../types").InferenceAdapter;
      modelName: string;
      supportsSchema: boolean;
    };
    try {
      const r = this.registry.get(model);
      resolved = {
        adapter: r.adapter,
        modelName: r.modelName,
        supportsSchema: Boolean(r.config.supports_structured_output),
      };
    } catch (e) {
      this.publishResult({
        instruction_id: instr.instruction_id,
        subagent_id: instr.subagent_id,
        status: "error",
        tokens_used: 0,
        error_message: `model lookup failed for "${model}": ${(e as Error).message}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Derived from Result so the two cannot drift — this was a local
    // duplicate that silently omitted fields added to the shared type.
    const iterations: NonNullable<Result["iteration_summaries"]> = [];
    const transcript: string[] = [buildInitialPrompt(instr)];
    let totalTokens = 0;
    let lastCode = "";
    let lastNotes: string | undefined;

    for (let i = 1; i <= this.maxIterations; i += 1) {
      const turnPrompt = transcript.join("\n\n---\n\n");
      let raw: { text: string; tokens_used: number; finish_reason: "stop" | "length" | "error" };
      try {
        raw = await this.invokeWithTimeout(
          resolved,
          turnPrompt,
          Math.max(instr.constraints.token_budget, INFERENCE_MAX_TOKEN_FLOOR),
        );
      } catch (e) {
        this.publishResult({
          instruction_id: instr.instruction_id,
          subagent_id: instr.subagent_id,
          status: "error",
          tokens_used: totalTokens,
          error_message: `iteration ${i}: ${(e as Error).message}`,
          iterations: i - 1,
          iteration_summaries: iterations,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      totalTokens += raw.tokens_used;
      this.tokensUsedTotal += raw.tokens_used;

      const turn = parseTurnOutput(raw.text);
      if (!turn) {
        console.warn(
          `[subagent] cycle malformed: model=${resolved.modelName} finish=${raw.finish_reason} tokens=${raw.tokens_used} text_len=${raw.text.length} head=${JSON.stringify(raw.text.slice(0, 300))}`,
        );
        // Malformed output — commit what we have, or if nothing, error.
        if (lastCode) {
          this.publishResult({
            instruction_id: instr.instruction_id,
            subagent_id: instr.subagent_id,
            status: "success",
            code: lastCode,
            reasoning: lastNotes,
            tokens_used: totalTokens,
            iterations: i - 1,
            iteration_summaries: iterations,
            timestamp: new Date().toISOString(),
          });
          return;
        }
        this.publishResult({
          instruction_id: instr.instruction_id,
          subagent_id: instr.subagent_id,
          status: "error",
          tokens_used: totalTokens,
          error_message: `iteration ${i}: malformed turn output; raw prefix=${raw.text.slice(0, 200)}`,
          iterations: i - 1,
          iteration_summaries: iterations,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      lastCode = turn.code;
      lastNotes = turn.notes;

      if (turn.decision === "DONE" || turn.code.length === 0) {
        this.publishResult({
          instruction_id: instr.instruction_id,
          subagent_id: instr.subagent_id,
          status: "success",
          code: lastCode,
          reasoning: lastNotes,
          tokens_used: totalTokens,
          iterations: i,
          iteration_summaries: iterations,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // RUN: execute in the game, capture result, feed back for next turn.
      // Use a throw-away probe script_id so probe runs don't collide with
      // the orchestrator's committed script submissions.
      const probeId = `probe-${instr.subagent_id}-${i}-${randomUUID().slice(0, 6)}`;
      let exec: ExecutionResult;
      try {
        await this.game.submitScript({ script_id: probeId, code: turn.code });
        exec = await this.game.runScript({
          script_id: probeId,
          subagent_id: instr.subagent_id,
          kind: "probe",
        });
      } catch (e) {
        exec = {
          script_id: probeId,
          subagent_id: instr.subagent_id,
          status: "failed",
          money_gained: 0,
          time_elapsed_seconds: 0,
          error: (e as Error).message,
          stderr: (e as Error).message,
          exit_reason: "harness_error",
          game_state_snapshot: { current_money: 0, bitnode_id: 1, bitnode_complete: false },
          timestamp: new Date().toISOString(),
        };
      }

      iterations.push({
        iteration: i,
        exit_reason: exec.exit_reason,
        money_gained: exec.money_gained,
        stderr: exec.stderr?.slice(0, 500),
        // The turn's own reasoning. `lastNotes` only survives for the
        // final turn (it becomes Result.reasoning), so capture each
        // one here or the thinking behind a multi-iteration
        // instruction is lost.
        notes: turn.notes?.slice(0, 1000),
      });

      transcript.push(formatExecutionFeedback(i, turn, exec));
    }

    // Exhausted iterations without DONE — commit last code.
    this.publishResult({
      instruction_id: instr.instruction_id,
      subagent_id: instr.subagent_id,
      status: "success",
      code: lastCode,
      reasoning: lastNotes ? `${lastNotes} (iteration budget exhausted)` : "iteration budget exhausted",
      tokens_used: totalTokens,
      iterations: this.maxIterations,
      iteration_summaries: iterations,
      timestamp: new Date().toISOString(),
    });
  }

  private async invokeWithTimeout(
    resolved: {
      adapter: import("../types").InferenceAdapter;
      modelName: string;
      supportsSchema: boolean;
    },
    prompt: string,
    maxTokens: number,
  ): Promise<{ text: string; tokens_used: number; finish_reason: "stop" | "length" | "error" }> {
    const controller = new AbortController();
    const timeoutMs = this.limits.timeout_seconds * 1000;
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await resolved.adapter.invoke({
        model: resolved.modelName,
        prompt,
        system: SUBAGENT_SYSTEM_PROMPT,
        max_tokens: maxTokens,
        signal: controller.signal,
        // Only apply the JSON schema when the model is known to handle
        // structured output. Reasoning models (gpt-oss, qwen3*) break
        // under Ollama schema constraints — thinking stream gets
        // starved, response comes back empty.
        responseFormat: resolved.supportsSchema ? TURN_OUTPUT_SCHEMA : undefined,
      });
    } finally {
      clearTimeout(t);
    }
  }

  private publishResult(r: Result): void {
    if (this.stopped) return;
    this.bus.publish("results", r);
  }
}

function buildInitialPrompt(instr: Instruction): string {
  return [
    `# Task`,
    instr.task,
    ``,
    `# Context from your manager`,
    instr.context || "(none provided)",
    ``,
    `# Constraints`,
    `- Maximum script lines: ${instr.constraints.max_script_size_lines}`,
    `- Per-turn token budget: ${instr.constraints.token_budget}`,
    ``,
    `Produce the first version of the code. Respond with the JSON object.`,
  ].join("\n");
}

function formatExecutionFeedback(iteration: number, turn: TurnOutput, exec: ExecutionResult): string {
  const stdoutBlock = exec.stdout ? `\n## stdout (truncated to last 2KB)\n${exec.stdout.slice(-2048)}` : "";
  const stderrBlock = exec.stderr ? `\n## stderr\n${exec.stderr}` : "";
  const statsBlock = exec.script_stats ? `\n## stats\n${JSON.stringify(exec.script_stats)}` : "";
  return [
    `# Iteration ${iteration} result`,
    `status=${exec.status} exit_reason=${exec.exit_reason ?? "?"} money_gained=${exec.money_gained} elapsed_s=${exec.time_elapsed_seconds}`,
    stdoutBlock,
    stderrBlock,
    statsBlock,
    ``,
    `Iterate on your code, or commit it with decision=DONE. Respond with the JSON object.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function parseTurnOutput(text: string): TurnOutput | null {
  // Accept bare JSON or ```json``` fenced; find first balanced object.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const obj = extractFirstJsonObject(candidate.trim());
  if (!obj) return null;
  try {
    const parsed = JSON.parse(obj);
    if (!parsed || typeof parsed !== "object") return null;
    const decision = parsed.decision === "DONE" ? "DONE" : "RUN";
    const code = typeof parsed.code === "string" ? parsed.code : "";
    const notes = typeof parsed.notes === "string" ? parsed.notes : undefined;
    return { decision, code, notes };
  } catch {
    return null;
  }
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i += 1) {
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
