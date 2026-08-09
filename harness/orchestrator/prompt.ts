/**
 * Orchestrator prompt construction + leak policy.
 *
 * SPEC §3.3 fixes the system prompt across all benchmarked models.
 * This module enforces the leak policy: the seed, the game identity
 * "Bitburner", and scoring-rubric details beyond "maximize money"
 * must never reach the model. A post-run audit log confirms this.
 */

import { BASIC_DOCS, loadDocs } from "../game/docs";
import type { OrchestratorInput } from "../types";

/**
 * Builds the §3.3 system prompt. The only run-dependent substitution
 * is the duration in `the {N}-hour window` near the top — every other
 * word is fixed across all benchmarked models for fairness (see
 * SPEC §3.3).
 */
export function buildSystemPrompt(totalDurationSeconds: number): string {
  const horizon = formatDurationHours(totalDurationSeconds);
  return `You are the orchestrator of a team of subagent coders. You cannot play the game yourself. You cannot edit the code your subagents write. Your job is to decide which subagents to spawn, which to kill, and what instructions to give them. Your team is playing a game. Your goal is to maximize the team's in-game money in the ${horizon}-hour window.

Runtime environment (infrastructure, not strategy): your team's code executes in a sandboxed JavaScript runtime on a host with ~8 GB of memory, of which the harness itself is using about 4.9 GB for its process bookkeeping — leaving approximately 3 GB for the scripts your subagents write. Every ns.* API call has a static RAM cost that counts against that 3 GB at compile time; if a script's declared calls exceed the budget, the runtime refuses to start it and you'll see "ns.run returned 0 — script missing or RAM budget exceeded" in the execution result. Cheap calls include ns.hack, ns.weaken, ns.grow (~0.1-0.2 GB each) and the individual ns.getServerX getters. Expensive calls like ns.getServer (2 GB) and ns.hackAnalyzeChance (1 GB) eat the budget fast. Instruct your team accordingly.

Scripts take the form "export async function main(ns) { ... }" where ns is the API object the environment provides. When you instruct your subagents, tell them what you want the code to DO; do not tell them which language to use — they already know it must be JavaScript targeting this ns-based runtime.

Committed-script lifecycle: each subagent maintains exactly one committed script at a time. When a subagent returns a new final code, that code runs indefinitely (until run-end) and any previous committed script from the same subagent is automatically killed. Short-lived diagnostic scripts that exit quickly are fine; long-running earning scripts stay alive and accumulate money into game_state. So you can use one subagent as a long-running worker and simply replace its script when you want new behavior.

You can only observe what your subagents report back, plus periodic game state snapshots from the backend. You have no other visibility. Execution feedback includes stdout / stderr / exit_reason / money_gained — use them to route around broken subagent output.

Reference — the environment's own documentation. This is mechanics, not strategy; deciding what to do with it is your job.

${BASICS_TEXT}

Respond ONLY with a JSON object matching this schema:
{
  "actions": [
    {
      "action_type": "spawn" | "kill" | "instruct" | "noop",
      "subagent_id": "string (required for kill/instruct; you choose a new id for spawn)",
      "model_choice": "string (required for spawn; must be from available_subagent_models)",
      "instruction": {
        "task": "string",
        "context": "string",
        "constraints": { "token_budget": number, "max_script_size_lines": number }
      }
    }
  ],
  "reasoning": "string (free-form)"
}

No prose outside the JSON.`;
}

/**
 * Tokens that must never appear in the prompt sent to the orchestrator.
 * Case-insensitive substring check on the full rendered prompt.
 */
/**
 * Tokens that must never appear in the orchestrator's rendered prompt.
 * Scope is narrow by design — SPEC §3.3:
 *   "Intent is not to hide it in code, just not to name it in the prompt."
 * So we drop "netscript" (it will legitimately appear in subagent-written
 * code, which the orchestrator should see as a tech lead would). We keep
 * the game-name tokens so the orchestrator can't use Bitburner-specific
 * wiki knowledge from its model priors.
 */
export const FORBIDDEN_TOKENS: readonly string[] = Object.freeze([
  "bitburner",
  "bitnode",
  "hacknet",
  "augment",
  "seed",
]);

/**
 * The game's Basic Mechanics text, scrubbed of forbidden tokens and
 * read once per process rather than per prompt build — it's identical
 * across every cycle and every model, so re-reading it from disk on
 * each call would just be wasted I/O on a string that never changes.
 *
 * Declared after FORBIDDEN_TOKENS and scrubText (hoisted, but the
 * const it closes over is not) so this line doesn't run into the
 * temporal dead zone at module-evaluation time.
 */
const BASICS_TEXT = scrubText(loadDocs(BASIC_DOCS));

export interface BuildPromptResult {
  system: string;
  user: string;
  /** For audit logging; non-fatal if empty. */
  leak_check_violations: string[];
}

/**
 * Renders the orchestrator's turn into a (system, user) pair. Scrubs
 * the input JSON of fields that could leak identity/seed, then
 * serializes what remains.
 */
export function buildOrchestratorPrompt(input: OrchestratorInput, seed: number): BuildPromptResult {
  const scrubbed = scrubInput(input);
  const user = JSON.stringify(scrubbed, null, 2);
  const system = buildSystemPrompt(input.total_duration_seconds);

  const full = system + "\n" + user;
  const violations = detectLeaks(full, seed);

  return {
    system,
    user,
    leak_check_violations: violations,
  };
}

