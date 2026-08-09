/**
 * A dispatcher-written result file embeds a game_state_snapshot of only
 * {current_money, augments_installed} — no live_scripts key. The loop
 * fed that snapshot to acceptIncomingState, which replaced latestState
 * wholesale, so a single failed_to_start commit blanked live_script for
 * the ENTIRE team until the next full snapshot (~50s; a whole cycle on
 * canonical runs).
 *
 * RAM exhaustion is the designed loud failure under the default budget,
 * so this transiently fabricated exactly the "nothing running" signal
 * live_script exists to make trustworthy — an orchestrator seeing it
 * may kill/replace healthy scripts (issue #51, from the PR #47 review).
 *
 * The fix: merge incoming state field-wise. A key present on the
 * incoming snapshot is fresh information and overwrites; an absent key
 * means "not reported", never "empty". Note the dispatcher always
 * writes live_scripts (as {} when idle) into /__state.json, so a full
 * snapshot saying "nothing running" still comes through — the key is
 * present, just empty.
 *
 * Like live-script.test.ts, the assertions run against the prompt the
 * loop actually builds — "the orchestrator still sees it" is the claim.
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
import type {
  GameState,
  LiveScript,
  OrchestratorInput,
  RunConfig,
  SubagentStatus,
} from "../../harness/types";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "benchburner-statemerge-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const RUN_ID = "99999999-8888-7777-6666-444444444444";
const SUB = "earner";
const MODEL = "qwen2.5-coder:7b";

const live: LiveScript = {
  running: true,
  money_made: 45000,
  ram: 2.6,
  uptime_seconds: 180,
  scripts: 1,
};

function config(): RunConfig {
  return {
    run_id: RUN_ID,
    orchestrator: {
      model: "null-orchestrator",
      polling_interval_seconds: 1,
      history_window: 10,
      hang_timeout_seconds: 600,
    },
    subagent_roster: [MODEL],
    subagent_limits: {
      max_concurrent: 2,
      token_budget_per_instruction: 2000,
      timeout_seconds: 300,
    },
    game: { bitburner_commit: "a4b0f22a", seed: 8675309 },
    duration_seconds: 1200,
    attribution_mode: "public",
  };
}

describe("orchestrator loop — partial snapshots merge, not replace", () => {
  test("a failed_to_start result between two full snapshots does not blank live_script", async () => {
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
    pool.spawn(SUB, MODEL, new Date().toISOString());
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
        {
          id: "null-orchestrator",
          adapter: "null-orchestrator",
          endpoint: "none",
          context_window: 8192,
        },
      ]),
      totalDurationSeconds: cfg.duration_seconds,
      logDir: dir,
      onFatal: (r) => {
        throw new Error(`unexpected fatal: ${r}`);
      },
    });

    loop.start(await game.readState());

    // A full snapshot: live_scripts present, on BitNode 4 so the
    // level_id assertion below cannot pass by accident of a default.
    bus.publish("snapshots", {
      source: "backend_snapshot",
      hour: 0,
      game_state: {
        current_money: 46262,
        bitnode_id: 4,
        bitnode_complete: false,
        live_scripts: { [SUB]: live },
      },
      timestamp: new Date().toISOString(),
    });

    // Then a dispatcher-shaped failed_to_start result. writeResult in
    // harness/game/dispatcher.js embeds exactly this snapshot: money
    // and augments only. No live_scripts, no bitnode_id.
    bus.publish("executions", {
      script_id: "script-under-test",
      subagent_id: SUB,
      status: "failed",
      money_gained: 0,
      time_elapsed_seconds: 0,
      error: "ns.run returned 0 — script missing or RAM budget exceeded",
      stderr: "ns.run returned 0 — script missing or RAM budget exceeded",
      exit_reason: "failed_to_start",
      game_state_snapshot: {
        current_money: 46270,
        augments_installed: [],
      } as unknown as GameState,
      timestamp: new Date().toISOString(),
    });

    // Both publishes deliver synchronously (bus contract), so any prompt
    // whose subagent_status carries last_execution was built after the
    // partial snapshot landed in latestState.
    const logPath = path.join(dir, "orchestrator-prompts.log");
    let found:
      | { status: SubagentStatus; game_state: Record<string, unknown> }
      | undefined;
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
        const input = JSON.parse(entry.user) as OrchestratorInput & {
          game_state: Record<string, unknown>;
        };
        const s = input.subagent_status?.find((x) => x.subagent_id === SUB);
        if (s?.last_execution?.exit_reason === "failed_to_start") {
          found = { status: s, game_state: input.game_state };
        }
      }
    }

    await loop.stop();
    await game.stop();
    db.close();

    assert.ok(found, "no prompt carried the failed_to_start execution");

    // The regression: with wholesale replacement live_script reads null
    // team-wide here, fabricating "nothing running" for healthy scripts.
    assert.ok(
      found.status.live_script,
      "live_script blanked by a snapshot that never mentioned live_scripts",
    );
    assert.equal(found.status.live_script?.money_made, 45000);
    assert.equal(found.status.live_script?.running, true);

    // Keys the partial snapshot DID carry are fresh information.
    assert.equal(found.game_state.current_money, 46270);

    // Keys it omitted keep their previous value — bitnode_id reaches
    // the prompt as level_id, and JSON drops it entirely if replacement
    // turned it undefined.
    assert.equal(found.game_state.level_id, 4);
  });
});
