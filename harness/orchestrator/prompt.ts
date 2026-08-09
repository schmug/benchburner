/**
 * Orchestrator prompt construction + leak policy.
 *
 * SPEC §3.3 fixes the system prompt across all benchmarked models.
 *
 * The leak policy used to have two halves: hide the RNG seed, and hide
 * the game's identity. Only the seed half remains.
 *
 * The identity half was retired deliberately, not by neglect. This
 * prompt vendors the game's own Basic Mechanics docs (see
 * `basicsText()`), and those docs name the early-game target ladder and
 * the port-opener programs outright. The scrub redacted the *title*
 * while the same prompt handed over the target list — and naming those
 * targets activates a model's memorised-strategy priors considerably
 * harder than the word "Bitburner" ever did. Redacting the one word
 * that carried no strategy, in text that carried plenty, was incoherent.
 * So the token scrub went rather than being widened to swallow the
 * manual it was supposed to deliver.
 *
 * The seed half is untouched and stays that way. A known seed lets a
 * model overfit one scenario instead of orchestrating, so `detectLeaks`
 * still matches String(seed) against the rendered prompt and
 * `OrchestratorLoop` still fails the run closed on a hit.
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
  return `You are the orchestrator of a team of subagent coders. You cannot play the game yourself. You cannot edit the code your subagents write. Your job is to decide which subagents to spawn, which to kill, and what instructions to give them. Your team is playing Bitburner. Your goal is to maximize the team's in-game money in the ${horizon}-hour window.

Runtime environment (infrastructure, not strategy): your team's code executes in a sandboxed JavaScript runtime on a host with ~8 GB of memory, of which the harness itself is using about 3.8 GB for its process bookkeeping — leaving approximately 4.2 GB for the scripts your subagents write. Every ns.* API call has a static RAM cost that counts against that 4.2 GB at compile time; if a script's declared calls exceed the budget, the runtime refuses to start it and you'll see "ns.run returned 0 — script missing or RAM budget exceeded" in the execution result. Cheap calls include ns.hack, ns.weaken, ns.grow (~0.1-0.2 GB each) and the individual ns.getServerX getters. Expensive calls like ns.getServer (2 GB) and ns.hackAnalyzeChance (1 GB) eat the budget fast. For scale: a script using ns.exec costs 2.9 GB in total, ns.scp plus ns.exec 3.5 GB, and ns.purchaseServer 3.85 GB — all of which now fit in the 4.2 GB budget, though each leaves little room for anything else in the same script. Instruct your team accordingly.

Scripts take the form "export async function main(ns) { ... }" where ns is the API object the environment provides. When you instruct your subagents, tell them what you want the code to DO; do not tell them which language to use — they already know it must be JavaScript targeting this ns-based runtime.

Committed-script lifecycle: when a subagent returns final code, it is committed and runs until the run ends. By default it runs ALONGSIDE that subagent's existing committed script — it does NOT replace it. Set "replace": true on an instruct action to retire the old one, which happens only once the new script is confirmed running. All committed scripts share one memory budget, so scripts accumulate until the budget is exhausted, at which point new ones report failed_to_start in last_execution. Killing a subagent also stops its committed script. Short-lived diagnostic scripts that exit quickly are fine; long-running earning scripts stay alive and accumulate money into game_state.

Per-subagent earnings: each entry in subagent_status carries live_script — whether that subagent has any committed script still running, how many, how much those scripts have earned between them, how much of the shared memory budget they hold, and how long the oldest has been up. It is null when the subagent has nothing running. The earnings figure is that subagent's own scripts, not the team total. last_execution tells you whether an instruction produced a script that STARTED; live_script tells you whether it is still EARNING. A live_script whose money_made stays flat between cycles is running and producing nothing.

You can only observe what your subagents report back, plus periodic game state snapshots from the backend. You have no other visibility. Execution feedback includes stdout / stderr / exit_reason / money_gained — use them to route around broken subagent output.

Reference — Bitburner's own Basic Mechanics documentation, verbatim. This is mechanics, not strategy; deciding what to do with it is your job.

${basicsText()}

Respond ONLY with a JSON object matching this schema:
{
  "actions": [
    {
      "action_type": "spawn" | "kill" | "instruct" | "noop",
      "subagent_id": "string (required for kill/instruct; you choose a new id for spawn)",
      "model_choice": "string (required for spawn; must be from available_subagent_models)",
      "replace": "boolean (optional, instruct only; default false)",
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
 * Empty: the game-identity scrub is retired (see the module header).
 *
 * The list survives as an empty export only because
 * `harness/orchestrator/index.ts` re-exports the name. Deleting the
 * export is the right end state and should follow as its own change —
 * it is an API break, and this commit is scoped to the policy decision.
 *
 * Do NOT repopulate this to "just filter one more word". The seed is
 * the only thing withheld from the orchestrator now, and it is withheld
 * by `detectLeaks`' numeric check, not by this list.
 */
export const FORBIDDEN_TOKENS: readonly string[] = Object.freeze([]);

let basicsTextCache: string | null = null;