/**
 * Produce a safe-to-log view of the input. Renames game-identity
 * fields (SPEC §3.1 uses "bitnode"/"augments" names which leak) to
 * neutral terms the orchestrator can reason over without learning
 * the title of the game.
 *
 * Mapping:
 *   bitnode_id         → level_id
 *   bitnode_complete   → level_complete
 *   augments_installed → upgrades_installed
 *
 * Inside `delegation_history`, the subagent-produced code is
 * passed through as-is (it'll contain Netscript identifiers; the
 * orchestrator seeing those is unavoidable if it's to reason over
 * its team's work, and the spec explicitly notes total leak-proofing
 * of Netscript is "likely impossible").
 */
function scrubResult<T extends { code?: string; reasoning?: string; error_message?: string; iteration_summaries?: Array<{ stderr?: string; notes?: string; [k: string]: unknown }> }>(r: T | null | undefined): T | null {
  if (!r) return null as T | null;
  return {
    ...r,
    code: r.code ? scrubText(r.code) : r.code,
    reasoning: r.reasoning ? scrubText(r.reasoning) : r.reasoning,
    error_message: r.error_message ? scrubText(r.error_message) : r.error_message,
    iteration_summaries: r.iteration_summaries?.map((s) => ({
      ...s,
      stderr: s.stderr ? scrubText(s.stderr) : s.stderr,
      // Subagent-authored reasoning for that turn; free text like any
      // other, and it names game APIs routinely.
      notes: s.notes ? scrubText(s.notes) : s.notes,
    })),
  };
}

/**
 * Scrubs the free-text fields of a committed script's outcome. This is
 * game-authored output — runtime errors and stack traces name game APIs
 * as a matter of course — so it goes through the same filter as
 * subagent output before the orchestrator sees it.
 */
function scrubExecution<T extends { error?: string; stdout?: string; stderr?: string }>(
  e: T | null | undefined,
): T | null {
  if (!e) return null as T | null;
  return {
    ...e,
    error: e.error ? scrubText(e.error) : e.error,
    stdout: e.stdout ? scrubText(e.stdout) : e.stdout,
    stderr: e.stderr ? scrubText(e.stderr) : e.stderr,
  };
}

function scrubInput(input: OrchestratorInput): OrchestratorInput {
  const gs = input.game_state;
  const cleanedSubagentStatus = input.subagent_status.map((s) => ({
    ...s,
    // Same scrub as delegation_history so we don't echo unscrubbed
    // code/reasoning/stderr through this second window into the past.
    last_result: scrubResult(s.last_result) as typeof s.last_result,
    // NOTE: this object is built with a spread, so any field added to
    // SubagentStatus reaches the model unscrubbed unless handled here.
    // Execution output is game-authored text — stack traces and runtime
    // errors routinely name game APIs — and a forbidden token in the
    // prompt fails the run closed.
    last_execution: scrubExecution(s.last_execution),
  }));
  const cleanedHistory = input.delegation_history.map((pair) => ({
    instruction: {
      ...pair.instruction,
      task: scrubText(pair.instruction.task),
      context: scrubText(pair.instruction.context),
    },
    // Keep result.code so the orchestrator can read its team's output
    // the way a real tech lead would. Per SPEC §3.3 the intent is not
    // to hide game-adjacent language in code; only to avoid *naming*
    // the game in the prompt. Scrub forbidden *name* tokens (including
    // from subagent-authored comments / string literals) while keeping
    // the code's structure and API calls intact — redacting "Bitburner"
    // in a JSDoc line is much less information loss than hiding the
    // whole function.
    result: scrubResult(pair.result),
  }));
  return {
    ...input,
    game_state: {
      current_money: gs.current_money,
      level_id: gs.bitnode_id,
      level_complete: gs.bitnode_complete,
      upgrades_installed: gs.augments_installed ?? [],
    } as unknown as OrchestratorInput["game_state"],
    subagent_status: cleanedSubagentStatus,
    delegation_history: cleanedHistory,
  };
}

/**
 * Strip forbidden tokens from free-form strings that the orchestrator
 * itself produced in earlier cycles, before echoing them back. Keeps
 * the orchestrator's vocabulary from gradually drifting onto
 * game-identity terms.
 */
function scrubText(text: string): string {
  let out = text;
  for (const tok of FORBIDDEN_TOKENS) {
    const re = new RegExp(`\\b${tok}\\b`, "gi");
    out = out.replace(re, "[redacted]");
  }
  return out;
}

export function detectLeaks(text: string, seed: number): string[] {
  const hits: string[] = [];
  // Match what scrubText does: word-boundary, case-insensitive. That
  // way "getAugmentations" (a legitimate NS API name the spec permits
  // in code) doesn't trip the detector on the substring "augment",
  // while a bare "augment" in prose still does. Without this symmetry
  // the scrubber would leave code untouched but the detector would
  // fire on the same content, failing runs where the subagent
  // legitimately probes the ns namespace surface.
  for (const tok of FORBIDDEN_TOKENS) {
    const re = new RegExp(`\\b${tok}\\b`, "i");
    if (re.test(text)) hits.push(tok);
  }
  const seedStr = String(seed);
  if (seedStr.length >= 3) {
    // Word-boundary match mirrors the forbidden-token loop above:
    // a seed embedded as a digit-substring of an unrelated number
    // (e.g. 8640 inside total_duration_seconds=86400) is not a real
    // leak. Without this, the new total_duration_seconds field would
    // false-trigger the detector for entire classes of seed values
    // and fail runs at SPEC §3.3 leak audit.
    const re = new RegExp(`\\b${seedStr}\\b`);
    if (re.test(text)) hits.push(`seed:${seedStr}`);
  }
  return hits;
}

export const __testing = { scrubInput };

export function formatDurationHours(seconds: number): string {
  const hours = seconds / 3600;
  if (Number.isInteger(hours)) return String(hours);
  return hours.toFixed(2).replace(/\.?0+$/, "");
}
