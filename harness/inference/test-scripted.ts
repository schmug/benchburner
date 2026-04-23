/**
 * Test-only adapter. Returns a canned sequence of pre-authored responses,
 * one per invoke() call. Used by VALIDATION.md PAS3 to exercise the
 * subagent agentic loop with deterministic turn decisions. If the
 * sequence runs out, subsequent calls throw.
 *
 * Not a production adapter. Register only for validation runs.
 */

import type { InferenceAdapter, InferenceInvokeParams, InferenceResult } from "../types";

export class TestScriptedAdapter implements InferenceAdapter {
  readonly name = "test-scripted";

  /**
   * The scripted sequence. By default targets the subagent's turn
   * envelope: RUN twice, then DONE. Each "code" is tagged so we can
   * distinguish iterations in the committed result.
   *
   * Scripts are trivial ns.print-only scripts so the probe executions
   * complete quickly and deterministically.
   */
  private readonly responses = [
    JSON.stringify({
      decision: "RUN",
      code: "/** @param {NS} ns */\nexport async function main(ns) { ns.print('probe-1'); }",
      notes: "first probe",
    }),
    JSON.stringify({
      decision: "RUN",
      code: "/** @param {NS} ns */\nexport async function main(ns) { ns.print('probe-2'); }",
      notes: "second probe",
    }),
    JSON.stringify({
      decision: "DONE",
      code: "/** @param {NS} ns */\nexport async function main(ns) { ns.print('final'); }",
      notes: "committed",
    }),
  ];
  private cursor = 0;

  async invoke(_params: InferenceInvokeParams): Promise<InferenceResult> {
    if (this.cursor >= this.responses.length) {
      throw new Error(
        `TestScriptedAdapter: exhausted (cursor=${this.cursor}, responses=${this.responses.length})`,
      );
    }
    const text = this.responses[this.cursor];
    this.cursor += 1;
    return {
      text,
      tokens_used: 100,
      finish_reason: "stop",
    };
  }
}
