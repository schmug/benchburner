/**
 * The game's own documentation, used two ways.
 *
 * BASIC_DOCS go verbatim into the orchestrator's system prompt: pure
 * mechanics, identical for every model, and stable so they cache. Using
 * the game's text rather than a briefing we author removes both the
 * authoring bias and the fairness gap between models that absorbed more
 * wiki content than others.
 *
 * LIBRARY_DOCS are pushed in-world instead. They include the tutorial
 * and the optimal-batching guide — strategy, not mechanics — so reading
 * them costs a subagent round trip that could have been spent earning.
 * That makes "send someone to read the manual?" an orchestration
 * decision rather than a freebie.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC_ROOT = path.resolve(
  HERE, "..", "..", "bitburner", "src", "src", "Documentation", "doc", "en",
);

// Widened to `readonly string[]` explicitly (rather than left as the
// `as const` literal-tuple type) so callers can check membership of an
// arbitrary doc name — e.g. `LIBRARY_DOCS.includes(someName)` — without
// TypeScript narrowing the argument to the five-element literal union
// and rejecting every string that isn't already in the list.

/** Mechanics only. ~2,682 words. */
export const BASIC_DOCS: readonly string[] = [
  "basic/ram.md",
  "basic/servers.md",
  "basic/hacking.md",
  "basic/scripts.md",
  "basic/programs.md",
] as const;

/** Pushed in-world; must be fetched by a subagent. */
export const LIBRARY_DOCS: readonly string[] = [
  "help/getting_started.md",
  "programming/hackingalgorithms.md",
  "basic/stats.md",
  "basic/terminal.md",
  "basic/world.md",
] as const;

/** Concatenates docs with a heading per file. Throws if one is missing. */
export function loadDocs(names: readonly string[]): string {
  return names
    .map((name) => {
      const body = readFileSync(path.join(DOC_ROOT, name), "utf8").trim();
      return `--- ${name} ---\n${body}`;
    })
    .join("\n\n");
}

/** In-world filename for a doc. Bitburner allows only .txt/.json/.css. */
export function inWorldName(name: string): string {
  return `/doc/${name.replace(/\//g, "_").replace(/\.md$/, "")}.txt`;
}
