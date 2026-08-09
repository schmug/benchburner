/**
 * The orchestrator's system prompt promises (prompt.ts):
 *
 *   "Execution feedback includes stdout / stderr / exit_reason /
 *    money_gained — use them to route around broken subagent output."
 *
 * It did not. `onExecution` took the game-state snapshot off the
 * ExecutionResult and threw the rest away, so the outcome of the script
 * a subagent actually committed to the game never reached
 * `subagent_status` or `delegation_history`. The orchestrator saw the
 * subagent's report ("success, here is my code") and nothing about
 * whether that code ran.
 *
 * Observed consequence: on an Opus-orchestrated run, two of four
 * committed scripts failed with "ns.run returned 0 — script missing or
 * RAM budget exceeded", and the orchestrator's own reasoning that cycle
 * asserted all three were "live and accruing money". It had no way to
 * know otherwise, so it never corrected — a plausible contributor to
 * runs planting on the starting-money floor.
 *
 * These tests assert against the prompt actually built for the model,
 * not an internal, because "the orchestrator can see it" is the claim.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import { Bus } from "../../harness/bus/bus";
import { MockGame } from "../../harness/game/mock";
import { InferenceRegistry } from "../../harness/inference/registry";
import { OrchestratorLoop } from "../../harness/orchestrator/loop";
import { openDb } from "../../harness/storage/db";
import { insertRun } from "../../harness/storage/writers";
import { SubagentPool } from "../../harness/subagent/pool";
import type { ExecutionResult, RunConfig, SubagentStatus } from "../../harness/types";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "benchburner-execfb-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const RUN_ID = "eeeeeeee-ffff-0000-1111-222222222222";
const SUB = "earner";

function config(): RunConfig {
  return {
    run_id: RUN_ID,
    orchestrator: {
      model: "null-orchestrator",
      polling_interval_seconds: 1,
      history_window: 10,
      hang_timeout_seconds: 600,
    },
    subagent_roster: ["qwen2.5-coder:7b"],
    subagent_limits: {
      max_concurrent: 2,
      token_budget_per_instruction: 2000,
      timeout_seconds: 300,
    },
    game: { bitburner_commit: "a4b0f22a", seed: 8675309 },
    duration_seconds: 600,
    attribution_mode: "public",
  };
}

function failedExecution(over: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    script_id: "s-1",
    subagent_id: SUB,
    status: "failed",
    money_gained: 0,
    time_elapsed_seconds: 0,
    exit_reason: "failed_to_start",
    stderr: "ns.run returned 0 — script missing or RAM budget exceeded",
    game_state_snapshot: { current_money: 1262, bitnode_id: 1, bitnode_complete: false },
    timestamp: new Date().toISOString(),
    ...over,
  };
}

/**
 * Publishes an execution, then returns the `subagent_status` entry from
 * the next prompt the loop actually builds for the model.
 */
async function statusAfterExecution(exec: ExecutionResult): Promise<SubagentStatus> {
  const dir = mkdtempSync(path.join(tmpRoot, "run-"));
  const db = openDb(path.join(dir, "state.db"));
  const cfg = config();
  insertRun(db, {
    run_id: RUN_ID,
    orchestrator_model: cfg.orchestrator.model,
    orchestrator_config: {},
    subagent_roster: cfg.subagent_roster,
    seed: cfg.game.seed,
    bitburner_commit: cfg.game.bitburner_commit,
    start_time: new Date().toISOString(),
    attribution_mode: "public",
  });

  const bus = new Bus();
  const pool = new SubagentPool();
  pool.spawn(SUB, "qwen2.5-coder:7b", new Date().toISOString());
  const game = new MockGame({ seed: 1 });
  await game.start();

  const loop = new OrchestratorLoop({
    run_id: RUN_ID,
    config: cfg,
    bus,
    db,
    game,
    pool,
    registry: new InferenceRegistry([
      { id: "null-orchestrator", adapter: "null-orchestrator", endpoint: "none", context_window: 8192 },
    ]),
    totalDurationSeconds: cfg.duration_seconds,
    logDir: dir,
    onFatal: (r) => {
      throw new Error(`unexpected fatal: ${r}`);
    },
  });

  loop.start(await game.readState());
  bus.publish("executions", exec);

  const logPath = path.join(dir, "orchestrator-prompts.log");
  let found: SubagentStatus | undefined;
  for (let i = 0; i < 200 && !found; i++) {
    await new Promise((r) => setTimeout(r, 25));
    let raw = "";
    try {
      raw = readFileSync(logPath, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n").filter(Boolean)) {
      let entry: { user?: string };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry.user) continue;
      const input = JSON.parse(entry.user) as { subagent_status?: SubagentStatus[] };
      const s = input.subagent_status?.find((x) => x.subagent_id === SUB);
      if (s?.last_execution) found = s;
    }
  }

  await loop.stop();
  await game.stop();
  db.close();

  assert.ok(found, "no prompt ever carried last_execution for the subagent");
  return found;
}

describe("orchestrator input — committed-script execution feedback", () => {
  test("a committed script that never started is visible to the orchestrator", async () => {
    const s = await statusAfterExecution(failedExecution());

    assert.equal(s.last_execution?.exit_reason, "failed_to_start");
    assert.match(
      s.last_execution?.stderr ?? "",
      /RAM budget exceeded/,
      "the reason it failed must survive into the prompt",
    );
    assert.equal(s.last_execution?.money_gained, 0);
  });

  test("a running script reports as such, so the two are distinguishable", async () => {
    const s = await statusAfterExecution(
      failedExecution({
        status: "executed",
        exit_reason: "running",
        stderr: undefined,
        stdout: "started hacking loop",
        money_gained: 0,
      }),
    );
    assert.equal(s.last_execution?.exit_reason, "running");
    assert.equal(s.last_execution?.status, "executed");
  });

  test("truncates chatty output so one script cannot dominate the prompt budget", async () => {
    const s = await statusAfterExecution(
      failedExecution({ stderr: "E".repeat(20_000), stdout: "O".repeat(20_000) }),
    );
    assert.ok(
      (s.last_execution?.stderr ?? "").length < 1_000,
      `stderr not truncated (${s.last_execution?.stderr?.length} chars)`,
    );
    assert.ok((s.last_execution?.stdout ?? "").length < 1_000);
  });

  test("execution text reaches the orchestrator verbatim", async () => {
    // Was: "execution text passes through the leak scrubber", asserting
    // that "Bitburner" and "hacknet" were redacted out of stderr.
    //
    // The game-identity scrub is retired (harness/orchestrator/prompt.ts
    // module header): the same prompt vendors the game's own manual,
    // which names the early-game targets and port openers outright, so
    // redacting the title out of a stack trace concealed nothing and
    // only made runtime errors harder to read. A truncated crash
    // message is exactly the input the orchestrator needs intact to
    // route around a broken subagent.
    //
    // The surviving guarantee is the seed, and it is enforced by
    // detectLeaks, not here — see test/orchestrator/docs-prompt.test.ts.
    const stderr = "crash inside Bitburner runtime: hacknet failure";
    const s = await statusAfterExecution(failedExecution({ stderr }));
    assert.equal(s.last_execution?.stderr, stderr);
    assert.doesNotMatch(JSON.stringify(s.last_execution), /\[redacted\]/);
  });

  test("does not carry the raw game_state_snapshot into per-subagent status", async () => {
    // Game state already has its own top-level channel; duplicating it
    // per subagent would inflate every prompt for no new information.
    const s = await statusAfterExecution(failedExecution());
    assert.equal(
      "game_state_snapshot" in (s.last_execution ?? {}),
      false,
    );
  });
});
