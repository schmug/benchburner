/**
 * Orchestrator prompt construction + leak policy.
 *
 * SPEC §3.3 fixes the system prompt across all benchmarked models.
 * This module enforces the leak policy: the seed, the game identity
 * "Bitburner", and scoring-rubric details beyond "maximize money"
 * must never reach the model. A post-run audit log confirms this.
 */

import type { OrchestratorInput } from "../types";

export const ORCHESTRATOR_SYSTEM_PROMPT = `You are the orchestrator of a team of subagent coders. You cannot play the game yourself. You cannot edit the code your subagents write. Your job is to decide which subagents to spawn, which to kill, and what instructions to give them. Your team is playing a game. Your goal is to maximize the team's in-game money in the 24-hour window.

You can only observe what your subagents report back, plus periodic game state snapshots from the backend. You have no other visibility.

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

/**
 * Tokens that must never appear in the prompt sent to the orchestrator.
 * Case-insensitive substring check on the full rendered prompt.
 */
export const FORBIDDEN_TOKENS: readonly string[] = Object.freeze([
  "bitburner",
  "seed",
  "netscript", // the scripting language name is distinctive; treat as leak
  "bitnode",   // Bitburner-specific world-level concept
  "augment",   // Bitburner-specific persistent-upgrade concept
  "hacknet",   // Bitburner-specific
]);

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

  const full = ORCHESTRATOR_SYSTEM_PROMPT + "\n" + user;
  const violations = detectLeaks(full, seed);

  return {
    system: ORCHESTRATOR_SYSTEM_PROMPT,
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
function scrubInput(input: OrchestratorInput): OrchestratorInput {
  const gs = input.game_state;
  const cleanedHistory = input.delegation_history.map((pair) => ({
    instruction: {
      ...pair.instruction,
      task: scrubText(pair.instruction.task),
      context: scrubText(pair.instruction.context),
    },
    result: pair.result,
  }));
  return {
    ...input,
    game_state: {
      current_money: gs.current_money,
      level_id: gs.bitnode_id,
      level_complete: gs.bitnode_complete,
      upgrades_installed: gs.augments_installed ?? [],
    } as unknown as OrchestratorInput["game_state"],
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
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const tok of FORBIDDEN_TOKENS) {
    if (lower.includes(tok)) hits.push(tok);
  }
  const seedStr = String(seed);
  if (seedStr.length >= 3 && text.includes(seedStr)) {
    hits.push(`seed:${seedStr}`);
  }
  return hits;
}

export const __testing = { scrubInput };
