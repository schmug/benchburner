/**
 * A subagent's agentic loop is write-run-observe: on each turn it emits
 * `{decision, code, notes}`, the harness runs the code, and the result
 * feeds the next turn. `notes` is the subagent's reasoning at that
 * moment — why it wrote what it wrote, what it thinks went wrong.
 *
 * Only the LAST turn's notes survived, as `Result.reasoning`
 * (`worker.ts` keeps `lastNotes` and overwrites it each turn). Every
 * intermediate thought was dropped, so a 3-iteration instruction showed
 * its conclusion and none of the reasoning that produced it — precisely
 * the part worth watching while an expensive model works.
 *
 * The scripted adapter emits RUN / RUN / DONE with distinct notes, so a
 * full loop against the mock game exercises all three turns.
 */

import { strict as assert } from "node:assert";
import test, { describe } from "node:test";

import { Bus } from "../../harness/bus/bus";
import { MockGame } from "../../harness/game/mock";
import { InferenceRegistry } from "../../harness/inference/registry";
import { SubagentPool } from "../../harness/subagent/pool";
import { SubagentWorker } from "../../harness/subagent/worker";
import type { Instruction, Result } from "../../harness/types";

const MODEL = "test-scripted";

function instruction(): Instruction {
  return {
    instruction_id: "i-1",
    subagent_id: "worker1",
    task: "Write a script that earns money.",
    context: "",
    constraints: { token_budget: 2000, max_script_size_lines: 200 },
    timestamp: new Date().toISOString(),
  };
}

/** Drives one instruction end to end and returns the published Result. */
async function runOneInstruction(): Promise<Result> {
  const bus = new Bus();
  const pool = new SubagentPool();
  const game = new MockGame({ seed: 1 });
  await game.start();

  pool.spawn("worker1", MODEL, new Date().toISOString());

  const worker = new SubagentWorker({
    bus,
    registry: new InferenceRegistry([
      {
        id: MODEL,
        adapter: "test-scripted",
        endpoint: "none",
        context_window: 8192,
      },
    ]),
    pool,
    limits: {
      max_concurrent: 2,
      token_budget_per_instruction: 2000,
      timeout_seconds: 30,
    },
    game,
  });

  const settled = new Promise<Result>((resolve) => {
    bus.subscribe("results", resolve);
  });

  worker.start();
  bus.publish("instructions", instruction());

  const result = await settled;
  await worker.stop();
  await game.stop();
  return result;
}

describe("subagent — per-iteration thoughts", () => {
  test("keeps each iteration's notes, not just the final one", async () => {
    const r = await runOneInstruction();

    assert.equal(r.status, "success");
    assert.ok(r.iteration_summaries, "no iteration summaries at all");
    assert.equal(r.iteration_summaries.length, 2, "two RUN turns before DONE");

    assert.equal(
      r.iteration_summaries[0].notes,
      "first probe",
      "iteration 1's reasoning was dropped",
    );
    assert.equal(
      r.iteration_summaries[1].notes,
      "second probe",
      "iteration 2's reasoning was dropped",
    );
  });

  test("still reports the committed reasoning and the execution outcome", async () => {
    const r = await runOneInstruction();

    // The DONE turn's notes remain the headline reasoning.
    assert.equal(r.reasoning, "committed");
    assert.equal(r.iterations, 3, "two RUN turns plus the DONE turn");

    // Per-iteration execution facts are unchanged. `exit_reason` is
    // optional on ExecutionResult and MockGame does not set it, so this
    // asserts the shape the contract guarantees rather than the mock's.
    r.iteration_summaries?.forEach((it, idx) => {
      assert.equal(it.iteration, idx + 1, "iterations are 1-indexed and in order");
      assert.equal(typeof it.money_gained, "number");
    });
  });
});
