/**
 * SubagentWorker — consumes `instructions` from the bus, calls the
 * configured inference adapter for the target subagent's model,
 * publishes a `Result` back on the bus. Enforces the per-run token
 * budget and timeout. No retries; failures surface as result.status=error.
 *
 * Concurrency is capped by a semaphore (default 5). When all slots are
 * busy, new instructions queue in arrival order.
 */

import type { Bus } from "../bus/bus";
import type { Instruction, Result, RunConfig } from "../types";
import type { InferenceRegistry } from "../inference/registry";
import type { SubagentPool } from "./pool";

const SUBAGENT_SYSTEM_PROMPT = `You are a subagent on a software team. Your manager has given you a single, concrete task. You must output exactly one code block in Netscript (a JavaScript dialect) that accomplishes the task, followed by nothing else.

Rules:
- Output ONLY the code. No prose, no explanation, no markdown fences.
- The code must be valid Netscript and runnable as-is.
- Respect the line budget your manager specifies. If you can't fit, simplify; do not truncate mid-statement.
- You have no memory of previous instructions. Treat each task as standalone.`;

function buildSubagentPrompt(instr: Instruction): string {
  return [
    `# Task`,
    instr.task,
    ``,
    `# Context from your manager`,
    instr.context || "(none provided)",
    ``,
    `# Constraints`,
    `- Maximum lines: ${instr.constraints.max_script_size_lines}`,
    `- Token budget: ${instr.constraints.token_budget}`,
    ``,
    `Output the code now.`,
  ].join("\n");
}

function stripCodeFences(text: string): string {
  const fencePattern = /```(?:[a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/;
  const m = text.match(fencePattern);
  if (m) return m[1].trim();
  return text.trim();
}

export interface WorkerOptions {
  bus: Bus;
  registry: InferenceRegistry;
  pool: SubagentPool;
  limits: RunConfig["subagent_limits"];
}

export class SubagentWorker {
  private readonly bus: Bus;
  private readonly registry: InferenceRegistry;
  private readonly pool: SubagentPool;
  private readonly limits: RunConfig["subagent_limits"];
  private readonly inFlight = new Set<Promise<void>>();
  private queue: Instruction[] = [];
  private stopped = false;
  private unsubscribe?: () => void;

  constructor(opts: WorkerOptions) {
    this.bus = opts.bus;
    this.registry = opts.registry;
    this.pool = opts.pool;
    this.limits = opts.limits;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe("instructions", (instr) => {
      if (this.stopped) return;
      this.queue.push(instr);
      this.pump();
    });
  }

  /**
   * Stop accepting new instructions and wait for all in-flight work to
   * complete (or its own timeout to expire).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.queue = []; // drop anything still waiting
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

    let resolved: { adapter: import("../types").InferenceAdapter; modelName: string };
    try {
      const r = this.registry.get(model);
      resolved = { adapter: r.adapter, modelName: r.modelName };
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

    const controller = new AbortController();
    const timeoutMs = this.limits.timeout_seconds * 1000;
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    const startedAt = Date.now();
    try {
      const raw = await resolved.adapter.invoke({
        model: resolved.modelName,
        prompt: buildSubagentPrompt(instr),
        system: SUBAGENT_SYSTEM_PROMPT,
        max_tokens: instr.constraints.token_budget,
        signal: controller.signal,
      });
      clearTimeout(timeoutHandle);

      const code = stripCodeFences(raw.text);
      const status: Result["status"] = raw.finish_reason === "error" ? "error" : "success";

      this.publishResult({
        instruction_id: instr.instruction_id,
        subagent_id: instr.subagent_id,
        status,
        code: status === "success" ? code : undefined,
        reasoning: undefined,
        tokens_used: raw.tokens_used,
        error_message: status === "error" ? `finish_reason=error; raw=${raw.text.slice(0, 200)}` : undefined,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      clearTimeout(timeoutHandle);
      const aborted = controller.signal.aborted;
      const elapsedMs = Date.now() - startedAt;
      const status: Result["status"] = aborted && elapsedMs >= timeoutMs - 50 ? "timeout" : "error";
      this.publishResult({
        instruction_id: instr.instruction_id,
        subagent_id: instr.subagent_id,
        status,
        tokens_used: 0,
        error_message: (e as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private publishResult(r: Result): void {
    if (this.stopped) return;
    this.bus.publish("results", r);
  }
}
