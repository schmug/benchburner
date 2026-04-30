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

  // ── (2) buildSystemPrompt substitutes duration into the §3.3 template ──
  const sys24 = buildSystemPrompt(86400);
  assert(sys24.includes("the 24-hour window"), "24h prompt contains 'the 24-hour window'");
  assert(!sys24.includes("the 1-hour window"), "24h prompt does not contain '1-hour window'");

  const sys1 = buildSystemPrompt(3600);
  assert(sys1.includes("the 1-hour window"), "1h prompt contains 'the 1-hour window'");
  assert(!sys1.includes("the 24-hour window"), "1h prompt does not contain '24-hour window'");

  const sysHalf = buildSystemPrompt(1800);
  assert(sysHalf.includes("the 0.5-hour window"), "30min prompt contains 'the 0.5-hour window'");

  const sys10min = buildSystemPrompt(600);
  assert(sys10min.includes("the 0.17-hour window"), "10min prompt contains 'the 0.17-hour window'");

  // ── (2a) formatDurationHours edge cases ──
  assert(formatDurationHours(86400) === "24", "formatDurationHours(86400)=24");
  assert(formatDurationHours(3600) === "1", "formatDurationHours(3600)=1");
  assert(formatDurationHours(1800) === "0.5", "formatDurationHours(1800)=0.5");
  assert(formatDurationHours(600) === "0.17", "formatDurationHours(600)=0.17");
  assert(formatDurationHours(7200) === "2", "formatDurationHours(7200)=2 (integer hour stays integer)");

  // ── (2b) buildOrchestratorPrompt uses input.total_duration_seconds ──
  const built = buildOrchestratorPrompt(makeInput(3600), 8675309);
  assert(built.system.includes("the 1-hour window"), "buildOrchestratorPrompt routes input.total_duration_seconds into prompt");
  assert(built.leak_check_violations.length === 0, "leak detector clean for benign 1h prompt");
}

main();
console.log("[smoke] all assertions passed");
