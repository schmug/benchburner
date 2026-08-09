/**
 * The orchestrator gets the game's own Basic Mechanics text — mechanics,
 * not strategy. The tutorial (which walks through a working early-hack
 * script) and the optimal-batching guide stay out of the prompt and go
 * in-world, where a subagent must be sent to read them.
 *
 * Everything here must pass with NO submodule checked out: the basics
 * are vendored precisely so ci.yml can keep `submodules: false`. Do not
 * add an assertion that reads the submodule tree.
 */
import { strict as assert } from "node:assert";
import { statSync } from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

import { BASIC_DOCS, LIBRARY_DOCS, docPath, loadDocs } from "../../harness/game/docs";
import { FORBIDDEN_TOKENS, buildOrchestratorPrompt, detectLeaks } from "../../harness/orchestrator/prompt";
import type { OrchestratorInput } from "../../harness/types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const VENDORED_DIR = path.join(REPO_ROOT, "harness", "game", "docs");
const SUBMODULE_DIR = path.join(REPO_ROOT, "bitburner", "src");

const SEED = 8675309;

const input: OrchestratorInput = {
  cycle_number: 1,
  elapsed_time_seconds: 0,
  total_duration_seconds: 1200,
  game_state: {
    current_money: 1262,
    starting_money: 1262,
    money_earned: 0,
    bitnode_id: 1,
    bitnode_complete: false,
  },
  subagent_status: [],
  delegation_history: [],
  available_subagent_models: ["m"],
};

describe("orchestrator docs", () => {
  test("loads the five basic files from the pinned game", () => {
    const text = loadDocs(BASIC_DOCS);
    assert.ok(text.length > 5000, `expected the basics, got ${text.length} chars`);
    assert.match(text, /purchase more RAM for your home computer/i);
  });

  test("the basics are vendored in-repo, not read from the submodule", () => {
    // The whole point of vendoring: CI checks out with `submodules:
    // false`, so anything the prompt needs must resolve inside the repo
    // proper. If someone "helpfully" re-points BASIC_DOCS at the
    // submodule, ci.yml starts failing on a fresh checkout — catch it
    // here instead, where the message says why.
    for (const name of BASIC_DOCS) {
      const { file, vendored } = docPath(name);
      assert.ok(vendored, `${name} is not resolved from the vendored copy`);
      assert.ok(
        file.startsWith(VENDORED_DIR + path.sep),
        `${name} resolves to ${file}, outside ${VENDORED_DIR}`,
      );
      assert.ok(
        !file.startsWith(SUBMODULE_DIR + path.sep),
        `${name} resolves into the submodule at ${file}`,
      );
      assert.ok(statSync(file).size > 0, `${file} is empty`);
    }
  });

  test("the library docs still come from the pinned submodule", () => {
    // Only the basics are vendored. LIBRARY_DOCS are pushed in-world by
    // a consumer that runs with the game built, so the submodule is
    // there by construction and copying them would just add five more
    // files to keep in sync with BITBURNER_COMMIT. Path assertion only:
    // this test has to pass without the submodule checked out.
    for (const name of LIBRARY_DOCS) {
      const { file, vendored } = docPath(name);
      assert.equal(vendored, false, `${name} should not be vendored`);
      assert.ok(
        file.startsWith(SUBMODULE_DIR + path.sep),
        `${name} resolves to ${file}, outside ${SUBMODULE_DIR}`,
      );
    }
  });

  test("the basics reach the system prompt", () => {
    const { system } = buildOrchestratorPrompt(input, SEED);
    assert.match(system, /purchase more RAM for your home computer/i);
  });

  test("the RAM budget quoted to the orchestrator is the measured one", () => {
    // These figures drive real decisions — a script whose declared ns.*
    // calls exceed the budget never starts — so a stale number tells the
    // orchestrator that whole strategies are impossible when they are
    // not. The pre-N1 text claimed ~3 GB, which ruled out ns.exec
    // (2.9 GB), ns.scp+ns.exec (3.5 GB) and ns.purchaseServer (3.85 GB).
    // Update this test deliberately when the harness's own usage is
    // re-measured; do not let it drift silently again.
    const { system } = buildOrchestratorPrompt(input, SEED);
    assert.match(system, /about 3\.8 GB for its process bookkeeping/);
    assert.match(system, /approximately 4\.2 GB for the scripts/);
    assert.match(system, /counts against that 4\.2 GB/);
    assert.equal(system.includes("4.9 GB"), false, "stale harness-overhead figure");
  });

  test("strategy guides are excluded from the prompt", () => {
    assert.equal(BASIC_DOCS.includes("help/getting_started.md"), false);
    assert.equal(BASIC_DOCS.includes("programming/hackingalgorithms.md"), false);
    assert.ok(LIBRARY_DOCS.includes("help/getting_started.md"));
    assert.ok(LIBRARY_DOCS.includes("programming/hackingalgorithms.md"));
  });

  test("the basics are mechanics-only, and the two sets are disjoint", () => {
    // The check above is a two-name denylist, so it would stay green if
    // some *other* strategy doc (`advanced/*.md`, `programming/learn.md`)
    // were added to BASIC_DOCS tomorrow. Assert the shape of the whole
    // set instead: a free doc must come from `basic/` (mechanics), and
    // nothing a subagent has to be sent to fetch may also be free.
    for (const name of BASIC_DOCS) {
      assert.ok(name.startsWith("basic/"), `${name} is not a basic/ mechanics doc`);
    }
    for (const name of BASIC_DOCS) {
      assert.equal(
        LIBRARY_DOCS.includes(name),
        false,
        `${name} is in both BASIC_DOCS and LIBRARY_DOCS`,
      );
    }
  });

  test("a missing submodule doc names the file and how to fix it", () => {
    // This is the first error a fresh cloner hits; a bare ENOENT on a
    // path deep inside the submodule doesn't tell them what to do.
    // An unvendored name resolves to the submodule, so this is the
    // remedy that applies.
    assert.throws(
      () => loadDocs(["basic/not-a-real-doc.md"]),
      (err: Error) => {
        assert.match(err.message, /basic\/not-a-real-doc\.md/);
        assert.match(err.message, /git submodule update --init --recursive/);
        return true;
      },
    );
  });

  test("the prompt names the game", () => {
    // Retired: the game-identity scrub. It redacted the *title* while
    // this same prompt handed over the vendored manual's early-game
    // target ladder by name — and naming those targets activates
    // memorised-strategy priors far harder than the word "Bitburner"
    // does. The scrub bought nothing it did not also give away, so it
    // went rather than being widened.
    const { system } = buildOrchestratorPrompt(input, SEED);
    assert.match(system, /playing Bitburner\b/);
  });

  test("the vendored docs arrive unredacted", () => {
    // The scrub used to punch [redacted] holes through the game's own
    // prose — "In Bitburner, RAM determines..." became "In [redacted],
    // RAM determines..." — degrading the manual without concealing the
    // subject. Nothing in the prompt should be redacted now.
    const { system, user } = buildOrchestratorPrompt(input, SEED);
    const full = system + "\n" + user;
    assert.equal(full.includes("[redacted]"), false, "prompt still has redaction holes");
    assert.match(system, /In Bitburner, RAM determines/);
    assert.match(system, /install \[Augmentations\]/);
  });

  test("detectLeaks no longer fires on game vocabulary", () => {
    const vocab =
      "Bitburner BitNode Hacknet augment augmentations n00dles foodnstuff BruteSSH Darkweb seed";
    assert.deepEqual(detectLeaks(vocab, SEED), []);
    assert.deepEqual([...FORBIDDEN_TOKENS], []);
  });
});

