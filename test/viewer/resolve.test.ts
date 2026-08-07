/**
 * The viewer is usually started with no arguments, before or during a
 * run, and has to find the right `state.db` on its own. Getting this
 * wrong is quiet rather than loud: pointing at a stale run shows a
 * plausible dashboard of the wrong thing.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import { resolveRunDb } from "../../viewer/server";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "benchburner-resolve-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;

/** Creates `<results>/<runId>/state.db` with a given mtime (epoch seconds). */
function makeRun(resultsDir: string, runId: string, mtimeSec: number): string {
  const dir = path.join(resultsDir, runId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "state.db");
  writeFileSync(file, "");
  utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

function freshResults(): string {
  const dir = path.join(tmpRoot, `results-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("viewer/resolveRunDb", () => {
  test("picks the most recently written run when given no target", () => {
    const results = freshResults();
    makeRun(results, "older-run", 1_700_000_000);
    const newest = makeRun(results, "newer-run", 1_800_000_000);
    assert.equal(resolveRunDb(undefined, results), newest);
  });

  test("resolves an explicit run id under the results dir", () => {
    const results = freshResults();
    const wanted = makeRun(results, "wanted-run", 1_700_000_000);
    makeRun(results, "newer-but-not-asked-for", 1_900_000_000);
    assert.equal(resolveRunDb("wanted-run", results), wanted);
  });

  test("accepts a direct path to a .db file", () => {
    const results = freshResults();
    const file = makeRun(results, "some-run", 1_700_000_000);
    assert.equal(resolveRunDb(file, results), file);
  });

  test("returns null rather than throwing when there is nothing to show", () => {
    assert.equal(resolveRunDb(undefined, freshResults()), null);
    assert.equal(resolveRunDb(undefined, path.join(tmpRoot, "does-not-exist")), null);
    assert.equal(resolveRunDb("no-such-run", freshResults()), null);
    assert.equal(resolveRunDb("/tmp/definitely-not-here.db", freshResults()), null);
  });

  test("ignores result directories that have no state.db yet", () => {
    const results = freshResults();
    const real = makeRun(results, "has-db", 1_700_000_000);
    mkdirSync(path.join(results, "just-created-no-db"), { recursive: true });
    assert.equal(resolveRunDb(undefined, results), real);
  });
});
