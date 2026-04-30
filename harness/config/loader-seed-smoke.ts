/**
 * Loader smoke: rejects negative `game.seed`.
 *
 * Why: the orchestrator's leak detector matches the seed string against
 * the rendered prompt, and negative integers stringify with a leading
 * "-" (a non-word character). If a future detector tightens to a
 * word-boundary regex, "value=-1234" no longer matches because both
 * sides of the seed are non-word — the seed leaks. Reject negative
 * seeds at config load so the property lives in one place.
 *
 * Run:  npx tsx harness/config/loader-seed-smoke.ts
 * Exit: 0 on pass, 1 on any failure.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRunConfig } from "./loader";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`[smoke] FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`[smoke] OK: ${msg}`);
}

function makeYaml(seed: number | string): string {
  return `run_id: auto
orchestrator:
  model: test:orchestrator
subagent_roster:
  - test:subagent
game:
  bitburner_commit: a4b0f22a2e5bcf19826c0bb671373c755fc162ad
  seed: ${seed}
duration_hours: 1
`;
}

function tryLoad(path: string): { ok: true } | { ok: false; message: string } {
  try {
    loadRunConfig(path);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), "bb-loader-seed-smoke-"));
  try {
    // Negative seed → reject with informative message.
    const negPath = join(dir, "neg.yaml");
    writeFileSync(negPath, makeYaml(-1234));
    const negResult = tryLoad(negPath);
    assert(!negResult.ok, "negative seed (-1234) is rejected");
    if (!negResult.ok) {
      assert(
        /seed/i.test(negResult.message),
        `error mentions seed (got: ${negResult.message})`,
      );
      assert(
        /negative|non-?negative|>= ?0/i.test(negResult.message),
        `error explains the constraint (got: ${negResult.message})`,
      );
    }

    // Positive seed → accept (smoke that the validator didn't break the happy path).
    const posPath = join(dir, "pos.yaml");
    writeFileSync(posPath, makeYaml(8675309));
    const cfg = loadRunConfig(posPath);
    assert(cfg.game.seed === 8675309, "positive seed (8675309) loads");

    // Zero is non-negative → accept.
    const zeroPath = join(dir, "zero.yaml");
    writeFileSync(zeroPath, makeYaml(0));
    const zeroCfg = loadRunConfig(zeroPath);
    assert(zeroCfg.game.seed === 0, "zero seed loads (non-negative)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("[smoke] all assertions passed");
}

main();
