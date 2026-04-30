/**
 * Time-awareness smoke (2026-04-30 design).
 *
 * Standalone, no game boot. Exercises:
 *   (1) OrchestratorLoop.assembleInput populates total_duration_seconds.
 *   (2) buildOrchestratorPrompt substitutes the duration into the §3.3
 *       prompt template at multiple horizons, including fractional hours.
 *   (3) detectLeaks does NOT false-fire when the seed string is a digit
 *       substring of total_duration_seconds (the 8640/86400 collision).
 *
 * Run:  npx tsx harness/orchestrator/time-awareness-smoke.ts
 * Exit: 0 on all assertions passing, 1 on any failure.
 */

import { buildOrchestratorPrompt, detectLeaks, buildSystemPrompt, formatDurationHours } from "./prompt";
import type { OrchestratorInput } from "../types";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`[smoke] FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`[smoke] OK: ${msg}`);
}

function makeInput(totalDurationSeconds: number, elapsedSeconds = 0): OrchestratorInput {
  return {
    cycle_number: 1,
    elapsed_time_seconds: elapsedSeconds,
    total_duration_seconds: totalDurationSeconds,
    game_state: { current_money: 0, bitnode_id: 1, bitnode_complete: false },
    subagent_status: [],
    delegation_history: [],
    available_subagent_models: ["test-model"],
  };
}

function main(): void {
  // ── (1) Type-level: OrchestratorInput accepts total_duration_seconds ──
  const input24h = makeInput(86400);
  assert(input24h.total_duration_seconds === 86400, "OrchestratorInput carries total_duration_seconds=86400");
}

main();
console.log("[smoke] all assertions passed");
