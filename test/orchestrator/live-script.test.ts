/**
 * "Is this subagent's script still earning?" was unanswerable: the state
 * export carried no running-script data, and ExecutionResult.money_gained
 * is a global player delta that cannot be attributed when several scripts
 * run at once. The per-script figure already existed in-game
 * (ns.getRunningScript().onlineMoneyMade) and was simply never exported.
 *
 * The 24h orchestrator had neither signal, so it re-instructed blindly.
 *
 * The assertions run against the prompt the loop actually builds, not an
 * internal — "the orchestrator can see it" is the claim being made.
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
import { buildOrchestratorPrompt } from "../../harness/orchestrator/prompt";
import { openDb } from "../../harness/storage/db";
import { insertRun } from "../../harness/storage/writers";
import { SubagentPool } from "../../harness/subagent/pool";
import type {
  LiveScript,
  OrchestratorInput,
  RunConfig,
  SubagentStatus,
} from "../../harness/types";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "benchburner-livescript-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const RUN_ID = "99999999-8888-7777-6666-555555555555";
const SUB = "earner";
const MODEL = "qwen2.5-coder:7b";

const live: LiveScript = {
  running: true,
  money_made: 45000,
  ram: 2.6,
  uptime_seconds: 180,
};

function syntheticInput(ls: LiveScript | null): OrchestratorInput {
  return {
    cycle_number: 3,
    elapsed_time_seconds: 180,
    total_duration_seconds: 1200,
    game_state: {
      current_money: 46262,
      bitnode_id: 1,
      bitnode_complete: false,
    },
    subagent_status: [
      {
        subagent_id: SUB,
        last_instruction_id: "i-1",
        last_result: null,
        live_script: ls,
        status: "executed",
      },
    ],
    delegation_history: [],
    available_subagent_models: [MODEL],
  };
}

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

/**
 * Publishes a snapshot carrying per-subagent script stats, then returns
 * the `subagent_status` entry out of the next prompt the loop builds.
 */
async function statusAfterSnapshot(
  liveScripts: Record<string, LiveScript>,
): Promise<SubagentStatus> {
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
  bus.publish("snapshots", {
    source: "backend_snapshot",
    hour: 0,
    game_state: {
      current_money: 46262,
      bitnode_id: 1,
      bitnode_complete: false,
      live_scripts: liveScripts,
    },
    timestamp: new Date().toISOString(),
  });

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
      if (s?.live_script) found = s;
    }
  }

  await loop.stop();
  await game.stop();
  db.close();

  assert.ok(found, "no prompt the loop built ever carried live_script for the subagent");
  return found;
}

describe("orchestrator input — live script", () => {
  test("per-subagent earnings reach the prompt", () => {
    const { user } = buildOrchestratorPrompt(syntheticInput(live), 8675309);
    const s = JSON.parse(user).subagent_status[0];
    assert.equal(s.live_script.running, true);
    assert.equal(s.live_script.money_made, 45000);
    assert.equal(s.live_script.uptime_seconds, 180);
    assert.equal(s.live_script.ram, 2.6);
  });

  test("a subagent with no committed script reports null, not a fake zero", () => {
    const { user } = buildOrchestratorPrompt(syntheticInput(null), 8675309);
    assert.equal(JSON.parse(user).subagent_status[0].live_script, null);
  });

  test("a subagent the harness never mentioned reports null, not undefined", () => {
    // scrubInput builds subagent_status with a spread, so an absent key
    // would drop out of the JSON entirely rather than reading as "no
    // script" — the same normalisation last_execution already gets.
    const input = syntheticInput(null);
    delete input.subagent_status[0].live_script;
    const { user } = buildOrchestratorPrompt(input, 8675309);
    const s = JSON.parse(user).subagent_status[0];
    assert.ok("live_script" in s, "the key must be present so its absence is not ambiguous");
    assert.equal(s.live_script, null);
  });
});

describe("orchestrator loop — live script reaches the built prompt", () => {
  test("the loop threads per-subagent earnings from game state into the prompt", async () => {
    const s = await statusAfterSnapshot({ [SUB]: live });
    assert.equal(s.live_script?.running, true);
    assert.equal(s.live_script?.money_made, 45000);
    assert.equal(s.live_script?.uptime_seconds, 180);
  });

  test("a script attributed to another subagent does not leak into this one", async () => {
    const s = await statusAfterSnapshot({
      "someone-else": { running: true, money_made: 999, ram: 1.7, uptime_seconds: 5 },
      [SUB]: live,
    });
    assert.equal(s.live_script?.money_made, 45000);
  });
});
