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
 * Produce a safe-to-log view of the input. Currently a pass-through —
 * the input shape (SPEC §3.1) already contains no seed or identifying
 * fields, but we keep this hook so future additions have one place to
 * redact.
 */
function scrubInput(input: OrchestratorInput): OrchestratorInput {
  // Defensive copy: remove anything whose key name itself leaks.
  // (None today, but the hook is useful.)
  return input;
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