/**
 * CLAUDE.md constraint 6 has two halves and only one was retired. The
 * game's identity is now given to the orchestrator outright; the RNG
 * seed is still withheld, because a known seed lets a model overfit one
 * scenario instead of developing orchestration strategy. With the token
 * loop gone, the seed check is the *whole* leak policy — these tests
 * carry it alone, so they are written to fail loudly if it is weakened.
 */
describe("orchestrator prompt: the seed stays opaque", () => {
  test("a normally-built prompt contains no seed", () => {
    const { system, user } = buildOrchestratorPrompt(input, SEED);
    const full = system + "\n" + user;
    assert.equal(full.includes(String(SEED)), false, "seed text found in the prompt");
    assert.deepEqual(detectLeaks(full, SEED), []);
  });

  test("...and that check has teeth: a seed the prompt really carries IS caught", () => {
    // The test above would pass vacuously if buildOrchestratorPrompt
    // returned "" or detectLeaks always returned []. Positive control
    // against the *same* fully-built prompt: run the detector with a
    // seed equal to a number the prompt genuinely contains
    // (`current_money` survives scrubInput's whitelist and is rendered
    // into the user JSON). A real run configured with this seed would
    // be failed closed by the loop — which is the point.
    const leakySeed = 1262;
    const { system, user } = buildOrchestratorPrompt(input, leakySeed);
    const full = system + "\n" + user;
    assert.ok(full.includes(String(leakySeed)), "positive control is itself vacuous");
    assert.deepEqual(detectLeaks(full, leakySeed), [`seed:${leakySeed}`]);
  });

  test("a seed spliced into a clean prompt is caught", () => {
    const { system, user } = buildOrchestratorPrompt(input, SEED);
    const poisoned = `${system}\n${user}\ndebug: seed=${SEED}\n`;
    assert.deepEqual(detectLeaks(poisoned, SEED), [`seed:${SEED}`]);
  });

  test("the false-positive guards on the seed check survive", () => {
    // Both guards exist so `total_duration_seconds` cannot false-fire
    // and fail an honest run at the §3.3 leak audit. They are the
    // reason the seed check can stay switched on. Do not "simplify"
    // them away now that this is the only branch left in detectLeaks.
    assert.deepEqual(detectLeaks("total_duration_seconds: 86400", 8640), [], "word boundary");
    assert.deepEqual(detectLeaks("value=186402", 8640), [], "word boundary");
    assert.deepEqual(detectLeaks("value=42 here", 42), [], ">= 3 digit guard");
    assert.deepEqual(detectLeaks("debug seed=8640 ok", 8640), ["seed:8640"], "real leak");
  });
});
