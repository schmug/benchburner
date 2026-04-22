/**
 * SubagentPool — the live registry of subagents the orchestrator has
 * spawned. The Worker consults the pool to know which model to use for
 * a given `subagent_id`, and the orchestrator loop mutates the pool in
 * response to `spawn`/`kill` actions.
 *
 * The pool is intentionally dumb: it does no inference and has no
 * queue. It's a map plus audit hooks.
 */

export interface PooledSubagent {
  subagent_id: string;
  model: string;
  spawned_at: string; // ISO-8601
}

export class SubagentPool {
  private readonly subagents = new Map<string, PooledSubagent>();

  spawn(subagent_id: string, model: string, timestamp: string): void {
    if (this.subagents.has(subagent_id)) {
      throw new Error(`subagent_id already exists: ${subagent_id}`);
    }
    this.subagents.set(subagent_id, { subagent_id, model, spawned_at: timestamp });
  }

  kill(subagent_id: string): void {
    this.subagents.delete(subagent_id);
  }

  modelFor(subagent_id: string): string | undefined {
    return this.subagents.get(subagent_id)?.model;
  }

  has(subagent_id: string): boolean {
    return this.subagents.has(subagent_id);
  }

  list(): PooledSubagent[] {
    return [...this.subagents.values()];
  }

  size(): number {
    return this.subagents.size;
  }
}
