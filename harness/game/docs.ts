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
 *
 * The two sets are read from two DIFFERENT places, on purpose — see
 * VENDORED_ROOT / SUBMODULE_ROOT below. Do not unify them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * BASIC_DOCS live here, vendored into the repo (see docs/README.md).
 *
 * They are copied byte-for-byte from the pinned BITBURNER_COMMIT, so
 * vendoring *is* pinning — no fairness or reproducibility difference
 * from reading the submodule. What it buys: every pull request builds
 * this prompt without cloning ~316 MB of submodule history to read
 * ~18 KB of markdown, so ci.yml can stay on `submodules: false`.
 */
const VENDORED_ROOT = path.join(HERE, "docs");

/**
 * LIBRARY_DOCS stay here, in the pinned submodule.
 *
 * Deliberately NOT vendored alongside the basics. Their only consumer
 * pushes them in-world, which means the game is built and running — the
 * submodule is present by construction, so there is nothing to buy by
 * copying them, and every copied file is one more thing to keep in sync
 * with the pin.
 */
const SUBMODULE_ROOT = path.resolve(
  HERE, "..", "..", "bitburner", "src", "src", "Documentation", "doc", "en",
);

// Widened to `readonly string[]` explicitly (rather than left as the
// `as const` literal-tuple type) so callers can check membership of an
// arbitrary doc name — e.g. `LIBRARY_DOCS.includes(someName)` — without
// TypeScript narrowing the argument to the five-element literal union
// and rejecting every string that isn't already in the list.

/** Mechanics only. ~2,682 words. Read from VENDORED_ROOT. */
export const BASIC_DOCS: readonly string[] = [
  "basic/ram.md",
  "basic/servers.md",
  "basic/hacking.md",
  "basic/scripts.md",
  "basic/programs.md",
] as const;

/** Pushed in-world; must be fetched by a subagent. Read from SUBMODULE_ROOT. */
export const LIBRARY_DOCS: readonly string[] = [
  "help/getting_started.md",
  "programming/hackingalgorithms.md",
  "basic/stats.md",
  "basic/terminal.md",
  "basic/world.md",
] as const;

/**
 * Membership, not path shape, decides which root a doc is read from.
 *
 * `basic/stats.md`, `basic/terminal.md` and `basic/world.md` are
 * `basic/`-prefixed yet belong to LIBRARY_DOCS, so a prefix test would
 * send them to the vendored tree and fail. Only the five names actually
 * copied into `docs/basic/` resolve there.
 */
const VENDORED: ReadonlySet<string> = new Set(BASIC_DOCS);

/**
 * Absolute path of a doc, and whether it came from the vendored copy.
 * Exported because callers that push docs in-world need the path, and
 * because the vendored/submodule split is worth asserting in tests.
 */
export function docPath(name: string): { file: string; vendored: boolean } {
  const vendored = VENDORED.has(name);
  return { file: path.join(vendored ? VENDORED_ROOT : SUBMODULE_ROOT, name), vendored };
}

/**
 * Concatenates docs with a heading per file. Throws if one is missing.
 *
 * The throw is deliberately chatty, and says something different per
 * root because the fix differs. A missing LIBRARY doc almost always
 * means an un-initialized submodule — a fresh clone, or a CI checkout
 * that skipped it — and a bare ENOENT on a path six levels deep tells
 * the reader nothing about that. A missing BASIC doc means the vendored
 * copy is gone, which no `git submodule` command will fix.
 */
export function loadDocs(names: readonly string[]): string {
  return names
    .map((name) => {
      const { file, vendored } = docPath(name);
      let body: string;
      try {
        body = readFileSync(file, "utf8").trim();
      } catch (cause) {
        const remedy = vendored
          ? `This doc is vendored in harness/game/docs — restore it from ` +
            `the pinned game source (see harness/game/docs/README.md).`
          : `These docs ship in the pinned bitburner submodule — run ` +
            `\`git submodule update --init --recursive\` to fetch it.`;
        throw new Error(
          `Could not read the game doc "${name}" (looked in ${file}). ${remedy}`,
          { cause },
        );
      }
      return `--- ${name} ---\n${body}`;
    })
    .join("\n\n");
}

/** In-world filename for a doc. Bitburner allows only .txt/.json/.css. */
export function inWorldName(name: string): string {
  return `/doc/${name.replace(/\//g, "_").replace(/\.md$/, "")}.txt`;
}