/**
 * The game's Basic Mechanics text, verbatim.
 *
 * No longer scrubbed. The scrub used to punch `[redacted]` holes
 * through the game's own prose ("In [redacted], RAM determines...")
 * while leaving the target ladder and port-opener names it lists fully
 * intact — degrading the manual without concealing its subject.
 *
 * Read lazily on first use and memoized — deliberately NOT at module
 * evaluation time. Importing this module has to stay free of disk I/O.
 * A top-level read made merely *importing* prompt.ts throw ENOENT when
 * the doc tree was absent, and that took down every unrelated importer
 * with it — cycle-record and execution-feedback tests, and the
 * time-awareness smoke, none of which touch docs.
 *
 * The basics are vendored now (harness/game/docs/), so the absent-tree
 * case is much less likely than when they came from the submodule. Keep
 * the laziness regardless: an import that can fail on I/O is a footgun
 * for every future importer, whatever the odds of the file missing.
 *
 * Memoizing keeps the original property that made this a const: the
 * text is identical across every cycle and every model, so the process
 * still reads it from disk exactly once.
 */
function basicsText(): string {
  if (basicsTextCache === null) {
    basicsTextCache = loadDocs(BASIC_DOCS);
  }
  return basicsTextCache;
}

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
 * Produce the view of the input that the orchestrator is allowed to see.
 *
 * `scrubText` / `scrubResult` / `scrubExecution` were deleted rather
 * than left as no-ops. With an empty token list they were pure identity
 * functions that deep-copied `delegation_history` and `subagent_status`
 * every cycle to change nothing — but the real cost was not the copy.
 * A retained function named `scrubText`, called from the one place that
 * still enforces a genuine guarantee, reads as if it enforces one too;
 * the next person to touch this file would trust a filter that filters
 * nothing. A dead hook is recoverable with one `git show`; a false
 * guarantee sitting next to the seed check is not worth keeping around
 * for that convenience.
 *
 * What DOES survive here, and is not part of the identity decision:
 *
 * 1. `game_state` is projected onto an explicit key list rather than
 *    spread. This is load-bearing for reasons beyond leak policy — it
 *    is the contract for what the snapshot channel exposes — so a field
 *    added to GameState stays invisible until someone adds it here on
 *    purpose. Do not replace it with a spread.
 * 2. The field renames (bitnode_id → level_id, bitnode_complete →
 *    level_complete, augments_installed → upgrades_installed). These are
 *    now just the projection's output names. They no longer conceal
 *    anything — the system prompt names the game and the vendored docs
 *    use "BitNode" and "Augmentations" freely — but renaming them back
 *    would change the key names every historical run artifact was
 *    written with, for no benefit. Left alone deliberately.
 * 3. `last_execution` and `live_script` are normalised undefined → null,
 *    which is what `scrubExecution` incidentally did for the former.
 *    Kept so the JSON handed to the model is byte-identical to before
 *    this change; dropping it would silently remove the key from the
 *    prompt for subagents that have not run a script yet, making "no
 *    script" indistinguishable from "field not implemented".
 *
 * NOTE for whoever adds the next `SubagentStatus` field: this is a
 * SPREAD. Anything with free text reaches the model exactly as authored.
 * `LiveScript` is numeric and boolean throughout and so needs no
 * handling today — but the moment it (or any sibling field) gains a
 * string, it has to be dealt with here on purpose.
 *
 * `delegation_history` and `subagent_status` now pass through as
 * authored. Subagent code, reasoning, stderr and the game's own runtime
 * errors reach the orchestrator verbatim — which is what a tech lead
 * reading their team's output would see, and was already the intent for
 * `result.code` before the rest of the scrub went.
 */
function scrubInput(input: OrchestratorInput): OrchestratorInput {
  const gs = input.game_state;
  return {
    ...input,
    game_state: {
      current_money: gs.current_money,
      level_id: gs.bitnode_id,
      level_complete: gs.bitnode_complete,
      upgrades_installed: gs.augments_installed ?? [],
    } as unknown as OrchestratorInput["game_state"],
    subagent_status: input.subagent_status.map((s) => ({
      ...s,
      last_execution: s.last_execution ?? null,
      live_script: s.live_script ?? null,
    })),
  };
}

/**
 * The run's leak audit. One check remains: the RNG seed.
 *
 * CLAUDE.md constraint 6 keeps the seed opaque to the orchestrator so a
 * model develops orchestration strategy instead of overfitting a single
 * scenario. `OrchestratorLoop` fails the run closed on any hit, so both
 * guards below matter as much as the check itself — a false positive
 * kills an honest run.
 */
export function detectLeaks(text: string, seed: number): string[] {
  const hits: string[] = [];
  const seedStr = String(seed);
  // Guard 1 — seeds under 3 digits are exempt. A 1–2 digit seed
  // collides with ordinary numbers in the input JSON (money, cycle
  // counts, thread counts) far too often to be checkable this way.
  if (seedStr.length >= 3) {
    // Guard 2 — word boundary. A seed embedded as a digit-substring of
    // an unrelated number (e.g. 8640 inside
    // total_duration_seconds=86400) is not a real leak. Without this,
    // total_duration_seconds false-triggers the detector for entire
    // classes of seed values and fails honest runs at the §3.3 audit.
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
