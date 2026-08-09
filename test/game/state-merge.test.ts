/**
 * The dispatcher stopped reporting bitnode_id to reclaim the 1.0 GB
 * ns.getResetInfo charges every tick, so PuppeteerGame merges a
 * boot-probed value back into every GameState it hands out.
 *
 * Two things went wrong with that and are pinned here:
 *
 *  - The merge was unconditional, but `dispatcher-light.js` (golden /
 *    validation mode) *does* still report a live bitnode_id, and in that
 *    mode the boot probe cannot run at all — it is dispatched through
 *    /__queue.json, which the light dispatcher never reads. So the merge
 *    overwrote a correct live reading with the failed probe's default of
 *    1. On BitNode 1 the two coincide, which is what hid it.
 *
 *  - `staleState()` has three call sites and the merge was added to two
 *    of them, so one path handed out a state whose bitnode_id was the
 *    hardcoded sentinel rather than the run's actual node.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import { captureStartingMoney, mergeCachedFields } from "../../harness/game/puppeteer";
import type { GameState } from "../../harness/types";

const PUPPETEER_SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "harness",
  "game",
  "puppeteer.ts",
);

function state(over: Partial<GameState> = {}): GameState {
  return { current_money: 1262, bitnode_id: 1, bitnode_complete: false, ...over };
}

describe("mergeCachedFields", () => {
  test("normal mode restores the boot-probed value the dispatcher stopped reporting", () => {
    // dispatcher.js omits bitnode_id entirely; whatever is on the object
    // is not authoritative, the probe is.
    const merged = mergeCachedFields(state({ bitnode_id: undefined as unknown as number }), {
      cachedBitnodeId: 4,
      lightDispatcher: false,
      startingMoney: null,
    });
    assert.equal(merged.bitnode_id, 4);
    assert.equal(merged.bitnode_complete, false);
    assert.equal(merged.current_money, 1262, "unrelated fields must survive the merge");
  });

  test("light mode prefers the live value the light dispatcher reports", () => {
    // The regression: probe is skipped in light mode, so cachedBitnodeId
    // is only ever the untested default. Overwriting a real reading of 4
    // with it silently reports the wrong scenario.
    const merged = mergeCachedFields(state({ bitnode_id: 4 }), {
      cachedBitnodeId: 1,
      lightDispatcher: true,
      startingMoney: null,
    });
    assert.equal(
      merged.bitnode_id,
      4,
      "light mode must not clobber a reported bitnode_id with the probe default",
    );
  });

  test("light mode falls back to the cached value when nothing was reported", () => {
    for (const absent of [undefined, null, "4"]) {
      const merged = mergeCachedFields(state({ bitnode_id: absent as unknown as number }), {
        cachedBitnodeId: 1,
        lightDispatcher: true,
        startingMoney: null,
      });
      assert.equal(merged.bitnode_id, 1, `non-numeric ${JSON.stringify(absent)} is not a reading`);
    }
  });

  test("the read_failed flag survives, so callers can still refuse the sentinel", () => {
    const merged = mergeCachedFields(state({ read_failed: true }), {
      cachedBitnodeId: 1,
      lightDispatcher: false,
      startingMoney: null,
    });
    assert.equal(merged.read_failed, true);
  });
});

describe("mergeCachedFields — money is a delta", () => {
  // Bitburner starts the player at $1,262. Two real runs read that
  // balance as revenue ("only $1,262 earned" — actual earnings $0), so
  // the merge now reports the delta against a boot-captured baseline.
  test("computes money_earned against the captured baseline", () => {
    const merged = mergeCachedFields(state({ current_money: 51262 }), {
      cachedBitnodeId: 1,
      lightDispatcher: false,
      startingMoney: 1262,
    });
    assert.equal(merged.starting_money, 1262);
    assert.equal(merged.money_earned, 50000);
  });

  test("a run that has earned nothing reads 0, not the starting balance", () => {
    const merged = mergeCachedFields(state({ current_money: 1262 }), {
      cachedBitnodeId: 1,
      lightDispatcher: false,
      startingMoney: 1262,
    });
    assert.equal(merged.money_earned, 0);
  });

  test("with no baseline captured yet, the current balance is the baseline", () => {
    const merged = mergeCachedFields(state({ current_money: 1262 }), {
      cachedBitnodeId: 1,
      lightDispatcher: false,
      startingMoney: null,
    });
    assert.equal(merged.starting_money, 1262);
    assert.equal(merged.money_earned, 0);
  });
});

describe("captureStartingMoney", () => {
  test("captures the first successful read as the baseline", () => {
    assert.equal(captureStartingMoney(null, state({ current_money: 1262 })), 1262);
  });

  test("keeps the existing baseline once captured", () => {
    assert.equal(captureStartingMoney(1262, state({ current_money: 99999 })), 1262);
  });

  test("refuses a read_failed placeholder as the baseline", () => {
    // staleState() reports current_money: 0. Capturing that would make
    // every later good read look like pure profit.
    assert.equal(captureStartingMoney(null, state({ current_money: 0, read_failed: true })), null);
  });

  test("refuses a non-numeric current_money", () => {
    assert.equal(
      captureStartingMoney(null, state({ current_money: "1262" as unknown as number })),
      null,
    );
  });
});

describe("staleState call sites", () => {
  // A source-level guard, deliberately: the defect was not bad logic but
  // an incomplete edit across three identical call sites. Only a check
  // that sees all of them at once catches the fourth one being added
  // unwrapped, and booting Chromium to prove it is not viable in `npm test`.
  test("every staleState() call is wrapped in the cached-fields merge", () => {
    const src = readFileSync(PUPPETEER_SRC, "utf8");
    const offenders = src
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => line.includes("staleState()"))
      .filter(([, line]) => !line.includes("function staleState()"))
      .filter(([, line]) => !line.includes("withCachedFields(staleState())"));

    assert.deepEqual(
      offenders,
      [],
      `unwrapped staleState() hands out a sentinel bitnode_id:\n${offenders
        .map(([n, l]) => `  ${PUPPETEER_SRC}:${n}: ${l.trim()}`)
        .join("\n")}`,
    );
  });

  test("the guard is actually looking at call sites (it would notice if they vanished)", () => {
    const src = readFileSync(PUPPETEER_SRC, "utf8");
    const calls = src.split("\n").filter((l) => l.includes("withCachedFields(staleState())"));
    assert.equal(calls.length, 3, "expected the three known staleState() fallback paths");
  });
});
