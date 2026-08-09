/**
 * Both of the orchestrator's script-lifecycle verbs were backwards.
 *
 * `instruct` destroyed a working script: `onResult` ended in an
 * unconditional "on success, submit the script to the game", and
 * committing evicted the subagent's previous committed script. The
 * orchestrator could not instruct without risking its income, and had no
 * way to say "keep what is running".
 *
 * `kill` spared one: `handleKill` called `pool.kill` and
 * `subagentTracks.delete` and never told the game, so the script outlived
 * its owner — still consuming the shared RAM budget, still earning, and
 * now with the only record of it deleted.
 *
 * These tests drive the real OrchestratorLoop and assert on what it asks
 * the game to do, because that is where both defects lived.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import { Bus } from "../../harness/bus/bus";
import { InferenceRegistry, type ResolvedAdapter } from "../../harness/inference/registry";
import { OrchestratorLoop } from "../../harness/orchestrator/loop";
import { openDb } from "../../harness/storage/db";
import { insertRun } from "../../harness/storage/writers";
import { SubagentPool } from "../../harness/subagent/pool";
import type {
  ExecutionResult,
  GameController,
  GameState,
  InferenceInvokeParams,
  InferenceResult,
  OrchestratorAction,
  Result,
  RunConfig,
} from "../../harness/types";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "benchburner-lifecycle-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const RUN_ID = "11111111-2222-3333-4444-555555555555";
const MODEL = "sub-model";
const SUB = "earner";

function state(): GameState {
  return { current_money: 1262, bitnode_id: 1, bitnode_complete: false };
}

/** Records what the loop asked of the game. */
class SpyGame implements GameController {
  readonly runs: Array<{ script_id: string; subagent_id: string; replace?: boolean }> = [];
  readonly killed: string[] = [];
  readonly submitted: string[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async readState(): Promise<GameState> {
    return state();
  }
  async submitScript(p: { script_id: string; code: string }): Promise<void> {
    this.submitted.push(p.script_id);
  }
  async runScript(p: {
    script_id: string;
    subagent_id: string;
    kind?: "probe" | "committed";
    replace?: boolean;
  }): Promise<ExecutionResult> {
    this.runs.push({ script_id: p.script_id, subagent_id: p.subagent_id, replace: p.replace });
    return {
      script_id: p.script_id,
      subagent_id: p.subagent_id,
      status: "executed",
      money_gained: 0,
      time_elapsed_seconds: 0,
      exit_reason: "running",
      game_state_snapshot: state(),
      timestamp: new Date().toISOString(),
    };
  }
  async killScript(subagent_id: string): Promise<void> {
    this.killed.push(subagent_id);
  }
}

/**
 * Feeds the loop a canned first-cycle decision, then noops. Subclassing
 * the real registry keeps the loop on its production code path without
 * adding a test-only adapter to `models.yaml`'s union.
 */
class ScriptedRegistry extends InferenceRegistry {
  private served = false;
  constructor(private readonly first: { actions: OrchestratorAction[]; reasoning: string }) {
    super([{ id: "orch", adapter: "null-orchestrator", endpoint: "none", context_window: 8192 }]);
  }
  override get(_modelId: string): ResolvedAdapter {
    const body = () => {
      if (this.served) return { actions: [{ action_type: "noop" }], reasoning: "" };
      this.served = true;
      return this.first;
    };
    return {
      adapter: {
        name: "scripted",
        invoke: async (_p: InferenceInvokeParams): Promise<InferenceResult> => ({
          text: JSON.stringify(body()),
          tokens_used: 0,
          finish_reason: "stop",
        }),
      },
      config: { id: "orch", adapter: "null-orchestrator", endpoint: "none", context_window: 8192 },
      modelName: "orch",
    };
  }
}

function config(): RunConfig {
  return {
    run_id: RUN_ID,
    orchestrator: {
      model: "orch",
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

interface Fixture {
  loop: OrchestratorLoop;
  bus: Bus;
  game: SpyGame;
  pool: SubagentPool;
  close(): Promise<void>;
}

function fixture(first: { actions: OrchestratorAction[]; reasoning: string }): Fixture {
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
  const game = new SpyGame();

  const loop = new OrchestratorLoop({
    run_id: RUN_ID,
    config: cfg,
    bus,
    db,
    game,
    pool,
    registry: new ScriptedRegistry(first),
    totalDurationSeconds: cfg.duration_seconds,
    logDir: dir,
    onFatal: (r) => {
      throw new Error(`unexpected fatal: ${r}`);
    },
  });

  return {
    loop,
    bus,
    game,
    pool,
    close: async () => {
      await loop.stop();
      db.close();
    },
  };
}

async function until(cond: () => boolean, what: string, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const instructAction = (replace?: boolean): OrchestratorAction => ({
  action_type: "instruct",
  subagent_id: SUB,
  ...(replace === undefined ? {} : { replace }),
  instruction: {
    instruction_id: "i-1",
    subagent_id: SUB,
    task: "hack something",
    context: "",
    constraints: { token_budget: 2000, max_script_size_lines: 200 },
    timestamp: new Date().toISOString(),
  },
});

function successResult(): Result {
  return {
    instruction_id: "i-1",
    subagent_id: SUB,
    status: "success",
    code: "/** @param {NS} ns */\nexport async function main(ns) { ns.print('hi'); }",
    tokens_used: 10,
    timestamp: new Date().toISOString(),
  };
}

/** Runs one instruct→result→commit round trip and returns the run record. */
async function commitUnder(replace?: boolean): Promise<{ replace?: boolean }> {
  const f = fixture({ actions: [instructAction(replace)], reasoning: "" });
  const seen: string[] = [];
  f.bus.subscribe("instructions", (i) => seen.push(i.instruction_id));
  f.loop.start(state());
  try {
    await until(() => seen.includes("i-1"), "the instruction to be dispatched");
    f.bus.publish("results", successResult());
    await until(() => f.game.runs.length > 0, "the committed script to be run");
    return f.game.runs[0];
  } finally {
    await f.close();
  }
}

describe("orchestrator — committed-script replacement", () => {
  test("an instruct with no replace flag does not ask the game to evict", async () => {
    // The regression guard for the 1,020-restart failure: silence here
    // is what keeps a working earner alive across a re-instruction.
    const run = await commitUnder(undefined);
    assert.notEqual(run.replace, true, "replace must default to false, never be omitted-as-true");
  });

  test("replace: false is passed through as false", async () => {
    const run = await commitUnder(false);
    assert.notEqual(run.replace, true);
  });

  test("replace: true reaches the game", async () => {
    const run = await commitUnder(true);
    assert.equal(run.replace, true);
  });
});

describe("orchestrator — kill stops the subagent's script", () => {
  test("killing a subagent tells the game to stop its committed script", async () => {
    const f = fixture({
      actions: [{ action_type: "kill", subagent_id: SUB }],
      reasoning: "",
    });
    f.loop.start(state());
    try {
      await until(() => f.game.killed.length > 0, "the game to be told to kill the script");
      assert.deepEqual(f.game.killed, [SUB]);
      assert.equal(f.pool.has(SUB), false, "the subagent is also dropped from the pool");
    } finally {
      await f.close();
    }
  });

  test("a kill for an unknown subagent does not reach the game", async () => {
    const f = fixture({
      actions: [{ action_type: "kill" }, { action_type: "noop" }],
      reasoning: "",
    });
    f.loop.start(state());
    try {
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(f.game.killed, []);
    } finally {
      await f.close();
    }
  });
});
