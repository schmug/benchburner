/**
 * Kill doesn't cancel in-flight inference.
 *
 * Pool membership was checked when the worker dequeued an instruction and
 * never again, so this sequence committed a script under a dead id:
 * instruct → kill while inference is in flight (window = subagent
 * timeout, default 300 s) → result lands → `onResult` commits. The
 * `killScript` that ran at kill time only flagged queue entries that
 * existed then, so the late script started, held RAM, and earned to
 * run-end — invisibly, because `subagent_status` enumerates pool members
 * only.
 *
 * The same hole exists one await later: a kill that lands while
 * `submitScript` is in flight passes the `onResult` check but the script
 * is not enqueued until `runScript`, so the kill's queue-flagging misses
 * it entirely.
 *
 * These tests drive the real OrchestratorLoop and assert on what reaches
 * the game and what the delegation log records: a post-kill result must
 * commit nothing and be recorded as dropped, not silently swallowed.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";

import { Bus } from "../../harness/bus/bus";
import { InferenceRegistry, type ResolvedAdapter } from "../../harness/inference/registry";
import { OrchestratorLoop } from "../../harness/orchestrator/loop";
import { openDb, type Db } from "../../harness/storage/db";
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

const tmpRoot = mkdtempSync(path.join(tmpdir(), "benchburner-kill-in-flight-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const RUN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const MODEL = "sub-model";
const SUB = "doomed";

function state(): GameState {
  return { current_money: 1262, bitnode_id: 1, bitnode_complete: false };
}

/**
 * Records what the loop asked of the game. `gateSubmit` makes
 * submitScript hang until the test releases it, so a kill can be landed
 * deterministically inside the submit→run await gap.
 */
class SpyGame implements GameController {
  readonly runs: Array<{ script_id: string; subagent_id: string }> = [];
  readonly killed: string[] = [];
  readonly submitted: string[] = [];
  private releaseSubmit?: () => void;

  constructor(private readonly gateSubmit = false) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async readState(): Promise<GameState> {
    return state();
  }
  async submitScript(p: { script_id: string; code: string }): Promise<void> {
    this.submitted.push(p.script_id);
    if (this.gateSubmit) {
      await new Promise<void>((r) => {
        this.releaseSubmit = r;
      });
    }
  }
  /** Lets the gated submitScript return. No-op until it was called. */
  submitGateOpen(): boolean {
    if (!this.releaseSubmit) return false;
    this.releaseSubmit();
    return true;
  }
  async runScript(p: {
    script_id: string;
    subagent_id: string;
    kind?: "probe" | "committed";
    replace?: boolean;
  }): Promise<ExecutionResult> {
    this.runs.push({ script_id: p.script_id, subagent_id: p.subagent_id });
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
 * Serves one canned decision per cycle, then noops. Subclassing the real
 * registry keeps the loop on its production code path without adding a
 * test-only adapter to `models.yaml`'s union.
 */
class SequencedRegistry extends InferenceRegistry {
  private cycle = 0;
  constructor(private readonly decisions: Array<{ actions: OrchestratorAction[]; reasoning: string }>) {
    super([{ id: "orch", adapter: "null-orchestrator", endpoint: "none", context_window: 8192 }]);
  }
  override get(_modelId: string): ResolvedAdapter {
    const body = () =>
      this.decisions[this.cycle++] ?? { actions: [{ action_type: "noop" }], reasoning: "" };
    return {
      adapter: {
        name: "sequenced",
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
  db: Db;
  close(): Promise<void>;
}

function fixture(
  decisions: Array<{ actions: OrchestratorAction[]; reasoning: string }>,
  game: SpyGame,
): Fixture {
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

  const loop = new OrchestratorLoop({
    run_id: RUN_ID,
    config: cfg,
    bus,
    db,
    game,
    pool,
    registry: new SequencedRegistry(decisions),
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
    db,
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

const instructAction: OrchestratorAction = {
  action_type: "instruct",
  subagent_id: SUB,
  instruction: {
    instruction_id: "i-1",
    subagent_id: SUB,
    task: "hack something",
    context: "",
    constraints: { token_budget: 2000, max_script_size_lines: 200 },
    timestamp: new Date().toISOString(),
  },
};

const killAction: OrchestratorAction = { action_type: "kill", subagent_id: SUB };

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

function delegationResult(db: Db): Result | null {
  const row = db.raw
    .prepare("SELECT result FROM delegations WHERE instruction_id = ?")
    .get("i-1") as { result: string | null } | undefined;
  if (!row?.result) return null;
  return JSON.parse(row.result) as Result;
}

describe("orchestrator — kill while an instruction is in flight", () => {
  test("a result landing after its subagent was killed commits nothing and is logged as dropped", async () => {
    // Cycle 1 instructs, cycle 2 kills. The worker is the test itself,
    // so "inference in flight" is simply: no result published yet.
    const f = fixture(
      [
        { actions: [instructAction], reasoning: "" },
        { actions: [killAction], reasoning: "" },
      ],
      new SpyGame(),
    );
    const seen: string[] = [];
    f.bus.subscribe("instructions", (i) => seen.push(i.instruction_id));
    f.loop.start(state());
    try {
      await until(() => seen.includes("i-1"), "the instruction to be dispatched");
      await until(() => !f.pool.has(SUB), "the kill to remove the subagent from the pool");
      f.bus.publish("results", successResult());
      await until(() => delegationResult(f.db) !== null, "the result to reach the delegation log");
      // Let any wrongly-started commit surface before asserting silence.
      await new Promise((r) => setTimeout(r, 150));

      assert.deepEqual(
        f.game.submitted,
        [],
        "a dead subagent's result must not submit a script to the game",
      );
      assert.deepEqual(f.game.runs, [], "a dead subagent's result must not start a script");

      const logged = delegationResult(f.db);
      assert.equal(
        logged?.dropped_reason,
        "subagent_killed",
        "the delegation log must say the result was dropped, not swallow it",
      );
      assert.equal(logged?.status, "success", "the subagent's own outcome stays visible in the log");
    } finally {
      await f.close();
    }
  });

  test("a kill landing while submitScript is in flight stops the commit before runScript", async () => {
    // The result arrives while the subagent is still alive, so the
    // commit legitimately starts — then the kill lands inside the
    // submit→run await gap. killScript only flags queue entries that
    // exist at kill time and this script is not enqueued until
    // runScript, so without a re-check the script would start with
    // nothing left that knows how to stop it.
    const game = new SpyGame(true);
    const f = fixture(
      [
        { actions: [instructAction], reasoning: "" },
        { actions: [killAction], reasoning: "" },
      ],
      game,
    );
    const seen: string[] = [];
    f.bus.subscribe("instructions", (i) => seen.push(i.instruction_id));
    f.loop.start(state());
    try {
      await until(() => seen.includes("i-1"), "the instruction to be dispatched");
      f.bus.publish("results", successResult());
      await until(() => game.submitted.length > 0, "the commit to enter submitScript");
      await until(() => !f.pool.has(SUB), "the kill to land while submitScript hangs");
      assert.ok(game.submitGateOpen(), "test invariant: submitScript was gated");
      await new Promise((r) => setTimeout(r, 150));

      assert.deepEqual(
        f.game.runs,
        [],
        "the script must not be enqueued after its owner was killed mid-submit",
      );
    } finally {
      await f.close();
    }
  });
});
