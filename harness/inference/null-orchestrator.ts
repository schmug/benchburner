/**
 * Null-orchestrator adapter. Every invoke() returns the SPEC §3.2
 * single-action noop response with empty reasoning. Used by
 * VALIDATION.md PBS1 to establish the "no-orchestration" floor of
 * the scoring surface. An orchestrator wired to this adapter never
 * spawns, kills, or instructs any subagents — so final_money should
 * equal the starting money (Bitburner's fresh-player value 1262).
 */

import type { InferenceAdapter, InferenceInvokeParams, InferenceResult } from "../types";

export class NullOrchestratorAdapter implements InferenceAdapter {
  readonly name = "null-orchestrator";
  private readonly text = JSON.stringify({
    actions: [{ action_type: "noop" }],
    reasoning: "",
  });

  async invoke(_params: InferenceInvokeParams): Promise<InferenceResult> {
    return { text: this.text, tokens_used: 0, finish_reason: "stop" };
  }
}
